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
    assert.deepEqual(launches[0][1], ['-NoLogo']);
    assert.equal(launches[0][2].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launches[0][2].env.SAMPLE, 'yes');
    assert.equal(launches[0][2].cwd, process.cwd());
});
test('uses Windows PowerShell from SystemRoot for a plain terminal', () => {
    const { manager, launches, processes } = harness({ env: { SystemRoot: 'D:\\Windows', ComSpec: 'cmd.exe' } });
    const result = manager.start(createCard());
    assert.equal(result.shell, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(launches[0][0], result.shell);
    assert.deepEqual(launches[0][1], ['-NoLogo']);
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
    assert.deepEqual(events.filter(e => e.type === 'data').map(e => e.id), [a.id, b.id]);
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
    assert.equal(manager.sessions.size, 1); assert.equal(events.filter(e => e.type !== 'metadata').length, 1);
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

const savedSession = { provider: 'codex', sessionId: '12345678-1234-4321-9876-123456789abc', cwd: process.cwd() };
const metadataEvent = event => '\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07';
test('resume uses only the saved provider, ID and session directory, never the configured command', () => {
    for (const provider of ['codex', 'claude']) {
        const { manager, launches, processes } = harness();
        const card = { ...createCard({ command: 'echo do-not-rerun' }), session: { ...savedSession, provider } };
        manager.start(card, 80, 24, 'resume');
        assert.equal(launches[0][2].cwd, savedSession.cwd);
        assert.deepEqual(processes[0].writes, [(provider === 'codex' ? 'codex resume ' : 'claude --resume ') + savedSession.sessionId + '\r']);
        manager.stopAll();
    }
});

test('fresh shell never reruns a command and falls back from a missing folder without discarding the AI ID', () => {
    const { manager, processes, launches } = harness();
    const card = { ...createCard({ cwd: __filename, command: 'claude' }), session: savedSession };
    manager.start(card, 80, 24, 'fresh');
    assert.deepEqual(processes[0].writes, []);
    assert.equal(launches[0][2].cwd, process.cwd());
    assert.deepEqual(manager.snapshot().get(card.id).session, savedSession);
    manager.stopAll();
});

test('missing or unavailable saved sessions leave the workspace and ID available for retry', () => {
    const { manager, launches } = harness();
    assert.throws(() => manager.start(createCard(), 80, 24, 'resume'), /No valid saved session/);
    const card = { ...createCard(), session: { ...savedSession, cwd: __filename } };
    assert.throws(() => manager.start(card, 80, 24, 'resume'), /unavailable/);
    assert.equal(launches.length, 0);
    assert.equal(card.session.sessionId, savedSession.sessionId);
});

test('manual launches in two shells keep their IDs and directories separate; failed resume retains metadata', () => {
    const { manager, processes, events } = harness();
    const a = { ...createCard(), session: savedSession }, b = createCard();
    manager.start(a, 80, 24, 'resume'); manager.start(b);
    const token = '87654321-4321-4321-9876-123456789abc';
    processes[0].data(metadataEvent({ type: 'launch', token, provider: 'codex', cwd: process.cwd() }));
    processes[0].data(metadataEvent({ type: 'end', token, exitCode: 1 }));
    assert.deepEqual(manager.snapshot().get(a.id).session, savedSession);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
    processes[1].data(metadataEvent({ type: 'launch', token, provider: 'claude', cwd: '/other', sessionId: token }));
    assert.equal(manager.snapshot().get(b.id).session.provider, 'claude');
    assert.equal(manager.snapshot().get(b.id).session.cwd, '/other');
    assert.deepEqual(manager.snapshot().get(a.id).session, savedSession);
    manager.stopAll();
});

test('shutdown snapshots read the final hook update and reject another launch token', t => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-manager-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const file = path.join(folder, 'metadata.json');
    let cleaned = 0;
    const { manager, processes } = harness({ integration: () => ({ sessionFile: file, env: {}, cleanup() { cleaned++; } }) });
    const card = createCard(); manager.start(card);
    const token = savedSession.sessionId;
    processes[0].data(metadataEvent({ type: 'launch', provider: 'claude', token, cwd: process.cwd() }));
    fs.writeFileSync(file, JSON.stringify({ ...savedSession, provider: 'claude', token: 'different-launch' }));
    assert.equal(manager.snapshot().get(card.id).session, null);
    fs.writeFileSync(file, JSON.stringify({ ...savedSession, provider: 'claude', token }));
    manager.stopAll();
    assert.equal(manager.snapshot().get(card.id).session.provider, 'claude');
    assert.equal(cleaned, 1);
    assert.equal(manager.sessions.size, 0);
});
