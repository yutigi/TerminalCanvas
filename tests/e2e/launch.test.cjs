const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { launch, until, hasOutputLine, psQuote, screenshot, root } = require('./harness.cjs');
const { input, startTerminal } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };
const directory = (page, card) => page.evaluate(card => invoke('duplicate-directory', card), card);

test('a program in a terminal opens a started terminal beside it, joined by an arrow', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const project = await fs.mkdtemp(path.join(root, '.cache', 'tauri-launch-'));
    const child = path.join(project, 'child folder');
    await fs.mkdir(child);
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const parent = await startTerminal(h.page, { title: 'Agent', cwd: project });
    await until(async () => !(await directory(h.page, parent)).warning, 'The parent shell did not become idle.');
    await input(h.page, parent.id, `& $env:TC_HOOK new-terminal --title Helper --cwd ${psQuote('child folder')} --command 'Write-Output CHILD_STARTED_OK'; Write-Output "HOOK_EXIT=$LASTEXITCODE"\r`);
    await until(async () => hasOutputLine(await h.output(parent.id), 'HOOK_EXIT=0'), 'tc-hook new-terminal did not succeed.');
    await until(async () => (await h.page.evaluate(() => workspace.cards.length)) === 2, 'The requested terminal was not created.');
    const [, helper] = await h.page.evaluate(() => workspace.cards);
    assert.equal(helper.title, 'Helper');
    assert.equal(helper.cwd, child);
    assert.ok(helper.x >= parent.x + parent.w, 'The new terminal opens to the right of its parent.');
    const arrows = await h.page.evaluate(() => workspace.items.filter(item => item.type === 'line'));
    assert.deepEqual(arrows.map(({ start, end, arrow }) => ({ start, end, arrow })), [{ start: { id: parent.id }, end: { id: helper.id }, arrow: true }]);
    await until(async () => hasOutputLine(await h.output(helper.id), 'CHILD_STARTED_OK'), 'The requested terminal did not run its command.');
    assert.equal((await h.state()).host.running, 2);
    await screenshot(h.page, 'agent-launch');

    // The caller learns the new card's ID and can follow its output, through to its exit code.
    const report = path.join(project, 'report.json');
    await input(h.page, parent.id, `& $env:TC_HOOK new-terminal --title Logged --command 'Write-Output LOGGED_LINE; exit 5' --log --json | Set-Content -LiteralPath ${psQuote(report)}\r`);
    const answer = await until(async () => JSON.parse(await fs.readFile(report, 'utf8').catch(() => 'null')), 'tc-hook did not report the opened terminal.');
    const logged = (await h.page.evaluate(() => workspace.cards))[2];
    assert.equal(answer.status, 'opened', JSON.stringify(answer));
    assert.equal(answer.card, logged.id);
    assert.equal(answer.parent, parent.id);
    const text = await until(async () => {
        const log = await fs.readFile(answer.log, 'utf8').catch(() => '');
        return log.includes('exited with code 5') && log;
    }, 'The output log did not record the exit.');
    assert.match(text, /^LOGGED_LINE$/m);
    assert.match(text, /\[Terminal Canvas: the process exited with code 5\]\n$/);

    // A refused request reports a non-zero exit and opens nothing.
    await input(h.page, parent.id, `& $env:TC_HOOK new-terminal --cwd ${psQuote('missing folder')}; Write-Output "REFUSED_EXIT=$LASTEXITCODE"\r`);
    await until(async () => hasOutputLine(await h.output(parent.id), 'REFUSED_EXIT=2'), 'A missing folder was not refused.');
    assert.equal(await h.page.evaluate(() => workspace.cards.length), 3);
});

const target = process.env.CARGO_TARGET_DIR || path.join(root, 'target');
const hook = path.resolve(root, target, 'debug/tc-hook.exe');
// Runs tc-hook as a program outside the canvas would, against the isolated test profile.
async function outsideHook(args, cwd) {
    const env = { ...process.env, TERMINAL_CANVAS_DATA: path.join(root, '.cache', 'tauri-smoke-profile') };
    for (const name of ['TC_LAUNCH_DIR', 'TC_CARD_ID', 'TC_HOOK']) delete env[name];
    try {
        const { stdout } = await promisify(execFile)(hook, ['new-terminal', '--json', ...args], { cwd, env });
        return JSON.parse(stdout);
    } catch (error) { return JSON.parse(error.stdout || '{}'); }
}

test('Command Prompt cards and programs outside the canvas open terminals too', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const project = await fs.mkdtemp(path.join(root, '.cache', 'tauri-launch-outside-'));
    await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
    const cmd = await startTerminal(h.page, { title: 'Command Prompt', cwd: project, command: 'cmd.exe' });
    await until(async () => (await h.output(cmd.id)).includes('>'), 'cmd did not show a prompt.');
    await input(h.page, cmd.id, `"%TC_HOOK%" new-terminal --title "From cmd" --command "Write-Output CMD_CHILD_OK" & echo CMD_EXIT=%ERRORLEVEL%\r`);
    await until(async () => (await h.page.evaluate(() => workspace.cards.length)) === 2, async () => `cmd could not open a terminal:
${await h.output(cmd.id)}`);
    const fromCmd = (await h.page.evaluate(() => workspace.cards))[1];
    await until(async () => hasOutputLine(await h.output(fromCmd.id), 'CMD_CHILD_OK'), 'The terminal opened from cmd did not run.');
    assert.deepEqual(await h.page.evaluate(() => workspace.items.map(({ start, end }) => ({ start, end }))), [{ start: { id: cmd.id }, end: { id: fromCmd.id } }]);

    // A harness outside the canvas, naming a parent from TC_CARD_ID, gets the arrow too.
    const named = await outsideHook(['--title', 'Outside child', '--parent', cmd.id, '--command', 'Write-Output OUTSIDE_CHILD_OK'], project);
    assert.equal(named.status, 'opened', JSON.stringify(named));
    assert.equal(named.via, 'app');
    await until(async () => (await h.page.evaluate(() => workspace.cards.length)) === 3, 'The outside request with a parent did not open.');
    const child = (await h.page.evaluate(() => workspace.cards))[2];
    assert.equal(named.card, child.id);
    await until(async () => hasOutputLine(await h.output(child.id), 'OUTSIDE_CHILD_OK'), 'The outside child did not run.');
    assert.equal((await h.page.evaluate(() => workspace.items)).filter(item => item.end.id === child.id && item.start.id === cmd.id).length, 1);

    // Without a parent, it opens on its own with no arrow.
    const alone = await outsideHook(['--title', 'Standalone'], project);
    assert.equal(alone.status, 'opened', JSON.stringify(alone));
    await until(async () => (await h.page.evaluate(() => workspace.cards.length)) === 4, 'The standalone request did not open.');
    const standalone = (await h.page.evaluate(() => workspace.cards))[3];
    assert.equal(standalone.title, 'Standalone');
    assert.equal((await h.page.evaluate(() => workspace.items)).some(item => item.end.id === standalone.id), false);
    assert.equal((await h.state()).host.running, 4);
    await screenshot(h.page, 'agent-launch-outside');
});
