const test = require('node:test');
const assert = require('node:assert/strict');
const { TerminalManager } = require('../src/terminal-manager.cjs');
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
    const manager = new TerminalManager({ spawn, emit: e => events.push(e), platform: 'win32', home: process.cwd(), watchCwd: () => ({ dispose() {} }), env: { SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', ELECTRON_RUN_AS_NODE: '1', SAMPLE: 'yes' }, ...options });
    return { manager, events, processes, launches };
}
test('does not launch anything until explicitly started; sends selected command once', () => {
    const { manager, launches, processes } = harness();
    const card = createCard({ profile: 'codex' });
    assert.equal(launches.length, 0);
    manager.start(card, 100, 30);
    assert.deepEqual(processes[0].writes, ['codex\r']);
    assert.equal(launches[0][0], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(launches[0][1].slice(0, 5), ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand']);
    assert.equal(launches[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launches[0][2].env.SAMPLE, 'yes');
    assert.equal(launches[0][2].cwd, process.cwd());
});
test('uses Windows PowerShell from SystemRoot for a plain terminal', () => {
    const { manager, launches, processes } = harness({ env: { SystemRoot: 'D:\\Windows', ComSpec: 'cmd.exe' } });
    const result = manager.start(createCard());
    assert.equal(result.shell, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(launches[0][0], result.shell);
    assert.deepEqual(launches[0][1].slice(0, 5), ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand']);
    assert.deepEqual(processes[0].writes, []);
});

test('falls back to the standard Windows PowerShell path without SystemRoot', () => {
    const { manager } = harness({ env: {} });
    assert.equal(manager.start(createCard()).shell, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('allows local scripts such as npm.ps1 in PowerShell cards and plain PowerShell launchers', () => {
    for (const command of ['', 'powershell', 'pwsh.exe']) {
        const { manager, launches } = harness();
        manager.start(createCard({ command }));
        const args = launches[0][1];
        assert.equal(args[args.indexOf('-ExecutionPolicy') + 1], 'RemoteSigned');
    }
    const { manager, launches } = harness();
    manager.start(createCard({ command: 'cmd.exe' }));
    assert.equal(launches[0][1].includes('-ExecutionPolicy'), false);
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

test('reports split prompt metadata independently without changing PTY bytes or input', () => {
    const { manager, processes, events } = harness();
    const a = createCard(), b = createCard(); manager.start(a); manager.start(b);
    const chunks = ['output\x1b]9;', '9;D:\\A folder\\子\x1b', '\\after'];
    chunks.forEach(chunk => processes[1].data(chunk));
    assert.deepEqual(events.filter(e => e.type === 'cwd'), [{ type: 'cwd', id: b.id, cwd: 'D:\\A folder\\子' }]);
    assert.deepEqual(events.filter(e => e.type === 'data').map(e => e.data), chunks);
    assert.equal(manager.sessions.get(b.id).pending, chunks.join('').length);
    processes[1].data('\x1b]9;9;\x07');
    assert.equal(events.at(-1).cwd, null);
    manager.write(a.id, 'cd "ignored input"\r');
    assert.deepEqual(processes[0].writes, ['cd "ignored input"\r']);
    assert.equal(events.filter(e => e.type === 'cwd').length, 2);
});

test('plain Windows shell launchers receive the matching integration', () => {
    for (const command of ['pwsh', 'powershell.exe', 'cmd.exe']) {
        const { manager, launches, processes } = harness();
        manager.start(createCard({ command }));
        assert.equal(launches[0][0], command === 'pwsh' ? 'pwsh.exe' : command);
        assert.equal(launches[0][2].env.PROMPT, '$E]9;9;$P$E\\$P$G');
        assert.deepEqual(processes[0].writes, []);
        assert.equal(launches[0][1].includes('-NoExit'), command !== 'cmd.exe');
    }
});

test('process lookups are scoped to sessions, disposed on exit, and ignored after restart', () => {
    const watchers = [];
    const { manager, processes, events } = harness({ platform: 'linux', watchCwd(pid, platform, report) {
        const watcher = { pid, platform, report, disposed: false, dispose() { this.disposed = true; } };
        watchers.push(watcher); return watcher;
    } });
    const a = createCard(), b = createCard(); manager.start(a); manager.start(b);
    watchers[1].report('/folder with spaces'); watchers[1].report('/folder with spaces');
    assert.deepEqual(events, [{ type: 'cwd', id: b.id, cwd: '/folder with spaces' }]);
    assert.equal(watchers[1].pid, processes[1].pid);
    processes[0].exit({ exitCode: 0 }); manager.start(a);
    watchers[0].report('/stale');
    assert.equal(events.filter(e => e.type === 'cwd').length, 1);
    assert.equal(watchers[0].disposed, true);
    manager.stopAll(); assert.ok(watchers.every(w => w.disposed));
});
