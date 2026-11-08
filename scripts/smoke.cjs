const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage, clipboard, ClipboardItem } = require('electron');
const { storeImage } = require('../src/assets.cjs');
const { validateWorkspace } = require('../src/workspace.cjs');
function hasOutputLine(output, expected) {
    const clean = output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[\d;]*[Hf]/g, '\n')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    return clean.split(/\r?\n/).some(line => line.trim() === expected);
}
exports.hasOutputLine = hasOutputLine;
async function captureScreenshot(win) {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const image = await win.webContents.capturePage();
            assert.ok(!image.isEmpty(), 'Smoke screenshot must not be empty.');
            return image;
        } catch (error) {
            if (error.message !== 'UnknownVizError') throw error;
            if (attempt === attempts) {
                throw new Error(`Smoke screenshot capture failed after ${attempts} attempts: ${error.message}`, { cause: error });
            }
            // A compositor surface copy can fail transiently even after renderer IPC succeeds.
            // Request another painted frame before retrying; never skip screenshot validation.
            win.webContents.invalidate();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}
exports.captureScreenshot = captureScreenshot;
// Native input and executeJavaScript travel on separate channels, so a script can run before earlier
// input reaches the page. Wait until the renderer has dispatched the last event, and its handlers ran.
// Pointer events stand in for mouse buttons because a canceled pointerdown suppresses mousedown/mouseup.
const DOM_EVENTS = Object.freeze({ mouseDown: 'pointerdown', mouseUp: 'pointerup', keyDown: 'keydown', keyUp: 'keyup' });
function inputWaiter(events) {
    const last = events.at(-1);
    const type = DOM_EVENTS[last.type];
    if (!type) throw new Error(`Native input must end with one of: ${Object.keys(DOM_EVENTS).join(', ')}.`);
    const count = events.filter(event => event.type === last.type).length;
    const point = 'x' in last ? { x: last.x, y: last.y } : null;
    return `window.__smokeInput = new Promise((resolve, reject) => {
        const point = ${JSON.stringify(point)};
        let seen = 0;
        const done = () => { window.removeEventListener(${JSON.stringify(type)}, listener, true); clearTimeout(timer); };
        const listener = event => {
            // Ignore stray pointer input, such as the real mouse moving over the smoke window.
            if (point && (Math.abs(event.clientX - point.x) > 1 || Math.abs(event.clientY - point.y) > 1)) return;
            if (++seen === ${count}) { done(); setTimeout(resolve, 0); }
        };
        const timer = setTimeout(() => { done(); reject(new Error('Native ${type} did not reach the renderer.')); }, 5000);
        window.addEventListener(${JSON.stringify(type)}, listener, true);
    }); undefined`;
}
// Native keys reach the focused element only while the page has focus, and another window (or the person
// using the machine) can take it mid-run. Take it back before each batch of input.
async function ensureFocus(win, attempts = 20) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        if (await win.webContents.executeJavaScript('document.hasFocus()')) return;
        win.focus(); win.webContents.focus();
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The smoke window could not take focus for native input.');
}
exports.ensureFocus = ensureFocus;
async function sendInput(win, events) {
    await ensureFocus(win);
    await win.webContents.executeJavaScript(inputWaiter(events));
    for (const event of events) win.webContents.sendInputEvent(event);
    await win.webContents.executeJavaScript('window.__smokeInput');
}
const click = (point, modifiers = []) => [
    { type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers },
    { type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers }
];
const key = (keyCode, modifiers = [], char = false) => [
    { type: 'keyDown', keyCode, modifiers }, ...(char ? [{ type: 'char', keyCode, modifiers }] : []), { type: 'keyUp', keyCode, modifiers }
];
exports.inputWaiter = inputWaiter;
// Clipboard checks use the real system clipboard, so they put back whatever the user had copied.
// Every format is read before the task runs, because clipboard items read their data lazily.
async function withSavedClipboard(task) {
    // An empty clipboard can still report an item with no formats; there is nothing to restore from it.
    const saved = (await Promise.all((await clipboard.read()).map(async item =>
        Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))))
        .filter(data => Object.keys(data).length);
    try { return await task(); } finally {
        try {
            if (saved.length) await clipboard.write(saved.map(data => new ClipboardItem(data)));
            else clipboard.clear();
        } catch (error) { console.warn(`Could not restore the clipboard: ${error.message}`); }
    }
}
const clipboardText = async () => (await clipboard.readText()).replace(/\r\n/g, '\n');
// Ctrl+C writes the copied note's text to the system clipboard; Ctrl+V on the non-editable canvas then
// arrives as a paste event and pastes a copy with a new ID.
async function copyAndPasteNatively(win) {
    const expected = 'Write the\nrelease notes';
    await withSavedClipboard(async () => {
        await win.webContents.executeJavaScript('select("note"); viewport.focus()');
        await sendInput(win, key('C', ['control']));
        const deadline = Date.now() + 2000;
        while (await clipboardText() !== expected) {
            if (Date.now() > deadline) throw new Error('Ctrl+C did not write the copied items to the clipboard.');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const count = await win.webContents.executeJavaScript('workspace.items.length');
        await sendInput(win, key('V', ['control']));
        const pasted = await win.webContents.executeJavaScript('({ count: workspace.items.length, item: workspace.items.at(-1), selected: [...selection] })');
        assert.equal(pasted.count, count + 1, 'Ctrl+V pastes the copied note');
        assert.equal(pasted.item.text, expected);
        assert.notEqual(pasted.item.id, 'note');
        assert.deepEqual(pasted.selected, [pasted.item.id]);
    });
}
// Terminal copy and paste go through these desktop commands.
async function checkClipboardBridge(win) {
    const marker = `terminal-canvas-clipboard-${Date.now()}\nsecond line`;
    await withSavedClipboard(async () => {
        await win.webContents.executeJavaScript(`invoke('clipboard-write', ${JSON.stringify(marker)})`);
        assert.equal(await clipboardText(), marker, 'clipboard-write reaches the system clipboard');
        const read = await win.webContents.executeJavaScript("invoke('clipboard-read').then(result => result.text)");
        assert.equal(read.replace(/\r\n/g, '\n'), marker, 'clipboard-read returns the clipboard text');
    });
}
exports.run = async ({ app, win, terminals, createCard }) => {
    const errors = [];
    win.webContents.on('console-message', (_event, _level, message) => { if (/Uncaught|TypeError|ReferenceError|Content Security Policy/.test(message || '')) errors.push(message); });
    const deadline = Date.now() + 15000;
    while (!await win.webContents.executeJavaScript('Boolean(document.querySelector(".profile-button"))')) {
        if (Date.now() > deadline) throw new Error('Renderer did not initialize.');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await win.webContents.executeJavaScript('typeof window.Terminal'), 'function');
    assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined');
    await checkClipboardBridge(win);
    const overviewCards = ['shell', 'claude', 'codex', 'gemini'].map((profile, index) => createCard({
        profile, title: ['Project shell', 'Backend agent', 'Frontend agent', 'Review agent'][index],
        x: index % 2 * 700, y: Math.floor(index / 2) * 470
    }));
    await win.webContents.executeJavaScript(`loadWorkspace(${JSON.stringify({ version: 1, name: 'Minimap smoke workspace', camera: { x: 50, y: 40, z: .65 }, cards: overviewCards })}); select(workspace.cards[0].id);`);
    const overview = await win.webContents.executeJavaScript(`(() => {
        const map = document.querySelector('#minimap-map').getBoundingClientRect();
        const toolbar = document.querySelector('.canvas-toolbar').getBoundingClientRect();
        const panel = document.querySelector('#minimap').getBoundingClientRect();
        return { hidden: document.querySelector('#minimap').hidden, cards: document.querySelectorAll('.minimap-card').length,
            overlap: panel.left < toolbar.right && panel.right > toolbar.left && panel.top < toolbar.bottom && panel.bottom > toolbar.top,
            x: Math.round(map.left + 175), y: Math.round(map.top + 60), cameraX: workspace.camera.x };
    })()`);
    assert.equal(overview.hidden, false);
    assert.equal(overview.cards, 4);
    assert.equal(overview.overlap, false, 'minimap must not cover canvas tools');
    await sendInput(win, [
        { type: 'mouseDown', x: overview.x, y: overview.y, button: 'left', clickCount: 1 },
        { type: 'mouseMove', x: overview.x - 20, y: overview.y - 10 },
        { type: 'mouseUp', x: overview.x - 20, y: overview.y - 10, button: 'left', clickCount: 1 }
    ]);
    const navigation = await win.webContents.executeJavaScript('({ x: workspace.camera.x, z: workspace.camera.z, dragging: !!minimapDrag })');
    assert.notEqual(navigation.x, overview.cameraX);
    assert.equal(navigation.z, .65);
    assert.equal(navigation.dragging, false);
    await win.webContents.executeJavaScript('setFocus(workspace.cards[0].id)');
    assert.equal(await win.webContents.executeJavaScript('document.querySelector("#minimap").hidden'), true);
    await win.webContents.executeJavaScript('setFocus(null); fitCanvas()');
    // Use native clicks: synthetic dispatchEvent does not run the browser's focus defaults.
    const inputCards = [0, 1].map(index => createCard({ title: `Input terminal ${index + 1}`, x: index * 700, y: 0 }));
    await win.webContents.executeJavaScript(`loadWorkspace(${JSON.stringify({ version: 1, name: 'Input smoke workspace', camera: { x: 20, y: 20, z: .65 }, cards: inputCards })});
        (async () => { for (const card of workspace.cards) await start(card); select(workspace.cards[1].id); })()`);
    const originalWrite = terminals.write;
    const inputs = [];
    terminals.write = function (id, data) { inputs.push({ id, data }); return originalWrite.call(this, id, data); };
    try {
        for (const index of [0, 0, 1, 0]) {
            await win.webContents.executeJavaScript('document.querySelector("#search").focus()');
            const point = await win.webContents.executeJavaScript(`(() => {
                const rect = sessions.get(workspace.cards[${index}].id).element.querySelector('.xterm-screen').getBoundingClientRect();
                return { x: Math.round(rect.left + 30), y: Math.round(rect.top + 30) };
            })()`);
            await sendInput(win, click(point));
            assert.equal(await win.webContents.executeJavaScript(`document.activeElement === sessions.get(workspace.cards[${index}].id).terminal.textarea`), true,
                'one click must focus the terminal input');
            const before = inputs.length;
            await sendInput(win, [{ type: 'keyDown', keyCode: 'K' }, { type: 'char', keyCode: 'k' }, { type: 'keyUp', keyCode: 'K' }]);
            const inputDeadline = Date.now() + 2000;
            while (!inputs.slice(before).some(input => input.id === inputCards[index].id && input.data === 'k')) {
                if (Date.now() > inputDeadline) throw new Error('First-click keyboard input did not reach the selected PTY.');
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        const inputScreenshot = path.resolve(__dirname, '../.cache/smoke-first-click.png');
        await fs.mkdir(path.dirname(inputScreenshot), { recursive: true });
        await fs.writeFile(inputScreenshot, (await captureScreenshot(win)).toPNG());
    } finally { terminals.write = originalWrite; terminals.stopAll(); }
    // Board items: real image loading through tc-asset:, connector hit testing, native creation/typing, and grouping.
    const bitmap = Buffer.alloc(64 * 48 * 4);
    for (let i = 0; i < bitmap.length; i += 4) bitmap.set([0x7a + (i % 97), 0xb5, 0x9a, 0xff], i);
    const asset = await storeImage(path.join(app.getPath('userData'), 'assets'), nativeImage.createFromBitmap(bitmap, { width: 64, height: 48 }).toPNG());
    const boardCard = createCard({ title: 'Board terminal', x: 1100, y: 0 });
    const board = {
        version: 3, name: 'Board smoke workspace', camera: { x: 40, y: 60, z: .6 }, cards: [boardCard],
        items: [
            { id: 'frame', type: 'frame', x: -40, y: -40, w: 1020, h: 560, title: 'Sprint board' },
            { id: 'label', type: 'text', x: 0, y: 0, w: 300, h: 50, text: 'Release plan', fontSize: 'large' },
            { id: 'note', type: 'note', x: 0, y: 80, w: 200, h: 200, text: 'Write the\nrelease notes', color: 'green' },
            { id: 'box', type: 'shape', shape: 'rect', x: 380, y: 80, w: 180, h: 110, text: 'Review' },
            { id: 'ring', type: 'shape', shape: 'ellipse', x: 700, y: 80, w: 150, h: 150, text: 'Ship', color: 'purple' },
            { id: 'pic', type: 'image', x: 380, y: 300, w: 192, h: 144, asset },
            { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'box' }, arrow: true, color: 'blue' },
            { id: 'to-terminal', type: 'line', start: { id: 'ring' }, end: { id: boardCard.id }, arrow: true }
        ]
    };
    await win.webContents.executeJavaScript(`loadWorkspace(${JSON.stringify(board)})`);
    const imageDeadline = Date.now() + 5000;
    while (!await win.webContents.executeJavaScript('(() => { const img = document.querySelector(".item-image img"); return img.complete && img.naturalWidth > 0; })()')) {
        if (await win.webContents.executeJavaScript('document.querySelector(".item-image").classList.contains("missing")')) throw new Error('Board image failed to load through tc-asset:.');
        if (Date.now() > imageDeadline) throw new Error('Board image did not load.');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    // Image cleanup deletes stored images the board no longer uses, through the desktop commands.
    // The smoke profile has its own assets folder, so this never touches the user's images.
    const assets = path.join(app.getPath('userData'), 'assets');
    const orphan = await storeImage(assets, nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 0x7f), { width: 8, height: 8 }).toPNG());
    const cleanup = await win.webContents.executeJavaScript(`(async () => {
        const found = await invoke('unused-images', { keep: referencedImages() });
        return { found, result: await invoke('delete-unused-images', { keep: referencedImages() }) };
    })()`);
    assert.ok(cleanup.found.count >= 1 && cleanup.result.deleted === cleanup.found.count, 'unused images are found and deleted');
    assert.deepEqual(await fs.readdir(assets), [asset], 'only the image on the board remains');
    assert.notEqual(orphan, asset);
    const toScreen = `const toScreen = p => { const r = viewport.getBoundingClientRect(), c = workspace.camera; return { x: Math.round(r.left + c.x + p.x * c.z), y: Math.round(r.top + c.y + p.y * c.z) }; };`;
    const wirePoint = await win.webContents.executeJavaScript(`(() => { ${toScreen}
        const { start, end } = linePoints(findItem('wire'));
        const point = toScreen({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        return { ...point, hit: document.elementFromPoint(point.x, point.y)?.getAttribute('class') };
    })()`);
    assert.equal(wirePoint.hit, 'line-hit', 'connector strokes outside the 1px SVG box must receive pointer events');
    await sendInput(win, click(wirePoint));
    assert.deepEqual(await win.webContents.executeJavaScript('[...selection]'), ['wire']);
    const empty = await win.webContents.executeJavaScript(`(() => { ${toScreen} setTool('note'); return toScreen({ x: 160, y: 700 }); })()`);
    await sendInput(win, click(empty));
    assert.equal(await win.webContents.executeJavaScript('document.activeElement?.className'), 'item-editor', 'a new sticky note opens for typing');
    await sendInput(win, [...key('O', [], true), ...key('k', [], true), ...key('Escape')]);
    const created = await win.webContents.executeJavaScript('({ item: workspace.items.at(-1), editing, tool: activeTool })');
    assert.deepEqual({ type: created.item.type, text: created.item.text, editing: created.editing, tool: created.tool }, { type: 'note', text: 'Ok', editing: null, tool: 'select' },
        'typing reaches the note editor without triggering tool shortcuts');
    await win.webContents.executeJavaScript('select("box"); select("ring", { additive: true })');
    await sendInput(win, key('G', ['control']));
    const grouped = await win.webContents.executeJavaScript('({ box: findItem("box").groups?.[0], ring: findItem("ring").groups?.[0], box2: !document.querySelector("#selection-box").hidden })');
    assert.ok(grouped.box && grouped.box === grouped.ring && grouped.box2, 'Ctrl+G groups the selection');
    await sendInput(win, key('Z', ['control']));
    assert.equal(await win.webContents.executeJavaScript('findItem("box").groups ?? null'), null, 'Ctrl+Z undoes the grouping');
    await sendInput(win, key('Z', ['control', 'shift']));
    assert.deepEqual(await win.webContents.executeJavaScript('findItem("box").groups'), [grouped.box], 'Ctrl+Shift+Z redoes it');
    await copyAndPasteNatively(win);
    // Everything the renderer builds must pass the desktop host's validation, or autosave would fail.
    const saved = validateWorkspace(await win.webContents.executeJavaScript('JSON.parse(JSON.stringify(workspace))'));
    assert.equal(saved.items.length, board.items.length + 2);
    const boardScreenshot = path.resolve(__dirname, '../.cache/smoke-board.png');
    await win.webContents.executeJavaScript('setSelection([]); fitCanvas()');
    await fs.writeFile(boardScreenshot, (await captureScreenshot(win)).toPNG());
    assert.deepEqual(errors, []);
    await win.webContents.executeJavaScript('loadWorkspace({ version: 1, name: "Minimap smoke workspace", camera: { x: 50, y: 40, z: .65 }, cards: ' + JSON.stringify(overviewCards) + ' }); fitCanvas()');
    const card = createCard({ title: 'Smoke terminal', cwd: app.getPath('home') });
    const marker = `terminal-canvas-${Date.now()}`;
    const originalEmit = terminals.emit;
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('PTY did not return command output.')), 10000);
            let output = '';
            terminals.emit = event => {
                if (event.type === 'data' && event.id === card.id) {
                    output += event.data;
                    terminals.acknowledge(card.id, event.data.length);
                    if (hasOutputLine(output, marker)) { clearTimeout(timeout); resolve(); }
                }
            };
            try {
                terminals.start(card, 80, 24);
                terminals.write(card.id, `echo ${marker}\r`);
            } catch (error) { clearTimeout(timeout); reject(error); }
        });
        terminals.resize(card.id, 100, 30);
        terminals.stop(card.id);
        assert.equal(terminals.sessions.size, 0);
        assert.deepEqual(errors, []);
        const screenshot = path.resolve(__dirname, '../.cache/smoke.png');
        await fs.mkdir(path.dirname(screenshot), { recursive: true });
        await fs.writeFile(screenshot, (await captureScreenshot(win)).toPNG());
        console.log(`Desktop smoke passed: renderer, minimap navigation, first-click typing, board items, focus, isolated preload, PTY output, resize, cleanup. Screenshot: ${screenshot}`);
    } finally { terminals.emit = originalEmit; terminals.stopAll(); }
    app.quit();
};
