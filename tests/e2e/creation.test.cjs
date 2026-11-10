const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch, until, hasOutputLine, key, psQuote, screenshot, root } = require('./harness.cjs');
const { choose, input, startTerminal } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };
const directory = (page, card) => page.evaluate(card => invoke('duplicate-directory', card), card);

test('creation uses independent live directories, queues require review, and folder dialogs preserve user input', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const project = await fs.mkdtemp(path.join(root, '.cache', 'tauri-creation-'));
    const nested = path.join(project, 'nested space', "project's 日本語");
    const other = path.join(project, 'second project');
    await fs.mkdir(nested, { recursive: true }); await fs.mkdir(other);
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const source = await startTerminal(h.page, { title: 'Changed directory', cwd: project, profile: 'custom', command: 'Write-Output SOURCE_ONLY_MARKER' });
    const independent = await startTerminal(h.page, { title: 'Independent shell', cwd: other, x: 710 });
    await until(async () => !(await directory(h.page, source)).warning && !(await directory(h.page, independent)).warning, 'Shells did not become idle.');
    await input(h.page, source.id, `Set-Location -LiteralPath ${psQuote(nested)}\r`);
    await until(async () => { const choice = await directory(h.page, source); return choice.cwd === nested && !choice.warning; }, 'Changed directory did not reach the host.');
    assert.equal((await directory(h.page, independent)).cwd, other);
    const marker = path.join(project, 'queued-cwd.txt'), release = path.join(project, 'release-command');
    await input(h.page, source.id, `Set-Location -LiteralPath ${psQuote(other)}\rSet-Location -LiteralPath ${psQuote(nested)}; [IO.File]::WriteAllText(${psQuote(marker)}, (Get-Location).ProviderPath); while (-not (Test-Path -LiteralPath ${psQuote(release)})) { Start-Sleep -Milliseconds 50 }\r`);
    await until(async () => await fs.readFile(marker, 'utf8') === nested, 'Queued command did not reach the final directory.');
    try {
        assert.ok((await directory(h.page, source)).warning, 'Intermediate prompt cannot authorize direct duplication.');
        await h.page.evaluate(id => duplicateTerminal(workspace.cards.find(card => card.id === id)), source.id);
        assert.equal(await h.page.locator('#launch-dialog').evaluate(dialog => dialog.open), true);
        assert.equal(await h.page.evaluate(() => workspace.cards.length), 2);
        assert.equal((await h.state()).host.running, 2);
        await h.page.locator('#launch-dialog').evaluate(dialog => dialog.close());
    } finally { await fs.writeFile(release, 'continue'); }
    await until(async () => !(await directory(h.page, source)).warning, 'Final prompt did not restore duplication.');
    await h.page.evaluate(id => { select(id); sessions.get(id).terminal.focus(); }, source.id);
    await key(h.page, 'Control+Shift+d');
    await until(async () => (await h.state()).host.running === 3, 'Duplicate shortcut did not start a new process.');
    const fresh = await h.page.evaluate(() => workspace.cards.at(-1));
    await until(async () => !(await directory(h.page, fresh)).warning, 'Fresh duplicate did not become idle.');
    assert.equal(fresh.cwd, nested); assert.equal(fresh.profile, 'shell'); assert.equal(fresh.command, '');
    const state = await h.state();
    assert.notEqual(state.host.terminals.find(t => t.id === source.id).pid, state.host.terminals.find(t => t.id === fresh.id).pid);
    assert.ok(!(await h.output(fresh.id)).includes('SOURCE_ONLY_MARKER'));
    await h.page.evaluate(() => fitCanvas());
    await h.page.locator(`[data-id="${independent.id}"] [data-action="duplicate"]`).click();
    await until(async () => (await h.state()).host.running === 4, 'Duplicate button did not use its own terminal.');
    assert.equal(await h.page.evaluate(() => workspace.cards.at(-1).cwd), other);
    await h.page.evaluate(id => invoke('stop', { id }), source.id);
    const count = await h.page.evaluate(() => workspace.cards.length);
    await h.page.evaluate(id => duplicateTerminal(workspace.cards.find(card => card.id === id)), source.id);
    assert.equal(await h.page.locator('#launch-dialog').evaluate(dialog => dialog.open), true);
    assert.equal(await h.page.locator('#cwd').inputValue(), nested);
    assert.equal(await h.page.locator('#launch-error').isVisible(), true);
    assert.equal(await h.page.evaluate(() => workspace.cards.length), count);
    await h.page.locator('#launch-dialog').evaluate(dialog => dialog.close());
    await h.page.locator('#search').focus(); await key(h.page, 'Control+Shift+n');
    assert.equal(await h.page.locator('#launch-dialog').evaluate(dialog => dialog.open), true);
    for (const candidate of [nested, path.join(project, 'missing folder')]) {
        const before = (await h.state()).dialogs.length;
        await choose(h.page, null);
        await h.page.locator('#cwd').fill(candidate); await h.page.locator('#browse-folder').click();
        await until(async () => (await h.state()).dialogs.length > before, 'Folder picker was not called.');
        const calls = (await h.state()).dialogs;
        assert.equal(calls.at(-1).default, candidate === nested ? nested : state.host.home);
        assert.equal(await h.page.locator('#cwd').inputValue(), candidate, 'Cancel preserves typed folder.');
    }
    await choose(h.page, other); await h.page.locator('#browse-folder').click();
    await until(async () => await h.page.locator('#cwd').inputValue() === other, 'Chosen folder did not reach the field.');
    await h.page.locator('#launch-dialog').evaluate(dialog => dialog.close());
    await h.page.evaluate(() => fitCanvas()); await screenshot(h.page, 'creation');
});

for (const shell of ['', 'pwsh', 'cmd.exe']) {
    test(`directory displays and recovery remain independent in ${shell || 'Windows PowerShell 5.1'}`, windows, async t => {
        const h = await launch({ clean: true }); t.after(() => h.dispose());
        const project = path.join(root, '.cache', 'tauri-cwd');
        const target = path.join(project, "folder with spaces 子 %25 # it's");
        await fs.mkdir(target, { recursive: true });
        await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
        const first = await startTerminal(h.page, { title: shell || 'Default shell', cwd: project, command: shell });
        const second = await startTerminal(h.page, { title: 'Independent shell', cwd: project, x: 700 });
        const displayed = id => h.page.locator(`[data-id="${id}"] .card-directory span`).textContent();
        await until(async () => await displayed(first.id) === project && await displayed(second.id) === project, 'Initial directories did not reach the UI.');
        const cmd = shell === 'cmd.exe';
        await input(h.page, first.id, cmd ? `cd /d "${target}"\r` : `Set-Location -LiteralPath ${psQuote(target)}\r`);
        await until(async () => await displayed(first.id) === target, 'Changed directory was not displayed.');
        assert.equal(await displayed(second.id), project);
        assert.deepEqual(await h.page.evaluate(() => workspace.cards.map(card => card.cwd)), [target, project]);
        assert.equal((await h.state()).host.workspace.cards[0].cwd, target);
        await input(h.page, first.id, cmd ? 'cd "missing directory"\recho CWD_OUTPUT_OK\r' : "Set-Location -LiteralPath 'missing directory'\rWrite-Output 'CWD_OUTPUT_OK'\r");
        await until(async () => hasOutputLine(await h.output(first.id), 'CWD_OUTPUT_OK'), 'Ordinary output was lost.');
        assert.equal(await displayed(first.id), target);
        if (!cmd) {
            await until(async () => !(await directory(h.page, first)).warning, 'Shell did not become idle.');
            const marker = path.join(project, 'running'), release = path.join(project, 'release');
            await fs.rm(marker, { force: true }); await fs.rm(release, { force: true });
            await input(h.page, first.id, `Set-Location -LiteralPath ${psQuote(project)}\rSet-Location -LiteralPath ${psQuote(target)}; [IO.File]::WriteAllText(${psQuote(marker)}, 'running'); while (-not (Test-Path -LiteralPath ${psQuote(release)})) { Start-Sleep -Milliseconds 50 }\r`);
            await until(async () => await fs.readFile(marker, 'utf8') === 'running', 'Buffered command did not start.');
            try { assert.ok((await directory(h.page, first)).warning); }
            finally { await fs.writeFile(release, 'continue'); }
            await until(async () => !(await directory(h.page, first)).warning, 'Final prompt did not restore readiness.');
            await input(h.page, first.id, 'Set-Location HKCU:\r');
            await until(async () => await displayed(first.id) === 'Current directory unavailable', 'Non-filesystem location should be unavailable.');
            assert.equal((await h.state()).host.workspace.cards[0].cwd, target);
        }
        await h.page.evaluate(() => fitCanvas()); await screenshot(h.page, `cwd-${shell || 'default'}`);
    });
}
