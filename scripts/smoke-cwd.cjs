const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async ({ win, terminals, createCard }) => {
    const root = path.resolve(__dirname, '../.cache/cwd smoke');
    const target = path.join(root, "folder with spaces 子 %25 # it's");
    await fs.mkdir(target, { recursive: true });
    async function waitFor(check, message) {
        const deadline = Date.now() + 12000;
        while (!await check()) {
            if (Date.now() > deadline) {
                const diagnostics = await win.webContents.executeJavaScript(`(() => { const s = sessions.get(workspace.cards[0].id); const b = s.terminal.buffer.active; return { cwd: s.cwd, lines: Array.from({length: b.length}, (_, i) => b.getLine(i).translateToString()) }; })()`);
                throw new Error(message + '\n' + JSON.stringify(diagnostics));
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    const shells = process.platform === 'win32' ? ['', 'pwsh', 'cmd.exe'] : [''];
    for (const command of shells) {
        // pwsh is optional on developer machines; the default and cmd are built in.
        if (command === 'pwsh') {
            const { spawnSync } = require('node:child_process');
            if (spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status !== 0) {
                console.log('Directory smoke: pwsh unavailable; skipped.'); continue;
            }
        }
        const cards = [createCard({ title: command || 'Default shell', cwd: root, command, x: 0 }), createCard({ title: 'Independent shell', cwd: root, x: 700 })];
        await win.webContents.executeJavaScript(`loadWorkspace(${JSON.stringify({ version: 2, name: 'Directory smoke', camera: { x: 20, y: 20, z: .65 }, cards, items: [] })});
            (async () => { for (const card of workspace.cards) await start(card); })()`);
        const displayed = index => win.webContents.executeJavaScript(`sessions.get(workspace.cards[${index}].id).element.querySelector('.card-directory span').textContent`);
        await waitFor(async () => await displayed(0) === root && await displayed(1) === root, 'Initial directory reports did not reach both displays: ' + command);
        const cmd = command === 'cmd.exe';
        const posix = process.platform !== 'win32';
        terminals.write(cards[0].id, cmd ? `cd /d "${target}"\r` : posix ? `cd '${target.replaceAll("'", "'\\''")}'\r` : `cd -LiteralPath '${target.replaceAll("'", "''")}'\r`);
        await waitFor(async () => await displayed(0) === target, 'Changed directory did not reach the display: ' + command);
        assert.equal(await displayed(1), root, 'another terminal keeps its own directory');
        assert.deepEqual(await win.webContents.executeJavaScript('workspace.cards.map(c => c.cwd)'), [target, root], 'last valid folders are retained independently for restoration');
        assert.equal(terminals.snapshot().get(cards[0].id).cwd, target, 'the host retains the folder for shutdown recovery');
        terminals.write(cards[0].id, cmd || posix ? 'cd "missing directory"\r' : "Set-Location -LiteralPath 'missing directory'\r");
        terminals.write(cards[0].id, cmd || posix ? 'echo CWD_OUTPUT_OK\r' : "Write-Output 'CWD_OUTPUT_OK'\r");
        await waitFor(() => win.webContents.executeJavaScript(`(() => { const t = sessions.get(workspace.cards[0].id).terminal; return Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i).translateToString().trim()).includes('CWD_OUTPUT_OK'); })()`), 'Normal output was lost: ' + command);
        assert.equal(await displayed(0), target, 'a failed cd does not report its argument');
        // Capture the changed path while both terminal cards are visible.
        await win.webContents.executeJavaScript('select(workspace.cards[0].id); fitCanvas()');
        await new Promise(resolve => setTimeout(resolve, 100));
        const screenshot = path.join(root, (command || 'default') + '.png');
        const { captureScreenshot } = require('./smoke.cjs');
        await fs.writeFile(screenshot, (await captureScreenshot(win)).toPNG());
        if (!cmd && process.platform === 'win32') {
            terminals.write(cards[0].id, 'Set-Location HKCU:\r');
            await waitFor(async () => await displayed(0) === 'Current directory unavailable', 'Non-filesystem location should be unknown: ' + command);
            assert.equal(terminals.snapshot().get(cards[0].id).cwd, target, 'an unavailable location preserves the last restorable folder');
        }
        terminals.stopAll();
        console.log('Directory smoke passed: ' + (command || 'default login shell') + ' (cd, spaces, Unicode, independent saved folders, failed cd, output, unavailable location).');
    }
};
