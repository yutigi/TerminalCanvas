const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog } = require('electron');

async function until(check, message) {
    const deadline = Date.now() + 15000;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}
exports.checkCreationWorkflows = async ({ app, win, terminals, createCard, captureScreenshot }) => {
    const cache = path.resolve(__dirname, '../.cache');
    await fs.mkdir(cache, { recursive: true });
    const root = await fs.mkdtemp(path.join(cache, 'creation-'));
    const nested = path.join(root, 'nested space', "project's 日本語");
    const other = path.join(root, 'second project');
    await fs.mkdir(nested, { recursive: true }); await fs.mkdir(other);
    const cards = [createCard({ cwd: root, title: 'Changed directory', x: 0, profile: 'custom', command: 'Write-Output SOURCE_ONLY_MARKER' }),
        createCard({ cwd: other, title: 'Other project', x: 710 })];
    const js = async code => {
        try { return await win.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`Creation renderer check failed: ${code.slice(0, 180)}`, { cause: error }); }
    };
    const shortcut = keyCode => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] });
    };
    const originalPicker = dialog.showOpenDialog;
    const pickerCalls = [];
    let pickerResult = { canceled: true, filePaths: [] };
    try {
        await js(`loadWorkspace(${JSON.stringify({ version: 2, name: 'Creation workflow smoke', camera: { x: 30, y: 30, z: .7 }, items: [], cards })});
            (async () => { for (const card of workspace.cards) await start(card); })()`);
        if (process.platform === 'win32' || process.platform === 'linux') {
            await until(async () => !(await terminals.directory(cards[0])).warning && !(await terminals.directory(cards[1])).warning, 'Shells did not report initial directories.');
            const change = process.platform === 'win32' ? `Set-Location -LiteralPath '${nested.replace(/'/g, "''")}'` : `cd '${nested.replace(/'/g, "'\\''")}'`;
            terminals.write(cards[0].id, change + '\r');
            await until(async () => (await terminals.directory(cards[0])).cwd === nested && !(await terminals.directory(cards[0])).warning, 'Directory tracking did not follow cd into the nested path.');
            assert.equal((await terminals.directory(cards[1])).cwd, other);
            if (process.platform === 'win32') {
                terminals.write(cards[0].id, 'Start-Sleep -Milliseconds 500\r');
                assert.ok((await terminals.directory(cards[0])).warning, 'a busy shell must not reuse a potentially stale prompt directory');
                await until(async () => !(await terminals.directory(cards[0])).warning, 'Directory reporting did not resume after the command.');
                // Reproduce a multiline paste with no PSReadLine: the first prompt
                // must not make its intermediate folder available to Duplicate.
                const marker = path.join(root, 'queued-cwd.txt'), release = path.join(root, 'release-command');
                const quote = value => "'" + value.replace(/'/g, "''") + "'";
                terminals.write(cards[0].id, `Set-Location -LiteralPath ${quote(other)}\rSet-Location -LiteralPath ${quote(nested)}; [IO.File]::WriteAllText(${quote(marker)}, (Get-Location).ProviderPath); while (-not (Test-Path -LiteralPath ${quote(release)})) { Start-Sleep -Milliseconds 50 }\r`);
                await until(async () => {
                    try { return await fs.readFile(marker, 'utf8') === nested; } catch { return false; }
                }, 'The queued command did not reach the final directory.');
                assert.ok((await terminals.directory(cards[0])).warning, 'intermediate pasted-command prompts must require fallback review');
                await js('duplicateTerminal(workspace.cards[0])');
                assert.equal(await js('document.querySelector("#launch-dialog").open'), true);
                assert.equal(await js('workspace.cards.length'), 2);
                await js('document.querySelector("#launch-dialog").close()');
                await fs.writeFile(release, 'continue');
                await until(async () => !(await terminals.directory(cards[0])).warning, 'The final idle prompt did not restore duplication.');
                assert.equal((await terminals.directory(cards[0])).cwd, nested);

            }
            await js('select(workspace.cards[0].id); sessions.get(workspace.cards[0].id).terminal.focus()');
            shortcut('D');
            await until(() => terminals.sessions.size === 3, 'Ctrl+Shift+D did not launch a fresh terminal.');
            const fresh = await js('JSON.parse(JSON.stringify(workspace.cards.at(-1)))');
            await until(async () => !(await terminals.directory(fresh)).warning, 'Duplicate did not report its directory.');
            assert.equal((await terminals.directory(fresh)).cwd, nested);
            assert.equal(fresh.profile, 'shell'); assert.equal(fresh.command, '');
            assert.notEqual(terminals.sessions.get(fresh.id).terminal.pid, terminals.sessions.get(cards[0].id).terminal.pid);
            const output = await js(`(() => { const t = sessions.get(${JSON.stringify(fresh.id)}).terminal; return Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i).translateToString()).join('\\n'); })()`);
            assert.ok(!output.includes('SOURCE_ONLY_MARKER'), 'duplicate must not contain source output');
            // The button must use its own terminal even when another terminal is selected.
            await js('sessions.get(workspace.cards[1].id).element.querySelector("[data-action=duplicate]").click()');
            await until(() => terminals.sessions.size === 4, 'Duplicate button did not launch a terminal.');
            const second = await js('JSON.parse(JSON.stringify(workspace.cards.at(-1)))');
            assert.equal(second.cwd, other);
        }
        terminals.stop(cards[0].id);
        const count = await js('workspace.cards.length');
        await js('duplicateTerminal(workspace.cards[0])');
        assert.equal(await js('document.querySelector("#launch-dialog").open'), true);
        assert.equal(await js('document.querySelector("#cwd").value'), root);
        assert.equal(await js('document.querySelector("#launch-error").hidden'), false);
        assert.equal(await js('workspace.cards.length'), count, 'fallback needs review before creating anything');
        await js('document.querySelector("#launch-dialog").close(); document.querySelector("#search").focus()');
        shortcut('N');
        await until(() => js('document.querySelector("#launch-dialog").open'), 'Ctrl+Shift+N did not open the launch dialog.');
        dialog.showOpenDialog = async (_win, options) => { pickerCalls.push(options); return pickerResult; };
        for (const candidate of [nested, path.join(root, 'missing folder')]) {
            await js(`document.querySelector('#cwd').value = ${JSON.stringify(candidate)}; document.querySelector('#browse-folder').click()`);
            await until(() => pickerCalls.length > 0, 'Browse did not reach the native picker.');
            const options = pickerCalls.pop();
            assert.equal(options.defaultPath, candidate === nested ? nested : app.getPath('home'));
            assert.equal(await js('document.querySelector("#cwd").value'), candidate, 'cancellation must preserve user input');
        }
        pickerResult = { canceled: false, filePaths: [other] };
        await js('document.querySelector("#browse-folder").click()');
        await until(() => js(`document.querySelector('#cwd').value === ${JSON.stringify(other)}`), 'Chosen folder did not update the field.');
        await js('document.querySelector("#launch-dialog").close(); fitCanvas(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        assert.equal(await js('document.querySelector("#launch-dialog").open'), false);
        await fs.writeFile(path.join(cache, 'smoke-creation.png'), (await captureScreenshot(win)).toPNG());
        console.log('Creation smoke passed: live cd, nested spaces/Unicode, separate terminals, Duplicate button/shortcut, fresh process/output, fallback review, New shortcut, picker default paths/cancellation.');
    } finally {
        dialog.showOpenDialog = originalPicker;
        terminals.stopAll();
        await js('document.querySelector("#launch-dialog").close()');
        // PowerShell can briefly retain handles to its launch directory after termination.
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
};
