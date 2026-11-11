const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { plan, resolveExecutable } = require('../src/agent-launcher.cjs');
const { writeShims } = require('../src/shell-integration.cjs');
const { MetadataParser } = require('../src/session-metadata.cjs');

const id = '12345678-1234-4321-9876-123456789abc';
const env = { TC_SETTINGS: '/tc/settings.json' };
const windows = process.platform === 'win32';
const launcher = path.join(__dirname, '..', 'src', 'agent-launcher.cjs');
const tricky = ['a b', 'x&y', 'p|q', 'c^d', '%PATH%', 'bang!', 'q"uote', 'trail\\', '(paren)', '<lt>', "it's", 'two  spaces', 'ไทย 🚀'];

function temporary(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-launcher-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    return folder;
}
// Stand-in CLIs, installed the way npm installs real ones (a .cmd wrapper on Windows).
function fakeTools(folder) {
    const tools = path.join(folder, 'tools');
    fs.mkdirSync(tools);
    const fake = path.join(tools, 'fake.cjs');
    fs.writeFileSync(fake, `console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));
console.log('TOKEN:' + Boolean(process.env.TC_LAUNCH_TOKEN) + ' RUN_AS_NODE:' + Boolean(process.env.ELECTRON_RUN_AS_NODE));
process.exitCode = Number(process.env.FAKE_EXIT || 0);\n`);
    for (const name of ['claude', 'codex', 'gemini']) {
        if (windows) fs.writeFileSync(path.join(tools, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
        else fs.writeFileSync(path.join(tools, name), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    }
    return tools;
}
function launcherEnv(folder, tools, extra = {}) {
    const shims = writeShims(folder);
    const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    const base = { ...process.env };
    delete base.TC_LAUNCH_TOKEN;
    return { ...base, [key]: [shims, tools, process.env[key]].join(path.delimiter), TC_NODE: process.execPath, TC_LAUNCHER: launcher, TC_SHIM_DIR: shims, TC_SETTINGS: path.join(folder, 'settings.json'), ...extra };
}
function events(stdout) {
    const launches = [], ends = [];
    new MetadataParser({ cwd: process.cwd(), onChange() {}, onLaunch: e => launches.push(e), onEnd: e => ends.push(e) }).feed(stdout);
    return { launches, ends };
}
const argsOf = stdout => JSON.parse(/ARGS:(.*)/.exec(stdout)[1]);

test('management subcommands and info flags of every AI CLI pass through untouched', () => {
    const cases = [
        ['claude', ['update']], ['claude', ['attach', 'abc']], ['claude', ['mcp', 'list']], ['claude', ['ultrareview']],
        ['claude', ['--version']], ['claude', ['-p', 'hi', '--help']], ['claude', ['some-future-command']],
        ['codex', ['login']], ['codex', ['mcp', 'add', 'x']], ['codex', ['--version']], ['codex', ['completion', 'bash']],
        ['gemini', ['mcp', 'list']], ['gemini', ['extensions', 'install', 'x']], ['gemini', ['-v']]
    ];
    for (const [provider, args] of cases) assert.deepEqual(plan(provider, args, env), { track: false, args }, `${provider} ${args.join(' ')}`);
});

test('Claude session launches receive the hook settings and a session ID only when the user gave none', () => {
    const fresh = plan('claude', [], env);
    assert.equal(fresh.track, true);
    assert.match(fresh.sessionId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(fresh.args, ['--session-id', fresh.sessionId, '--settings', '/tc/settings.json']);
    assert.deepEqual(plan('claude', ['--resume', id.toUpperCase()], env), { track: true, args: ['--resume', id.toUpperCase(), '--settings', '/tc/settings.json'], sessionId: id });
    assert.deepEqual(plan('claude', ['--model', 'opus', 'fix the bug'], env).args, ['--model', 'opus', 'fix the bug', '--settings', '/tc/settings.json']);
    assert.deepEqual(plan('claude', ['--settings', 'mine.json'], env).args, ['--settings', 'mine.json']);
    assert.deepEqual(plan('claude', ['--settings=mine.json'], env).args, ['--settings=mine.json']);
    assert.deepEqual(plan('claude', ['fix the failing test'], env).args, ['fix the failing test', '--settings', '/tc/settings.json']);
});

test('Codex and Gemini sessions are tracked without adding any arguments', () => {
    assert.deepEqual(plan('codex', [], env), { track: true, args: [], sessionId: null });
    assert.deepEqual(plan('codex', ['resume', id], env), { track: true, args: ['resume', id], sessionId: id });
    assert.deepEqual(plan('codex', ['exec', 'fix it'], env), { track: true, args: ['exec', 'fix it'], sessionId: null });
    assert.deepEqual(plan('gemini', [], env), { track: true, args: [], sessionId: null });
    assert.deepEqual(plan('gemini', ['--resume=' + id], env), { track: true, args: ['--resume=' + id], sessionId: id });
    assert.deepEqual(plan('gemini', ['-r', id, '-m', 'x'], env), { track: true, args: ['-r', id, '-m', 'x'], sessionId: id });
});

test('launches from inside a tracked AI session and unknown programs are never tracked', () => {
    assert.deepEqual(plan('claude', [], { ...env, TC_LAUNCH_TOKEN: id }), { track: false, args: [] });
    assert.deepEqual(plan('aider', ['--yes'], env), { track: false, args: ['--yes'] });
});

test('executable lookup skips the Terminal Canvas shims', t => {
    const folder = temporary(t);
    const tools = fakeTools(folder);
    const shims = writeShims(folder);
    const found = resolveExecutable('claude', { PATH: [shims, tools].join(path.delimiter), PATHEXT: '.EXE;.CMD', TC_SHIM_DIR: shims });
    assert.equal(path.dirname(found), tools);
    assert.equal(resolveExecutable('missing-tool', { PATH: tools, TC_SHIM_DIR: shims }), null);
});

test('the launcher runs the real CLI with exact arguments and exit codes, reporting only session launches', t => {
    const folder = temporary(t);
    const tools = fakeTools(folder);
    const run = (args, extra) => spawnSync(process.execPath, [launcher, ...args], { env: launcherEnv(folder, tools, extra), encoding: 'utf8', timeout: 20000, windowsHide: true });

    const update = run(['claude', 'update'], { FAKE_EXIT: '3' });
    assert.equal(update.status, 3, update.stderr);
    assert.deepEqual(argsOf(update.stdout), ['update']);
    assert.match(update.stdout, /TOKEN:false RUN_AS_NODE:false/);
    assert.deepEqual(events(update.stdout).launches, []);

    const prompt = run(['claude', ...tricky]);
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.deepEqual(argsOf(prompt.stdout), [...tricky, '--settings', path.join(folder, 'settings.json')]);
    assert.match(prompt.stdout, /TOKEN:true RUN_AS_NODE:false/);
    const { launches, ends } = events(prompt.stdout);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].provider, 'claude');
    assert.deepEqual(ends.map(e => e.exitCode), [0]);

    const gemini = run(['gemini', '--resume', id], { FAKE_EXIT: '2' });
    assert.equal(gemini.status, 2);
    assert.deepEqual(argsOf(gemini.stdout), ['--resume', id]);
    assert.equal(events(gemini.stdout).launches[0].sessionId, id);
    assert.deepEqual(events(gemini.stdout).ends.map(e => e.exitCode), [2]);

    const missing = run(['codex'], { [Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH']: writeShims(folder) });
    assert.equal(missing.status, 127);
    assert.match(missing.stderr, /codex: command not found/);
});

test('cmd.exe reaches AI CLIs through the PATH shims like a normal command', { skip: !windows }, t => {
    const folder = temporary(t);
    const tools = fakeTools(folder);
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:on', '/s', '/c', '"codex login "a&b" & echo EXIT=!ERRORLEVEL! & claude"'], {
        windowsVerbatimArguments: true, env: launcherEnv(folder, tools, { FAKE_EXIT: '4' }), encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    const [login, claude] = result.stdout.split(/EXIT=/);
    assert.deepEqual(argsOf(login), ['login', 'a&b']);
    assert.match(claude, /^4/);
    assert.deepEqual(argsOf(claude).slice(0, 1), ['--session-id']);
    assert.equal(events(result.stdout).launches.length, 1);
});

test('POSIX shells reach AI CLIs through the PATH shims like a normal command', { skip: windows }, t => {
    const folder = temporary(t);
    const tools = fakeTools(folder);
    const result = spawnSync('/bin/sh', ['-c', 'codex login "a b"; echo "EXIT=$?"; command -v claude'], {
        env: launcherEnv(folder, tools, { FAKE_EXIT: '4' }), encoding: 'utf8', timeout: 20000
    });
    assert.deepEqual(argsOf(result.stdout), ['login', 'a b']);
    assert.match(result.stdout, /EXIT=4/);
    assert.equal(events(result.stdout).launches.length, 0);
});
