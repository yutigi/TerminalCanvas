const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createWorkspace, createCard, validateWorkspace } = require('../src/workspace.cjs');
const { MetadataParser } = require('../src/session-metadata.cjs');
const { WorkspaceRecovery } = require('../src/workspace-recovery.cjs');
const { recordSession } = require('../src/session-hook.cjs');
const { prepareIntegration, powershellSource, bashSource } = require('../src/shell-integration.cjs');

const id = '12345678-1234-4321-9876-123456789abc';
const nextId = 'abcdef01-1234-4321-9876-123456789abc';
const session = (provider = 'codex', sessionId = id, cwd = process.cwd()) => ({ provider, sessionId, cwd });
const osc = event => '\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07';
function temporary(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-recovery-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    return folder;
}

test('round trips allowlisted session fields and drops invalid optional metadata without losing board items', () => {
    const board = createWorkspace();
    board.cards.push({ ...createCard(), session: { ...session(), token: 'secret', transcript: 'private contents' } });
    board.items.push({ id: 'note', type: 'note', x: 0, y: 0, w: 200, h: 100, text: 'Keep this' });
    assert.deepEqual(validateWorkspace(board).cards[0].session, session());
    for (const invalid of [null, {}, session('unknown'), session('codex', [id]), session('codex', '$(bad)'), session('claude', id, 'bad\npath'), session('codex', 'a'.repeat(200))]) {
        board.cards[0].session = invalid;
        const restored = validateWorkspace(board);
        assert.equal(restored.cards.length, 1);
        assert.equal(restored.cards[0].session, undefined);
        assert.equal(restored.items[0].text, 'Keep this');
    }
});

test('metadata parser handles character-split OSC, ANSI, cwd changes, and tool switches in stream order', () => {
    const updates = [], launches = [], ends = [];
    const parser = new MetadataParser({ cwd: '/old', platform: 'linux', onChange: p => updates.push(p), onLaunch: e => launches.push(e), onEnd: e => ends.push(e) });
    const token = randomUUID();
    const stream = '\x1b]7;file://localhost/new%20folder\x1b\\'
        + osc({ type: 'launch', provider: 'codex', token, cwd: '/new folder' })
        + `session id: \x1b[32m${id}\x1b[0m\n`
        + osc({ type: 'end', token, exitCode: 0 })
        + osc({ type: 'launch', provider: 'claude', token: randomUUID(), cwd: '/other', sessionId: nextId });
    for (const char of stream) parser.feed(char);
    assert.equal(updates.find(p => p.cwd)?.cwd, '/new folder');
    assert.deepEqual(updates.filter(p => p.session).map(p => p.session), [session('codex', id, '/new folder'), session('claude', nextId, '/other')]);
    assert.equal(launches.length, 2); assert.equal(ends.length, 1);
    parser.feed('ordinary output\n');
    assert.equal(updates.filter(p => p.session).length, 2, 'old IDs must not reappear after another session starts');
});

test('terminal output cannot replace a saved session without a matching active tool launch', () => {
    const updates = [];
    // Even a Codex profile is not evidence that Codex is currently running.
    const parser = new MetadataParser({ cwd: '/project', provider: 'codex', platform: 'linux', onChange: p => updates.push(p) });
    parser.feed(`a random UUID ${id}\n`);
    parser.feed('\x1b]7;file://remote/private\x07');
    parser.feed(`Example: codex resume ${id}\nclaude --resume ${nextId}\nsession id: ${id}\n`);
    parser.feed(`To continue this session, run codex resume ${id}\n`);
    assert.deepEqual(updates, []);
    parser.feed(osc({ type: 'launch', provider: 'claude', token: id, sessionId: id, cwd: '/project' }));
    parser.feed(`To continue this session, run codex resume ${nextId}\nclaude --resume ${nextId}\n`);
    assert.deepEqual(updates.filter(p => p.session), [{ cwd: '/project', session: session('claude', id, '/project') }]);
    parser.feed('\x1b]633;TC;not-json\x07');
    parser.feed('x'.repeat(100000));
    assert.ok(parser.buffer.length <= 32768 && parser.text.length <= 4096);
});

test('Codex captures only its own session headers and exit hints between matching launch and end events', () => {
    const updates = [], ends = [];
    const parser = new MetadataParser({ cwd: '/project', onChange: p => updates.push(p), onEnd: e => ends.push(e) });
    parser.feed(osc({ type: 'end', exitCode: 1 }));
    assert.equal(ends.length, 0);
    parser.feed(osc({ type: 'launch', provider: 'codex', token: id, cwd: '/project' }));
    parser.feed(`Example: codex resume ${nextId}\nThe docs say session id: ${nextId}\nclaude --resume ${nextId}\n`);
    assert.deepEqual(updates.filter(p => p.session), []);
    for (const char of `session id: ${id}\n`) parser.feed(char);
    // An end event for a different launch must not deactivate the current tool.
    parser.feed(osc({ type: 'end', token: nextId, exitCode: 0 }));
    for (const char of `To continue this session, run codex resume ${nextId}\n`) parser.feed(char);
    assert.deepEqual(updates.filter(p => p.session).map(p => p.session), [session('codex', id, '/project'), session('codex', nextId, '/project')]);
    parser.feed(osc({ type: 'end', token: id, exitCode: 0 }));
    assert.equal(ends.length, 1);
    parser.feed(`session id: ${id}\nTo continue this session, run codex resume ${id}\n`);
    assert.equal(updates.filter(p => p.session).length, 2, 'shell output after the tool exits must not replace its ID');
});

test('recovery persists host metadata immediately and stale renderer autosaves cannot overwrite it', async () => {
    const writes = [];
    const recovery = new WorkspaceRecovery({ save: async board => writes.push(structuredClone(board)) });
    const board = createWorkspace(); board.cards.push(createCard());
    recovery.reset(board);
    recovery.update(board.cards[0].id, { cwd: '/latest', session: session('claude') });
    await recovery.pending;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].cards[0].cwd, '/latest');
    const stale = structuredClone(board); stale.cards[0].x = 900;
    await recovery.flush(stale);
    assert.equal(writes.at(-1).cards[0].x, 900);
    assert.deepEqual(writes.at(-1).cards[0].session, session('claude'));
    const reopened = validateWorkspace(JSON.parse(JSON.stringify(writes.at(-1))));
    assert.equal(reopened.cards[0].cwd, '/latest');
    assert.deepEqual(reopened.cards[0].session, session('claude'));
});

test('workspace replacement and deleted cards reject late metadata; failed persistence can be retried', async () => {
    let fail = true;
    const errors = [], writes = [];
    const recovery = new WorkspaceRecovery({ save: async board => { if (fail) throw new Error('disk full'); writes.push(structuredClone(board)); }, onError: e => errors.push(e.message) });
    const board = createWorkspace(); const card = createCard(); board.cards.push(card); recovery.reset(board);
    recovery.update(card.id, { cwd: '/latest', session: session() });
    await recovery.pending;
    assert.deepEqual(errors, ['disk full']);
    fail = false; await recovery.flush();
    assert.deepEqual(writes[0].cards[0].session, session());
    recovery.reset(createWorkspace()); recovery.update(card.id, { cwd: '/wrong', session: session() });
    await recovery.flush();
    assert.deepEqual(writes.at(-1).cards, []);
});

test('Claude hooks write only metadata atomically, including ID changes, and ignore unrelated or malformed events', t => {
    const folder = temporary(t);
    const file = path.join(folder, 'session.json');
    const env = { TC_SESSION_FILE: file, TC_LAUNCH_TOKEN: randomUUID() };
    const input = { hook_event_name: 'SessionStart', session_id: id, cwd: process.cwd(), transcript_path: '/private', secret: 'credential' };
    assert.equal(recordSession(input, 'claude', env), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...session('claude'), token: env.TC_LAUNCH_TOKEN });
    assert.equal(recordSession({ ...input, session_id: nextId }, 'claude', env), true);
    assert.equal(JSON.parse(fs.readFileSync(file)).sessionId, nextId);
    assert.equal(recordSession({ ...input, hook_event_name: 'SubagentStart' }, 'claude', env), false);
    assert.equal(recordSession({ ...input, session_id: 'bad' }, 'claude', env), false);
    assert.deepEqual(fs.readdirSync(folder), ['session.json']);
});

const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
const launcher = path.join(__dirname, '..', 'src', 'agent-launcher.cjs');
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'PATH';

test('integration files are per terminal, shims are shared, and every shell finds the AI CLIs', t => {
    const folder = temporary(t);
    const a = prepareIntegration({ folder, platform: 'win32', shell: 'powershell.exe' });
    const b = prepareIntegration({ folder, platform: 'linux', shell: '/bin/zsh' });
    const c = prepareIntegration({ folder, platform: 'win32', shell: 'C:\Windows\System32\cmd.exe' });
    const d = prepareIntegration({ folder, platform: 'linux', shell: '/usr/bin/fish' });
    const e = prepareIntegration({ folder, platform: 'linux', shell: '/usr/bin/nu' });
    assert.notEqual(a.sessionFile, b.sessionFile);
    assert.ok(a.args.includes('-EncodedCommand'));
    assert.equal(a.args[a.args.indexOf('-ExecutionPolicy') + 1], 'RemoteSigned');
    assert.deepEqual(b.args, ['-l', '-i']);
    assert.match(b.command, /^source '.+\.zsh'$/);
    assert.match(d.command, /^source '.+\.fish'$/);
    // Shells without a script still get the shims through PATH and keep their default arguments.
    for (const plain of [c, e]) { assert.equal(plain.args, undefined); assert.equal(plain.command, undefined); }
    const bin = path.join(folder, 'bin');
    for (const integration of [a, b, c, d, e]) assert.equal(integration.pathPrepend, bin);
    assert.deepEqual(fs.readdirSync(bin).sort(), ['claude', 'claude.cmd', 'codex', 'codex.cmd', 'gemini', 'gemini.cmd']);
    assert.ok(!JSON.stringify(a.env).includes('API_KEY'));
    for (const integration of [a, b, c, d, e]) integration.cleanup();
    assert.deepEqual(fs.readdirSync(folder), ['bin']);
});

test('real Windows PowerShell detects AI launches, passes arguments natively, and leaves other commands alone', { skip: process.platform !== 'win32' }, t => {
    const folder = temporary(t);
    const tools = path.join(folder, 'tools');
    fs.mkdirSync(tools);
    const fake = path.join(tools, 'fake.cjs');
    fs.writeFileSync(fake, "console.log('ARGS:' + JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.FAKE_EXIT || 0);\n");
    for (const name of ['claude', 'codex', 'gemini']) fs.writeFileSync(path.join(tools, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
    const integration = prepareIntegration({ folder, platform: 'win32', shell: 'powershell.exe', executable: process.execPath });
    t.after(() => integration.cleanup());
    const source = powershellSource(integration.pathPrepend) + `
claude
claude --resume ${id} --name 'name with spaces'
claude update
Write-Output ('UPDATE_EXIT=' + $LASTEXITCODE)
gemini
codex login
cmd /c echo PLAIN_COMMAND
Write-Output ('RUN_AS_NODE=' + [bool]$env:ELECTRON_RUN_AS_NODE)
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        // These tests may themselves run inside a tracked Terminal Canvas session.
        env: { ...process.env, TC_LAUNCH_TOKEN: '', ...integration.env, [pathKey]: tools + path.delimiter + process.env[pathKey], FAKE_EXIT: '5' }, encoding: 'utf8', timeout: 30000, windowsHide: true
    });
    const launches = [];
    new MetadataParser({ cwd: folder, onChange() {}, onLaunch: e => launches.push(e) }).feed(result.stdout);
    assert.deepEqual(launches.map(e => e.provider), ['claude', 'claude', 'gemini'], result.stdout + result.stderr);
    assert.match(launches[0].sessionId, /^[a-f0-9-]{36}$/);
    assert.equal(launches[1].sessionId, id);
    const calls = [...result.stdout.matchAll(/ARGS:(.*)/g)].map(match => JSON.parse(match[1]));
    assert.deepEqual(calls[1], ['--resume', id, '--name', 'name with spaces', '--settings', integration.env.TC_SETTINGS]);
    assert.deepEqual(calls[2], ['update']);
    assert.deepEqual(calls[3], []);
    assert.deepEqual(calls[4], ['login']);
    assert.match(result.stdout, /UPDATE_EXIT=5/);
    assert.match(result.stdout, /PLAIN_COMMAND/);
    assert.match(result.stdout, /RUN_AS_NODE=False/);
});

test('the Windows Claude hook decodes Unicode directories as UTF-8', { skip: process.platform !== 'win32' }, t => {
    const folder = temporary(t);
    const integration = prepareIntegration({ folder, platform: 'win32', shell: 'powershell.exe' });
    t.after(() => integration.cleanup());
    const settingsFile = fs.readdirSync(folder).find(file => file.endsWith('.settings.json'));
    const settings = JSON.parse(fs.readFileSync(path.join(folder, settingsFile), 'utf8'));
    const cwd = path.join(folder, 'ไทย', '工作', '🚀');
    fs.mkdirSync(cwd, { recursive: true });
    const result = spawnSync(settings.hooks.SessionStart[0].hooks[0].command, {
        shell: true, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: id, cwd }),
        encoding: 'utf8', env: { ...process.env, ...integration.env, TC_LAUNCH_TOKEN: nextId }, windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(integration.sessionFile, 'utf8')), { ...session('claude', id, cwd), token: nextId });
});

for (const executable of ['powershell.exe', 'pwsh.exe']) {
    test(`${executable} AI integration preserves strict-mode custom prompts and native exit codes`, { skip: process.platform !== 'win32' }, t => {
        const source = `Set-StrictMode -Version Latest
            $ErrorActionPreference = 'Stop'
            $ProgressPreference = 'SilentlyContinue'
            Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore
            function global:prompt { "CUSTOM:$?>" }
            ${powershellSource('unused-settings.json')}
            Write-Error 'expected failure' -ErrorAction SilentlyContinue
            $result = prompt
            Write-Output ('RESULT=' + $result + ';EXISTS=' + ($null -ne (Get-Variable LASTEXITCODE -Scope Global -ErrorAction Ignore)))
            $global:LASTEXITCODE = 37
            Write-Error 'expected failure' -ErrorAction SilentlyContinue
            $result = prompt
            Write-Output ('RESULT2=' + $result + ';LAST=' + $global:LASTEXITCODE)`;
        const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
            encoding: 'utf8', windowsHide: true, timeout: 15000
        });
        if (executable === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed.');
        assert.equal(result.status, 0, result.error?.message || result.stderr);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /RESULT=CUSTOM:False>;EXISTS=False/);
        assert.match(result.stdout, /RESULT2=CUSTOM:False>;LAST=37/);
    });
}

test('integrated Bash loads login profiles first, then keeps the shims ahead of profile PATH changes', { skip: !fs.existsSync(bash) }, t => {
    const folder = temporary(t);
    fs.writeFileSync(path.join(folder, '.bash_profile'), 'export TC_REVIEW_LOGIN=profile-loaded\n. "$HOME/.bashrc"\n');
    fs.writeFileSync(path.join(folder, '.bashrc'), 'TC_RC_COUNT=$(( ${TC_RC_COUNT:-0} + 1 ))\nPROMPT_COMMAND=(":" "true")\nexport PATH="/profile/bin:$PATH"\n');
    const integration = prepareIntegration({ folder, platform: 'linux', shell: '/bin/bash' });
    t.after(() => integration.cleanup());
    assert.equal(typeof integration.command, 'string');
    const result = spawnSync(bash, [...integration.args, '-c', `${integration.command}\nprintf 'login=%s rc=%s\\n' "$TC_REVIEW_LOGIN" "$TC_RC_COUNT"\nprintf 'prompt=%s\\n' "\${PROMPT_COMMAND[*]}"\n[[ $PATH == "$TC_SHIM_DIR":/profile/bin:* ]] && echo shims-first\n`], {
        env: { ...process.env, ...integration.env, HOME: folder }, encoding: 'utf8', windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /login=profile-loaded rc=1/);
    assert.match(result.stdout, /prompt=__tc_cwd : true/);
    assert.match(result.stdout, /shims-first/);
});

for (const [shell, rc] of [['zsh', '.zshrc'], ['fish', '.config/fish/config.fish']]) {
    const executable = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map(dir => path.join(dir, shell)).find(file => fs.existsSync(file));
    test(`integrated ${shell} keeps the shims ahead of profile PATH changes and runs AI CLIs through them`, { skip: process.platform === 'win32' || !executable }, t => {
        const folder = temporary(t);
        fs.mkdirSync(path.dirname(path.join(folder, rc)), { recursive: true });
        fs.writeFileSync(path.join(folder, rc), shell === 'fish' ? 'set -gx PATH /profile/bin $PATH\n' : 'export PATH="/profile/bin:$PATH"\n');
        const tools = path.join(folder, 'tools');
        fs.mkdirSync(tools);
        fs.writeFileSync(path.join(tools, 'claude'), '#!/bin/sh\necho "ARGS=$*"\nexit 6\n', { mode: 0o755 });
        const integration = prepareIntegration({ folder, platform: process.platform, shell: executable, executable: process.execPath });
        t.after(() => integration.cleanup());
        const result = spawnSync(executable, [...integration.args, '-c', `${integration.command}; claude update; echo "EXIT=${shell === 'fish' ? '$status' : '$?'}"`], {
            env: { ...process.env, TC_LAUNCH_TOKEN: '', ...integration.env, HOME: folder, ZDOTDIR: folder, PATH: `${integration.pathPrepend}:${tools}:${process.env.PATH}` },
            encoding: 'utf8', timeout: 15000
        });
        assert.match(result.stdout, /ARGS=update\n/, result.stderr);
        assert.match(result.stdout, /EXIT=6/);
        assert.ok(!result.stdout.includes('633;TC'), result.stdout);
    });
}

test('Gemini sessions are captured from the resume hint it prints on exit, quoted or not', () => {
    for (const hint of [`To resume this session: gemini --resume ${id}`, `To resume this session: gemini --resume "${id}"`]) {
        const updates = [];
        const parser = new MetadataParser({ cwd: '/work', platform: 'linux', onChange: p => updates.push(p) });
        parser.feed(`gemini --resume ${nextId}\r\n`);
        assert.equal(updates.length, 0, 'output before a Gemini launch is ignored');
        parser.feed(osc({ type: 'launch', provider: 'gemini', token: nextId, cwd: '/work', sessionId: null }));
        parser.feed(`\x1b[2mAgent powering down.\x1b[0m\r\n  ${hint}\r\n`);
        assert.deepEqual(updates.at(-1).session, { provider: 'gemini', sessionId: id, cwd: '/work' });
    }
});
