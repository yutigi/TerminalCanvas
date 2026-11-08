const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { captureScreenshot } = require('./smoke.cjs');
const savedId = '12345678-1234-4321-9876-123456789abc';
async function until(check, message) {
    const deadline = Date.now() + 15000;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
exports.run = async ({ app, win, terminals, createCard, phase }) => {
    assert.equal(process.platform, 'win32', 'This native smoke test currently targets Windows.');
    const root = path.resolve(__dirname, '../.cache/restoration-project');
    const tools = path.join(root, 'tools');
    const changedFolder = path.join(root, 'changed folder ไทย 工作 🚀');
    await fs.mkdir(tools, { recursive: true });
    await fs.mkdir(changedFolder, { recursive: true });
    // These stand-ins exercise real shells and real hook processes, with no API calls.
    const fake = path.join(tools, 'fake.cjs');
    await fs.writeFile(fake, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const settings = args.indexOf('--settings');
console.log('CLI_ARGS:' + JSON.stringify(args));
if (settings >= 0) {
    const config = JSON.parse(fs.readFileSync(args[settings + 1], 'utf8'));
    const command = config.hooks.SessionStart[0].hooks[0].command;
    const payload = { hook_event_name: 'SessionStart', session_id: '${savedId}', cwd: process.cwd(), transcript_path: 'MUST_NOT_BE_SAVED' };
    const result = spawnSync(command, { shell: true, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
console.log('SESSION_TEST_DONE');
`);
    await fs.writeFile(path.join(tools, 'claude.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${fake}" %*\r\n`);
    const pathKey = Object.keys(terminals.env).find(key => key.toLowerCase() === 'path') || 'Path';
    terminals.env = { ...terminals.env, [pathKey]: tools + path.delimiter + terminals.env[pathKey] };
    await until(() => win.webContents.executeJavaScript('Boolean(document.querySelector(".profile-button"))'), 'Renderer did not initialize.');
    let output = '';
    const originalEmit = terminals.emit;
    terminals.emit = event => { if (event.type === 'data') output += event.data; originalEmit(event); };
    if (phase === 'save') {
        await win.webContents.executeJavaScript("invoke('new')");
        const card = createCard({ title: 'Restored manual Claude session', cwd: root });
        await win.webContents.executeJavaScript(`loadWorkspace({ version: 2, name: 'Session restoration smoke', camera: { x: 30, y: 30, z: 1 }, cards: [${JSON.stringify(card)}], items: [] }); start(workspace.cards[0])`);
        await until(() => output.includes('> '), 'Integrated PowerShell did not reach its prompt.');
        terminals.write(card.id, `Set-Location -LiteralPath '${changedFolder.replace(/'/g, "''")}'\r`);
        await until(() => terminals.snapshot().get(card.id)?.cwd === changedFolder, 'Changed shell directory was not captured.');
        terminals.write(card.id, 'claude\r');
        try { await until(() => output.includes('SESSION_TEST_DONE') && terminals.snapshot().get(card.id)?.session?.sessionId === savedId, 'Manual Claude launch or its SessionStart hook was not captured.'); }
        catch (error) { console.error(output.slice(-12000)); throw error; }
        const unrelatedId = '87654321-4321-4321-9876-123456789abc';
        terminals.write(card.id, `Write-Output 'Example: codex resume ${unrelatedId}'; Write-Output 'DOCUMENT_OUTPUT_DONE'\r`);
        await until(() => /(?:\r?\n)DOCUMENT_OUTPUT_DONE(?:\r?\n|\x1b)/.test(output), 'Ordinary shell output did not finish.');
        assert.deepEqual(terminals.snapshot().get(card.id).session, { provider: 'claude', sessionId: savedId, cwd: changedFolder }, 'Ordinary terminal output must not replace the captured AI session.');
        const file = path.join(app.getPath('userData'), 'workspace.terminalcanvas');
        await until(async () => JSON.parse(await fs.readFile(file, 'utf8')).cards[0]?.session?.sessionId === savedId, 'Host metadata was not autosaved.');
        const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.equal(persisted.cards[0].cwd, changedFolder);
        assert.equal(persisted.cards[0].session.cwd, changedFolder);
        assert.ok(!JSON.stringify(persisted).includes('MUST_NOT_BE_SAVED'));
        // The ordinary close IPC must flush even a layout change within the debounce window.
        await win.webContents.executeJavaScript("workspace.name = 'Saved during close'; void invoke('close', workspace)");
        console.log('Restoration save phase passed: real shell cwd, manual CLI, hook metadata, immediate autosave, shutdown flush.');
    } else {
        const board = await win.webContents.executeJavaScript('workspace');
        assert.equal(board.name, 'Saved during close');
        assert.equal(board.cards[0].cwd, changedFolder);
        assert.equal(board.cards[0].session.sessionId, savedId);
        assert.equal(terminals.sessions.size, 0, 'Reopening must never execute saved commands.');
        assert.equal(await win.webContents.executeJavaScript('sessions.get(workspace.cards[0].id).element.querySelector(\'[data-action="start"]\').textContent'), 'Resume session');
        const screenshot = path.resolve(__dirname, '../.cache/restoration.png');
        await fs.writeFile(screenshot, (await captureScreenshot(win)).toPNG());
        await win.webContents.executeJavaScript('start(workspace.cards[0])');
        await until(() => output.includes('SESSION_TEST_DONE'), 'Resumed CLI did not finish.');
        assert.ok(output.includes('"--resume","' + savedId + '"'), output);
        terminals.write(board.cards[0].id, 'exit\r');
        await until(() => terminals.sessions.size === 0, 'Resumed shell did not exit.');
        output = '';
        await win.webContents.executeJavaScript('setStatus(workspace.cards[0], "idle"); start(workspace.cards[0], "fresh")');
        await until(() => output.includes('> '), 'Fresh shell did not reach its prompt.');
        assert.ok(!output.includes('CLI_ARGS:'), 'A fresh shell must not rerun the AI tool.');
        assert.equal(terminals.snapshot().get(board.cards[0].id).session.sessionId, savedId);
        await win.webContents.executeJavaScript("void invoke('close', workspace)");
        console.log(`Restoration reopen phase passed: stopped cards, exact resume ID, fresh shell fallback. Screenshot: ${screenshot}`);
    }
};
