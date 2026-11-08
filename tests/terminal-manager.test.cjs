const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager } = require('../src/terminal-manager.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCard } = require('../src/workspace.cjs');

function harness(options = {}) {
    const events = [], processes = [], launches = [];
    const spawn = (...args) => {
        launches.push(args);
        const p = {
            pid: processes.length + 100, writes: [], sizes: [], pauses: 0, resumes: 0, killed: false, disposed: 0,
            onData(fn) { this.data = fn; return { dispose: () => this.disposed++ }; },
            onExit(fn) { this.exit = fn; return { dispose: () => this.disposed++ }; },
            write(data) { this.writes.push(data); }, resize(...size) { this.sizes.push(size); },
            pause() { this.pauses++; }, resume() { this.resumes++; }, kill() { this.killed = true; }
        };
        processes.push(p); return p;
    };
    const manager = new TerminalManager({ spawn, emit: e => events.push(e), platform: 'win32', home: process.cwd(), env: { SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', ELECTRON_RUN_AS_NODE: '1', SAMPLE: 'yes' }, ...options });
    return { manager, events, processes, launches };
}
test('does not launch anything until explicitly started; sends selected command once', () => {
    const { manager, launches, processes } = harness();
    const card = createCard({ profile: 'codex' });
    assert.equal(launches.length, 0);
    manager.start(card, 100, 30);
    assert.deepEqual(processes[0].writes, ['codex\r']);
    assert.equal(launches[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(launches[0][1].slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
    assert.match(Buffer.from(launches[0][1][3], 'base64').toString('utf16le'), /function global:prompt/);
    assert.equal(launches[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launches[0][2].env.SAMPLE, 'yes');
    assert.equal(launches[0][2].cwd, process.cwd());
});
test('uses Windows PowerShell from SystemRoot for a plain terminal', () => {
    const { manager, launches, processes } = harness({ env: { SystemRoot: 'D:\\Windows', ComSpec: 'cmd.exe' } });
    const result = manager.start(createCard());
    assert.equal(result.shell, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(launches[0][0], result.shell);
    assert.deepEqual(launches[0][1].slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
    assert.match(Buffer.from(launches[0][1][3], 'base64').toString('utf16le'), /function global:prompt/);
    assert.deepEqual(processes[0].writes, []);
});

test('falls back to the standard Windows PowerShell path without SystemRoot', () => {
    const { manager } = harness({ env: {} });
    assert.equal(manager.start(createCard()).shell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('preserves the configured login shell and Bash fallback on other platforms', () => {
    for (const env of [{ SHELL: '/bin/zsh' }, {}]) {
        const { manager, launches } = harness({ platform: 'linux', env });
        assert.equal(manager.start(createCard()).shell, env.SHELL || '/bin/bash');
        assert.deepEqual(launches[0][1], ['-l']);
    }
});

test('routes input and resize to the right PTY', () => {
    const { manager, processes, events } = harness();
    const a = createCard(), b = createCard(); manager.start(a); manager.start(b);
    manager.write(b.id, 'hello'); manager.resize(a.id, 120, 40);
    processes[0].data('first'); processes[1].data('second');
    assert.deepEqual(processes[0].writes, []);
    assert.deepEqual(processes[1].writes, ['hello']);
    assert.deepEqual(processes[0].sizes, [[120, 40]]);
    assert.deepEqual(events.map(e => e.id), [a.id, b.id]);
});
test('applies backpressure at high watermark and resumes after renderer acknowledgment', () => {
    const { manager, processes } = harness(); const card = createCard(); manager.start(card);
    processes[0].data('a'.repeat(260000)); processes[0].data('more');
    assert.equal(processes[0].pauses, 1);
    manager.acknowledge(card.id, 250000);
    assert.equal(processes[0].resumes, 1);
    manager.acknowledge(card.id, -10);
    assert.equal(manager.sessions.get(card.id).pending, 10004);
});
test('cleans exited sessions and ignores stale events after a restart', () => {
    const { manager, processes, events } = harness(); const card = createCard(); manager.start(card);
    const old = processes[0]; old.exit({ exitCode: 0 });
    assert.equal(manager.sessions.size, 0); assert.equal(old.disposed, 2);
    manager.start(card); old.data('stale'); old.exit({ exitCode: 1 });
    assert.equal(manager.sessions.size, 1); assert.equal(events.length, 1);
});
test('stop and app-wide cleanup dispose subscriptions and kill each child', () => {
    const { manager, processes } = harness(); const a = createCard(), b = createCard(); manager.start(a); manager.start(b);
    manager.stop(a.id); manager.stop(a.id); manager.stopAll();
    assert.equal(manager.sessions.size, 0);
    assert.ok(processes.every(p => p.killed && p.disposed === 2));
});
test('rejects duplicate starts, invalid dimensions, large input, and invalid folders', () => {
    const { manager } = harness(); const card = createCard(); manager.start(card);
    assert.throws(() => manager.start(card), /already running/);
    assert.throws(() => manager.resize(card.id, 0, 12), /dimensions/);
    assert.throws(() => manager.start(createCard(), 80.5, 24), /dimensions/);
    assert.throws(() => manager.write(card.id, 'a'.repeat(65537)), /64 KB/);
    assert.throws(() => manager.start(createCard({ cwd: __filename })), /folder/);
});
test('failed launch commands kill the just-created terminal', () => {
    const { manager, processes } = harness(); const originalSpawn = manager.spawn;
    manager.spawn = (...args) => { const p = originalSpawn(...args); p.write = () => { throw new Error('write failed'); }; return p; };
    assert.throws(() => manager.start(createCard({ command: 'echo hi' })), /write failed/);
    assert.equal(manager.sessions.size, 0); assert.equal(processes[0].killed, true);
});
function report(launch, cwd) {
    return `\x1b]777;tc-cwd;${launch[2].env.TERMINAL_CANVAS_CWD_TOKEN};${Buffer.from(cwd).toString('base64')}\x07`;
}
test('tracks changed directories per Windows session without sending commands or copying an AI process', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-directory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, 'nested space', "project's 日本語");
    fs.mkdirSync(nested, { recursive: true });
    const { manager, launches, processes, events } = harness({ home: root });
    const a = createCard({ profile: 'codex', cwd: root }), b = createCard({ cwd: root });
    manager.start(a); manager.start(b);
    processes[0].data(report(launches[0], root));
    assert.ok(manager.directory(a).warning, 'a queued AI launch must not reuse the startup prompt');
    processes[0].data(report(launches[0], nested));
    processes[1].data(report(launches[1], root));
    assert.equal(manager.directory(a).cwd, nested);
    assert.equal(manager.directory(b).cwd, root);
    const duplicate = createCard({ profile: 'shell', command: '', cwd: manager.directory(a).cwd });
    manager.start(duplicate);
    assert.equal(launches[2][2].cwd, nested);
    assert.notEqual(processes[2].pid, processes[0].pid);
    assert.deepEqual(processes[0].writes, ['codex\r']);
    assert.deepEqual(processes[2].writes, []);
    assert.deepEqual(events, [], 'directory metadata is not terminal output');
    manager.write(a.id, 'cd somewhere\r');
    assert.match(manager.directory(a).warning, /could not be determined/);
    processes[0].data(report(launches[0], root));
    assert.equal(manager.directory(a).warning, undefined);
    manager.stop(a.id);
    assert.match(manager.directory(a).warning, /stopped/);
    manager.start(a);
    assert.match(manager.directory(a).warning, /could not be determined/, 'restarts must not reuse a previous directory');
});

test('missing or non-filesystem current directories offer the launch folder then home for review', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fallback-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const launch = path.join(root, 'launch'), current = path.join(root, 'deleted directory');
    fs.mkdirSync(launch); fs.mkdirSync(current);
    const { manager, launches, processes } = harness({ home: root });
    const card = createCard({ cwd: launch }); manager.start(card);
    processes[0].data(report(launches[0], current));
    fs.rmdirSync(current);
    assert.equal(manager.directory(card).cwd, launch);
    assert.match(manager.directory(card).warning, /no longer available/);
    fs.rmdirSync(launch);
    assert.equal(manager.directory(card).cwd, root);
    processes[0].data(report(launches[0], ''));
    assert.match(manager.directory(card).warning, /could not be determined/);
});

test('Linux resolves the live shell process directory and unsupported platforms offer review', () => {
    const linux = harness({ platform: 'linux' });
    const card = createCard(); linux.manager.start(card);
    linux.processes[0].pid = process.pid;
    if (process.platform === 'linux') assert.equal(linux.manager.directory(card).cwd, process.cwd());
    else assert.ok(linux.manager.directory(card).warning);
    const mac = harness({ platform: 'darwin' }); mac.manager.start(card);
    assert.ok(mac.manager.directory(card).warning);
});
