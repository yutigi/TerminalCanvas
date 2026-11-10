const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch, until, hasOutputLine, psQuote, screenshot, root } = require('./harness.cjs');
const ids = { claude: '12345678-1234-4321-9876-123456789abc', codex: '0f1e2d3c-4b5a-4968-8776-655443322110' };

test('two launches recover Claude and Codex IDs, resume exactly, and retain metadata in a fresh shell', {
    skip: process.platform !== 'win32', timeout: 180000
}, async t => {
    const project = path.join(root, '.cache', 'tauri-restoration-project');
    const tools = path.join(project, 'tools');
    const changed = path.join(project, 'changed ไทย 工作 🚀');
    await fs.mkdir(tools, { recursive: true }); await fs.mkdir(changed, { recursive: true });
    const fake = path.join(tools, 'fake.cjs');
    await fs.writeFile(fake, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const provider = process.argv[2], args = process.argv.slice(3);
console.log('CLI_ARGS:' + provider + ':' + JSON.stringify(args));
const settings = args.indexOf('--settings');
if (provider === 'claude' && settings >= 0) {
    const config = JSON.parse(fs.readFileSync(args[settings + 1], 'utf8'));
    const command = config.hooks.SessionStart[0].hooks[0].command;
    const payload = { hook_event_name: 'SessionStart', session_id: '${ids.claude}', cwd: process.cwd(), transcript_path: 'MUST_NOT_BE_SAVED' };
    const result = spawnSync(command, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
if (provider === 'codex') console.log('session id: ${ids.codex}');
console.log('SESSION_TEST_DONE:' + provider);
`);
    for (const provider of Object.keys(ids)) {
        await fs.writeFile(path.join(tools, `${provider}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" ${provider} %*\r\n`);
    }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'Path';
    const env = { [pathKey]: tools + path.delimiter + process.env[pathKey] };
    const first = await launch({ phase: 'save', clean: true, env }); t.after(() => first.dispose());
    await first.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const cards = [];
    for (const provider of Object.keys(ids)) {
        const card = await first.page.evaluate(async ({ provider, project }) => {
            const { card } = await invoke('create-card', { title: `Manual ${provider}`, cwd: project, profile: 'shell' });
            workspace.cards.push(card); mount(card); await start(card); return card;
        }, { provider, project });
        cards.push(card);
        await until(async () => !(await first.page.evaluate(card => invoke('duplicate-directory', card), card)).warning, 'Shell did not reach its prompt.');
        const marker = `STANDIN_RESOLVED:${provider}`;
        const command = `$env:Path=${psQuote(tools + path.delimiter)}+$env:Path; Set-Location -LiteralPath ${psQuote(changed)}; `
            + `if ((Get-Command ${provider} -CommandType Application).Source -ieq ${psQuote(path.join(tools, `${provider}.cmd`))}) { 'STANDIN_' + 'RESOLVED:${provider}' } else { throw 'Uncontrolled provider executable' }`;
        await first.page.evaluate(({ id, command }) => window.terminalCanvas.input(id, command + '\r'), { id: card.id, command });
        await until(async () => hasOutputLine(await first.output(card.id), marker), 'The controlled application did not resolve; no provider was invoked.');
        await until(async () => {
            const choice = await first.page.evaluate(card => invoke('duplicate-directory', card), card);
            return choice.cwd === changed && !choice.warning;
        }, 'The controlled project did not reach an idle prompt.');
        const choice = await first.page.evaluate(card => invoke('duplicate-directory', card), card);
        assert.equal(choice.cwd, changed);
        await first.page.evaluate(({ id, provider }) => window.terminalCanvas.input(id, provider + '\r'), { id: card.id, provider });
        await until(async () => {
            const board = (await first.state()).host.workspace;
            return (await first.output(card.id)).includes(`SESSION_TEST_DONE:${provider}`) && board.cards.find(c => c.id === card.id)?.session?.sessionId === ids[provider];
        }, `Manual ${provider} capture did not finish.`);
    }
    // A stray resume hint in ordinary shell output cannot replace the observed conversation.
    await first.page.evaluate(id => window.terminalCanvas.input(id, "Write-Output 'Example: codex resume 87654321-4321-4321-9876-123456789abc'; Write-Output 'DOCUMENT_OUTPUT_DONE'\r"), cards[0].id);
    await until(async () => (await first.output(cards[0].id)).includes('DOCUMENT_OUTPUT_DONE'), 'Ordinary output did not finish.');
    const recovery = path.join(first.profile, 'workspace.terminalcanvas');
    await until(async () => {
        const saved = JSON.parse(await fs.readFile(recovery, 'utf8'));
        return saved.cards.length === 2 && saved.cards.every((card, index) => card.session?.sessionId === ids[Object.keys(ids)[index]]);
    }, 'Hook and parsed metadata were not immediately autosaved.');
    const persisted = JSON.parse(await fs.readFile(recovery, 'utf8'));
    for (const card of persisted.cards) {
        assert.equal(card.cwd, changed); assert.equal(card.session.cwd, changed);
    }
    assert.ok(!JSON.stringify(persisted).includes('MUST_NOT_BE_SAVED'));
    await first.page.evaluate(() => { workspace.name = 'Saved during close'; void invoke('close', workspace); });
    assert.equal(await first.waitExit(), 0);
    const second = await launch({ phase: 'reopen', env }); t.after(() => second.dispose());
    const restored = await second.page.evaluate(() => workspace);
    assert.equal(restored.name, 'Saved during close');
    assert.equal((await second.state()).host.running, 0, 'Reopening must not execute a saved command.');
    for (const [index, provider] of Object.keys(ids).entries()) {
        const card = restored.cards[index];
        assert.equal(card.session.sessionId, ids[provider]);
        assert.equal(await second.page.evaluate(id => sessions.get(id).element.querySelector('[data-action="start"]').textContent.trim(), card.id), 'Resume session');
        await second.page.evaluate(id => start(workspace.cards.find(card => card.id === id)), card.id);
        await until(async () => (await second.output(card.id)).includes(`SESSION_TEST_DONE:${provider}`), 'Exact-ID resume did not finish.');
        const expected = provider === 'claude' ? `"--resume","${ids[provider]}"` : `"resume","${ids[provider]}"`;
        assert.ok((await second.output(card.id)).includes(expected));
        await second.page.evaluate(id => window.terminalCanvas.input(id, 'exit\r'), card.id);
        await until(async () => !(await second.state()).host.terminals.find(terminal => terminal.id === card.id).running, 'Resumed shell did not exit.');
        await second.page.evaluate(id => {
            window.__e2eEvents = [];
            const card = workspace.cards.find(card => card.id === id); setStatus(card, 'idle'); return start(card, 'fresh');
        }, card.id);
        await until(async () => !(await second.page.evaluate(card => invoke('duplicate-directory', card), card)).warning, 'Fresh shell did not reach its prompt.');
        assert.ok(!(await second.output(card.id)).includes('CLI_ARGS:'), 'Fresh shells must not rerun an AI tool.');
        assert.equal((await second.state()).host.workspace.cards[index].session.sessionId, ids[provider]);
        await second.page.evaluate(id => invoke('stop', { id }), card.id);
    }
    await screenshot(second.page, 'restoration');
});
