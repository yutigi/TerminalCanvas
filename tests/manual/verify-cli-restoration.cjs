/* Verify a manual run's files/processes. Native UI observations and exit codes are separate. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const folder = path.join(root, '.cache/native-cli-check');
const phase = process.argv[2];
const counts = { capture: [2, 2], reopen: [2, 2], resume: [4, 4], fresh: [4, 6], closed: [4, 6] };
assert.ok(Object.hasOwn(counts, phase), 'Choose capture, reopen, resume, fresh, or closed.');
const setup = JSON.parse(fs.readFileSync(path.join(folder, 'setup.json')));
const calls = fs.readFileSync(setup.log, 'utf8').trim().split('\n').map(JSON.parse);
const shells = fs.readFileSync(setup.shellLog, 'utf8').trim().split('\n').map(line => ({
    pid: Number(line.slice(0, line.indexOf('\t'))), cwd: line.slice(line.indexOf('\t') + 1),
}));
const raw = fs.readFileSync(path.join(setup.profile, 'workspace.terminalcanvas'), 'utf8');
const board = JSON.parse(raw);
assert.equal(calls.length, counts[phase][0], 'Unexpected provider invocation count.');
assert.equal(shells.length, counts[phase][1], 'Unexpected shell start count.');
assert.equal(board.cards.length, 2);
assert.ok(shells.every(shell => shell.cwd === setup.project));
assert.ok(!raw.includes('MUST_NOT_BE_SAVED'), 'Private hook input reached the workspace.');
for (const provider of ['claude', 'codex']) {
    const call = calls.find(call => call.provider === provider && call.phase === 'capture');
    const card = board.cards.find(card => card.profile === provider);
    assert.ok(call && card?.session, 'Both initial launches must capture a session.');
    assert.equal(call.cwd, setup.project);
    assert.equal(card.session.cwd, setup.project);
    // The legacy validator canonicalizes UUID case too.
    assert.equal(card.session.sessionId, call.sessionId.toLowerCase());
    if (provider === 'claude') assert.equal(call.hookExitCode, 0);
}
if (phase === 'capture') {
    fs.writeFileSync(path.join(folder, 'captured.json'), JSON.stringify({ board, calls }, null, 2) + '\n');
} else {
    const captured = JSON.parse(fs.readFileSync(path.join(folder, 'captured.json')));
    assert.deepEqual(board.cards.map(card => card.session), captured.board.cards.map(card => card.session));
    if (calls.length === 4) {
        const resumed = calls.filter(call => call.phase === 'resume');
        assert.equal(resumed.length, 2);
        for (const call of resumed) {
            const session = captured.board.cards.find(card => card.profile === call.provider).session;
            assert.equal(call.cwd, session.cwd);
            assert.equal(call.sessionId, session.sessionId);
            assert.deepEqual(call.args.slice(0, 2), call.provider === 'claude'
                ? ['--resume', session.sessionId] : ['resume', session.sessionId]);
        }
    }
}
const ended = phase === 'closed' ? shells : phase === 'fresh' ? shells.slice(0, 4)
    : phase === 'capture' ? [] : shells.slice(0, 2);
for (const shell of ended) {
    assert.throws(() => process.kill(shell.pid, 0), error => error.code === 'ESRCH', `Shell ${shell.pid} survived Stop/close.`);
}
const result = { phase, checks: 'passed', scope: 'Files and observed shell PIDs; UI behavior and host exit codes are separate.',
    invocations: calls.length, shellStarts: shells.length, endedShells: ended.length,
    sessions: board.cards.map(card => ({ provider: card.session.provider, sessionId: card.session.sessionId })) };
fs.writeFileSync(path.join(folder, 'verified-' + phase + '.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
