const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { nativeImage, shell } = require('electron');
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
// Native-input coverage of xterm's real OSC 8 provider and the desktop IPC path.
async function checkTerminalLinks({ win, createCard, openedLinks }) {
    const linkCard = createCard({ title: 'Hyperlink smoke terminal', x: 0, y: 0 });
    try {
        await win.webContents.executeJavaScript(`
            loadWorkspace(${JSON.stringify({ version: 1, name: 'Hyperlink smoke workspace', camera: { x: 20, y: 20, z: 1 }, cards: [linkCard] })});
            setStatus(workspace.cards[0], 'exited');
            window.__originalConfirm = window.confirm;
            window.__linkConfirmations = 0;
            window.confirm = () => { window.__linkConfirmations++; return false; };
            new Promise(resolve => sessions.get(workspace.cards[0].id).terminal.write(
                ${JSON.stringify('\x1b]8;;https://github.com/yutigi/TerminalCanvas\x07GitHub\x1b]8;;\x07\r\n\x1b]8;;file:///C:/Windows/notepad.exe\x07Unsafe\x1b]8;;\x07')},
                () => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        `);
        const points = await win.webContents.executeJavaScript(`(() => {
            const terminal = sessions.get(workspace.cards[0].id).terminal;
            const rect = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
            return [0, 1].map(row => ({ x: Math.round(rect.left + rect.width / terminal.cols * 2.5),
                y: Math.round(rect.top + rect.height / terminal.rows * (row + .5)) }));
        })()`);
        assert.deepEqual(openedLinks, [], 'terminal output must never open links automatically');
        for (const [index, point] of points.entries()) {
            win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(openedLinks.length, index, 'hover must never open a link');
            win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
            await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 150))');
            assert.equal(await win.webContents.executeJavaScript('window.__linkConfirmations'), 0, 'links must not show a confirmation prompt');
            assert.deepEqual(openedLinks, ['https://github.com/yutigi/TerminalCanvas'],
                index === 0 ? 'a GitHub click reaches the system browser' : 'an unsafe scheme never reaches the system browser');
        }
        const screenshot = path.resolve(__dirname, '../.cache/smoke-links.png');
        await fs.mkdir(path.dirname(screenshot), { recursive: true });
        await fs.writeFile(screenshot, (await captureScreenshot(win)).toPNG());
    } finally {
        await win.webContents.executeJavaScript('window.confirm = window.__originalConfirm; delete window.__originalConfirm; delete window.__linkConfirmations;');
    }
}
exports.checkTerminalLinks = checkTerminalLinks;
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
    // Intercept only the OS launch so routine smoke runs do not spawn a browser.
    const openExternal = shell.openExternal;
    const openedLinks = [];
    shell.openExternal = async url => { openedLinks.push(url); };
    try { await checkTerminalLinks({ win, createCard, openedLinks }); }
    finally { shell.openExternal = openExternal; }
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
    win.webContents.sendInputEvent({ type: 'mouseDown', x: overview.x, y: overview.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: overview.x - 20, y: overview.y - 10 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: overview.x - 20, y: overview.y - 10, button: 'left', clickCount: 1 });
    // A renderer round trip flushes the preceding native input events.
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
            win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
            assert.equal(await win.webContents.executeJavaScript(`document.activeElement === sessions.get(workspace.cards[${index}].id).terminal.textarea`), true,
                'one click must focus the terminal input');
            const before = inputs.length;
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K' });
            win.webContents.sendInputEvent({ type: 'char', keyCode: 'k' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K' });
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
        version: 2, name: 'Board smoke workspace', camera: { x: 40, y: 60, z: .6 }, cards: [boardCard],
        items: [
            { id: 'frame', type: 'frame', x: -40, y: -40, w: 1020, h: 560, title: 'Sprint board' },
            { id: 'label', type: 'text', x: 0, y: 0, w: 300, h: 40, text: 'Release plan' },
            { id: 'note', type: 'note', x: 0, y: 80, w: 200, h: 200, text: 'Write the\nrelease notes' },
            { id: 'box', type: 'shape', shape: 'rect', x: 380, y: 80, w: 180, h: 110, text: 'Review' },
            { id: 'ring', type: 'shape', shape: 'ellipse', x: 700, y: 80, w: 150, h: 150, text: 'Ship' },
            { id: 'pic', type: 'image', x: 380, y: 300, w: 192, h: 144, asset },
            { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'box' }, arrow: true },
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
    const toScreen = `const toScreen = p => { const r = viewport.getBoundingClientRect(), c = workspace.camera; return { x: Math.round(r.left + c.x + p.x * c.z), y: Math.round(r.top + c.y + p.y * c.z) }; };`;
    const wirePoint = await win.webContents.executeJavaScript(`(() => { ${toScreen}
        const { start, end } = linePoints(findItem('wire'));
        const point = toScreen({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        return { ...point, hit: document.elementFromPoint(point.x, point.y)?.getAttribute('class') };
    })()`);
    assert.equal(wirePoint.hit, 'line-hit', 'connector strokes outside the 1px SVG box must receive pointer events');
    win.webContents.sendInputEvent({ type: 'mouseDown', x: wirePoint.x, y: wirePoint.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: wirePoint.x, y: wirePoint.y, button: 'left', clickCount: 1 });
    assert.deepEqual(await win.webContents.executeJavaScript('[...selection]'), ['wire']);
    const empty = await win.webContents.executeJavaScript(`(() => { ${toScreen} setTool('note'); return toScreen({ x: 160, y: 700 }); })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...empty, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...empty, button: 'left', clickCount: 1 });
    assert.equal(await win.webContents.executeJavaScript('document.activeElement?.className'), 'item-editor', 'a new sticky note opens for typing');
    for (const key of ['O', 'k']) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        win.webContents.sendInputEvent({ type: 'char', keyCode: key });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    }
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    const created = await win.webContents.executeJavaScript('({ item: workspace.items.at(-1), editing, tool: activeTool })');
    assert.deepEqual({ type: created.item.type, text: created.item.text, editing: created.editing, tool: created.tool }, { type: 'note', text: 'Ok', editing: null, tool: 'select' },
        'typing reaches the note editor without triggering tool shortcuts');
    await win.webContents.executeJavaScript('select("box"); select("ring", { additive: true })');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'G', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'G', modifiers: ['control'] });
    const grouped = await win.webContents.executeJavaScript('({ box: findItem("box").group, ring: findItem("ring").group, box2: !document.querySelector("#selection-box").hidden })');
    assert.ok(grouped.box && grouped.box === grouped.ring && grouped.box2, 'Ctrl+G groups the selection');
    // Everything the renderer builds must pass the desktop host's validation, or autosave would fail.
    const saved = validateWorkspace(await win.webContents.executeJavaScript('JSON.parse(JSON.stringify(workspace))'));
    assert.equal(saved.items.length, board.items.length + 1);
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
        console.log(`Desktop smoke passed: renderer, hyperlink clicks without confirmation, minimap navigation, first-click typing, board items, focus, isolated preload, PTY output, resize, cleanup. Screenshot: ${screenshot}`);
    } finally { terminals.emit = originalEmit; terminals.stopAll(); }
    app.quit();
};
