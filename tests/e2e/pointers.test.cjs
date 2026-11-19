const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch, until, hasOutputLine, screenshot, root } = require('./harness.cjs');
const { input, startTerminal } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };

async function configure(page, source, target, id, hook) {
    await page.evaluate(async ({ source, target, id, hook }) => {
        const line = { id, type: 'line', arrow: true, start: { id: source.id }, end: { id: target.id } };
        workspace.items.push(line); mountLine(line);
        await savePointerChange(line, { armed: true, filter: 'any', name: '', context: false, ...hook });
    }, { source, target, id, hook });
}
async function idle(h, card) {
    await until(async () => !(await h.page.evaluate(card => invoke('duplicate-directory', card), card)).warning, 'Shell did not become idle.');
}

test('native explicit triggers form a three-shell chain, show VFX, and open a new terminal from a template', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const a = await startTerminal(h.page, { title: 'Source', cwd: root, x: 0, y: 0 });
    const b = await startTerminal(h.page, { title: 'Build', cwd: root, x: 720, y: 0 });
    const c = await startTerminal(h.page, { title: 'Tests', cwd: root, x: 1440, y: 0 });
    for (const card of [a, b, c]) await idle(h, card);
    await configure(h.page, a, b, 'build-hook', { event: 'trigger', name: 'build', action: 'shell', text: '& $env:TC_HOOK trigger tests' });
    await configure(h.page, b, c, 'test-hook', { event: 'trigger', name: 'tests', action: 'shell', text: 'Write-Output POINTER_CHAIN_OK' });
    await h.page.evaluate(() => fitCanvas());
    await input(h.page, a.id, '& $env:TC_HOOK trigger build\r');
    await until(async () => hasOutputLine(await h.output(c.id), 'POINTER_CHAIN_OK'), 'Three-step shell chain failed.');
    assert.equal(await h.page.evaluate(() => pointerStates.get('test-hook').state), 'firing');
    assert.equal(await h.page.locator('[data-id="test-hook"] .pointer-pulse').getAttribute('pathLength'), '1');
    await screenshot(h.page, 'hook-pointer-chain');
    await h.page.evaluate(() => select('build-hook', { type: false }));
    await h.page.locator('#pointer-configure').click();
    assert.equal(await h.page.locator('#pointer-action').inputValue(), 'shell');
    await screenshot(h.page, 'hook-pointer-settings');
    await h.page.locator('#pointer-dialog [data-close]').last().click();
    await h.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await h.page.locator('[data-id="test-hook"] .pointer-pulse').evaluate(el => getComputedStyle(el).display), 'none');
    await configure(h.page, a, c, 'new-hook', { event: 'trigger', name: 'new', action: 'new-terminal', text: 'Write-Output POINTER_NEW_OK' });
    await idle(h, a); await input(h.page, a.id, '& $env:TC_HOOK trigger new\r');
    const created = await until(async () => (await h.page.evaluate(() => workspace.cards)).find(card => ![a.id, b.id, c.id].includes(card.id)), 'New-terminal pointer did not create a card.');
    await until(async () => hasOutputLine(await h.output(created.id), 'POINTER_NEW_OK'), 'New-terminal pointer did not run its command.');
});

test('native Claude and Codex lifecycle hooks queue a prompt and continue through Stop into a shell target', windows, async t => {
    const tools = await fs.mkdtemp(path.join(root, '.cache', 'pointer-cli-'));
    for (const provider of ['claude', 'codex']) {
        await fs.writeFile(path.join(tools, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${path.join(__dirname, 'hook-cli.cjs')}" ${provider} %*\r\n`);
    }
    const h = await launch({ clean: true, env: { PATH: tools + path.delimiter + process.env.PATH } }); t.after(() => h.dispose());
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const a = await startTerminal(h.page, { title: 'Planner · Claude', cwd: root, command: 'claude', x: 0, y: 0 });
    const b = await startTerminal(h.page, { title: 'Implementer · Codex', cwd: root, command: 'codex', x: 720, y: 0 });
    const c = await startTerminal(h.page, { title: 'Tests · shell', cwd: root, x: 1440, y: 0 });
    try {
        await until(async () => hasOutputLine(await h.output(a.id), 'CLAUDE_BUSY'), 'Claude stand-in did not run its hooks.');
        await until(async () => hasOutputLine(await h.output(b.id), 'CODEX_BUSY'), 'Codex stand-in did not run its hooks.');
    } catch (error) { throw new Error(`${error.message}\nClaude output:\n${await h.output(a.id)}\nCodex output:\n${await h.output(b.id)}`); }
    await idle(h, c);
    await configure(h.page, a, b, 'planner-hook', { event: 'stop', action: 'prompt', text: 'Implement the plan', context: true });
    await configure(h.page, b, c, 'suite-hook', { event: 'stop', action: 'shell', text: 'Write-Output POINTER_AI_CHAIN_OK' });
    await h.page.evaluate(() => fitCanvas());
    await input(h.page, a.id, 'finish\r');
    await until(async () => (await h.page.evaluate(() => pointerStates.get('planner-hook')?.state)) === 'queued', 'Busy Codex target did not queue the prompt.');
    await input(h.page, b.id, 'finish\r');
    await until(async () => (await h.output(b.id)).includes('CONTINUED:Implement the plan'), 'Codex Stop did not return the queued continuation.');
    assert.equal(hasOutputLine(await h.output(c.id), 'POINTER_AI_CHAIN_OK'), false, 'The final step must wait for the continued turn.');
    await input(h.page, b.id, 'finish\r');
    await until(async () => hasOutputLine(await h.output(c.id), 'POINTER_AI_CHAIN_OK'), 'AI chain did not reach the shell.');
    await screenshot(h.page, 'hook-pointer-ai-chain');
});

test('native hidden-canvas pointers ignore focus reports and global pause preserves every canvas', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const source = await startTerminal(h.page, { title: 'Hidden source', cwd: root });
    const target = await startTerminal(h.page, { title: 'Hidden target', cwd: root, x: 720 });
    for (const card of [source, target]) await idle(h, card);
    await configure(h.page, source, target, 'hidden-hook', { event: 'trigger', name: 'hidden', action: 'shell', text: 'Write-Output HIDDEN_POINTER_OK' });
    await h.page.evaluate(() => createCanvas('Visible canvas'));
    const visible = await h.page.evaluate(() => activeCanvas.id);
    assert.equal(await h.page.evaluate(() => workspace.cards.length), 0, 'Both terminals are hidden');
    await input(h.page, source.id, '& $env:TC_HOOK trigger hidden\r');
    await until(async () => hasOutputLine(await h.output(target.id), 'HIDDEN_POINTER_OK'), 'Hidden pointer did not deliver.');
    assert.equal(await h.page.evaluate(() => activeCanvas.id), visible, 'Background delivery leaves navigation alone');
    assert.equal(await h.page.locator('#pointers-pause').isVisible(), true);
    await h.page.locator('#pointers-pause').click();
    await until(async () => h.page.evaluate(() => canvasStates.every(canvas => canvas.board.hooksPaused)), 'Pause did not cover the hidden canvas.');
    const state = await h.state();
    assert.equal(state.host.workspace.hooksPaused, true);
    assert.equal(state.host.workspace.cards.length, 2);
    assert.equal(state.host.workspace.canvases.length, 2);
    await screenshot(h.page, 'hook-pointer-hidden-canvas');
});
