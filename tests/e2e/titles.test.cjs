const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launch, until, psQuote, screenshot, root } = require('./harness.cjs');

test('local Claude and Codex names update cards, manual edits win, and title modes restore stopped', {
    skip: process.platform !== 'win32', timeout: 120000
}, async t => {
    const project = path.join(root, '.cache', 'auto-title-project');
    const tools = path.join(project, 'tools');
    const claudeHome = path.join(project, 'claude'), codexHome = path.join(project, 'codex');
    await fs.mkdir(tools, { recursive: true });
    await fs.writeFile(path.join(tools, 'names.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const provider = process.argv[2], args = process.argv.slice(3);
const id = provider === 'claude' ? '12345678-1234-4321-9876-123456789abc' : '0f1e2d3c-4b5a-4968-8776-655443322110';
const file = provider === 'claude'
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl')
    : path.join(process.env.CODEX_HOME, 'session_index.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(provider === 'claude'
    ? { type: 'ai-title', sessionId: id, aiTitle: 'Repair Claude session names', message: { content: 'NEVER_SAVE_PROMPT' } }
    : { id, thread_name: 'Repair Codex session names', first_prompt: 'NEVER_SAVE_PROMPT' }) + String.fromCharCode(10));
const command = provider === 'claude'
    ? JSON.parse(fs.readFileSync(args[args.indexOf('--settings') + 1], 'utf8')).hooks.SessionStart[0].hooks[0].command
    : args[args.indexOf('-c') + 1].match(/command='([^']*)'/)[1];
const result = spawnSync(command, { shell: true, windowsHide: true, encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: id, cwd: process.cwd() }) });
if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
console.log('CONTROLLED_NAME_READY');
setInterval(() => {}, 1000);
`);
    const checked = spawnSync(process.execPath, ['--check', path.join(tools, 'names.cjs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, checked.stderr);
    for (const provider of ['claude', 'codex']) {
        await fs.writeFile(path.join(tools, `${provider}.cmd`), `@echo off\r\n"%TC_E2E_NODE%" "%~dp0names.cjs" ${provider} %*\r\n`);
    }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    const env = { [pathKey]: tools + path.delimiter + process.env[pathKey], TC_E2E_NODE: process.execPath,
        CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
    // No profile cleanup is needed: New replaces only this harness's isolated workspace.
    const first = await launch({ phase: 'save', env }); t.after(() => first.dispose());
    await first.page.evaluate(async () => { const result = await invoke('new'); loadWorkspace(result.workspace, result.titleEpoch); });
    const cards = [];
    for (const provider of ['claude', 'codex']) {
        const card = await first.page.evaluate(async ({ project, provider }) => {
            const { card } = await invoke('create-card', { profile: provider, titleMode: 'automatic', command: '', cwd: project, x: provider === 'claude' ? 0 : 700 });
            workspace.cards.push(card); mount(card); refresh(); await start(card); return card;
        }, { project, provider });
        cards.push(card);
        await until(async () => !(await first.page.evaluate(card => invoke('duplicate-directory', card), card)).warning, 'Shell did not reach an idle prompt.');
        // Never fall through to an installed/authenticated provider.
        const command = `if ((Get-Command ${provider} -CommandType Application).Source -ieq ${psQuote(path.join(tools, `${provider}.cmd`))}) { ${provider} } else { throw 'Uncontrolled provider executable' }\r`;
        await first.page.evaluate(({ id, command }) => window.terminalCanvas.input(id, command), { id: card.id, command });
    }
    await until(async () => (await first.state()).host.workspace.cards.every(card => card.title.startsWith('Repair ')),
        'The captured local session names did not become automatic titles.', 30000);
    await first.page.locator(`.terminal-card[data-id="${cards[0].id}"] .card-title`).click();
    await first.page.locator('#rename-title').fill('My release terminal');
    await first.page.getByRole('button', { name: 'Save name', exact: true }).click();
    await until(async () => (await first.state()).host.workspace.cards[0].titleMode === 'manual', 'Manual rename was not saved.');
    await screenshot(first.page, 'automatic-terminal-titles');
    const saved = JSON.parse(await fs.readFile(path.join(first.profile, 'workspace.terminalcanvas'), 'utf8'));
    assert.equal(saved.cards[0].title, 'My release terminal');
    assert.equal(saved.cards[1].title, 'Repair Codex session names');
    assert.ok(!JSON.stringify(saved).includes('NEVER_SAVE_PROMPT'));
    await first.page.evaluate(() => { void invoke('close', workspace); });
    assert.equal(await first.waitExit(), 0);
    const second = await launch({ phase: 'reopen', env }); t.after(() => second.dispose());
    assert.equal((await second.state()).host.running, 0);
    const restored = await second.page.evaluate(() => workspace.cards);
    assert.equal(restored[0].title, 'My release terminal'); assert.equal(restored[0].titleMode, 'manual');
    assert.equal(restored[1].title, 'Repair Codex session names'); assert.equal(restored[1].titleMode, 'automatic');
    await second.page.locator(`.terminal-card[data-id="${cards[0].id}"] .card-title`).click();
    await second.page.getByRole('button', { name: 'Use automatic title', exact: true }).click();
    await until(async () => (await second.state()).host.workspace.cards[0].titleMode === 'automatic', 'Automatic naming could not be restored.');
    assert.equal((await second.state()).host.running, 0, 'Changing naming mode must not restart a terminal.');
    assert.deepEqual([...first.errors, ...second.errors], []);
});
