const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, key, screenshot, root, psQuote, hasOutputLine } = require('./harness.cjs');
const { startTerminal, input } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };

test('native background canvases retain processes, backpressure, output, cwd and viewport; deletion stops only their processes', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const first = await startTerminal(h.page, { title: 'Background output', cwd: root });
    const firstCanvas = await h.page.evaluate(() => {
        workspace.camera = { x: 83, y: -51, z: .8 }; select(workspace.cards[0].id);
        globalThis.originalTerminal = sessions.get(workspace.cards[0].id).terminal;
        return activeCanvas.id;
    });
    const pid = (await h.state()).host.terminals.find(card => card.id === first.id).pid;
    await key(h.page, 'Control+Shift+k');
    const secondCanvas = await h.page.evaluate(() => activeCanvas.id);
    assert.notEqual(firstCanvas, secondCanvas);
    const second = await startTerminal(h.page, { title: 'Foreground shell', cwd: root });
    await until(async () => (await h.state()).host.terminals.every(card => card.cwd), 'Shell folders did not become available.');
    // More than the 256,000-unit high-water mark; fewer than 5,000 visual lines of scrollback.
    await input(h.page, first.id, `Set-Location -LiteralPath ${psQuote(root + '\\src')}; for ($i=0; $i -lt 600; $i++) { [Console]::WriteLine(('BG{0:D4}:' -f $i) + ('x' * 480)) }; [Console]::WriteLine('BACKGROUND_OUTPUT_COMPLETE')\r`);
    try {
        await until(async () => hasOutputLine(await h.output(first.id), 'BACKGROUND_OUTPUT_COMPLETE'), 'Hidden output stalled under backpressure.', 30000);
    } catch (error) {
        t.diagnostic(JSON.stringify((await h.state()).host.terminals));
        t.diagnostic((await h.output(first.id)).slice(-2500));
        throw error;
    }
    await until(async () => (await h.state()).host.terminals.find(card => card.id === first.id).cwd?.endsWith('src'), 'Hidden cwd polling stopped.');
    await until(async () => await h.page.evaluate(id => sessions.get(id).terminal._core._renderService._isPaused, first.id), 'Hidden xterm painting did not pause.');
    const state = await h.state();
    assert.equal(state.host.running, 2);
    assert.equal(state.host.terminals.find(card => card.id === first.id).pid, pid);
    assert.match(await h.page.locator('#canvas-list').textContent(), /New output/);
    assert.equal(await h.page.locator('#canvas-activity').isVisible(), true);
    await screenshot(h.page, 'multiple-canvases-activity');
    await h.page.evaluate(() => { workspace.camera = { x: -17, y: 25, z: 1.2 }; });
    await h.page.selectOption('#canvas-list', firstCanvas);
    assert.deepEqual(await h.page.evaluate(() => workspace.camera), { x: 83, y: -51, z: .8 });
    assert.equal(await h.page.evaluate(() => sessions.get(workspace.cards[0].id).terminal === originalTerminal), true);
    const output = await h.page.evaluate(id => {
        const buffer = sessions.get(id).terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, line) => buffer.getLine(line)?.translateToString(true) || '').join('\n');
    }, first.id);
    const compact = output.replace(/\n/g, '');
    for (let index = 0; index < 600; index++) assert.ok(compact.includes(`BG${String(index).padStart(4, '0')}:` + 'x'.repeat(480)), `Missing background line ${index}`);
    assert.ok(output.includes('BACKGROUND_OUTPUT_COMPLETE'));
    await until(async () => !await h.page.evaluate(id => sessions.get(id).terminal._core._renderService._isPaused, first.id), 'Shown xterm did not resume painting.');
    await screenshot(h.page, 'multiple-canvases');
    await h.page.locator('#canvas-delete').click();
    assert.match(await h.page.locator('#confirm-description').textContent(), /1 running terminal/);
    await h.page.locator('#confirm-cancel').click();
    assert.equal((await h.state()).host.running, 2);
    await h.page.locator('#canvas-delete').click(); await h.page.locator('#confirm-ok').click();
    await until(async () => (await h.state()).host.running === 1, 'Deleting a live canvas did not stop its process.');
    assert.equal(await h.page.evaluate(() => activeCanvas.id), secondCanvas);
    assert.deepEqual(await h.page.evaluate(() => workspace.camera), { x: -17, y: 25, z: 1.2 });
    assert.equal((await h.state()).host.terminals.find(card => card.id === second.id).running, true);
    assert.equal(await h.page.evaluate(() => sessions.size), 1);
});

test('native recovery restores every canvas, last active canvas, order, items and focus with stopped terminals', windows, async () => {
    const h = await launch({ clean: true });
    let saved;
    try {
        const first = await startTerminal(h.page, { title: 'Remembered first', cwd: root });
        await h.page.evaluate(id => {
            workspace.camera = { x: 11, y: 22, z: .65 }; setFocus(id);
            createCanvas('Project two');
            addItem(makeItem('note', { x: 50, y: 60, w: 200, h: 200 }));
            workspace.items[0].text = 'Persist every canvas';
            workspace.camera = { x: -90, y: 70, z: 1.25 }; reorderCanvas(-1);
        }, first.id);
        await startTerminal(h.page, { title: 'Remembered second', cwd: root });
        saved = await h.page.evaluate(async () => { await invoke('autosave', workspace); return workspaceSnapshot(); });
    } finally { await h.dispose(); }
    const reopened = await launch();
    try {
        const restored = await reopened.page.evaluate(() => workspaceSnapshot());
        assert.deepEqual(restored, saved);
        assert.equal((await reopened.state()).host.running, 0);
        assert.equal(await reopened.page.evaluate(() => sessions.size), 2);
        await reopened.page.selectOption('#canvas-list', saved.canvases[1].id);
        assert.equal(await reopened.page.evaluate(() => focused), saved.canvases[1].focused);
        assert.deepEqual(await reopened.page.evaluate(() => workspace.camera), saved.canvases[1].camera);
        assert.equal(await reopened.page.locator('#sidebar').isVisible(), false, 'Restoring a focused canvas also restores its automatic sidebar hiding.');
    } finally { await reopened.dispose(); }
});
