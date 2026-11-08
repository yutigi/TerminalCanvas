const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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
exports.run = async ({ app, win, terminals, createCard }) => {
    const errors = [];
    win.webContents.on('console-message', (_event, _level, message) => { if (/Uncaught|TypeError|ReferenceError/.test(message || '')) errors.push(message); });
    const deadline = Date.now() + 15000;
    while (!await win.webContents.executeJavaScript('Boolean(document.querySelector(".profile-button"))')) {
        if (Date.now() > deadline) throw new Error('Renderer did not initialize.');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await win.webContents.executeJavaScript('typeof window.Terminal'), 'function');
    assert.equal(await win.webContents.executeJavaScript('typeof window.require'), 'undefined');
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
        console.log(`Desktop smoke passed: renderer, minimap navigation, focus, isolated preload, PTY output, resize, cleanup. Screenshot: ${screenshot}`);
    } finally { terminals.emit = originalEmit; terminals.stopAll(); }
    app.quit();
};
