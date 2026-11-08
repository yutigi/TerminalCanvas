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
const { prepareIntegration, powershellSource } = require('../src/shell-integration.cjs');

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

test('explicit resume hints detect manually launched tools without trusting arbitrary UUIDs or remote directories', () => {
    const updates = [];
    const parser = new MetadataParser({ cwd: '/project', platform: 'linux', onChange: p => updates.push(p) });
    parser.feed(`a random UUID ${id}\n`);
    parser.feed('\x1b]7;file://remote/private\x07');
    parser.feed(`To continue this session, run codex resume ${id}\nclaude --resume ${nextId}\n`);
    assert.deepEqual(updates, [{ session: session('codex', id, '/project') }, { session: session('claude', nextId, '/project') }]);
    parser.feed('\x1b]633;TC;not-json\x07');
    parser.feed('x'.repeat(100000));
    assert.ok(parser.buffer.length <= 32768 && parser.text.length <= 4096);
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

test('integration files are per terminal and preserve the shell fallback on unsupported shells', t => {
    const folder = temporary(t);
    const a = prepareIntegration({ folder, platform: 'win32', shell: 'powershell.exe' });
    const b = prepareIntegration({ folder, platform: 'linux', shell: '/bin/zsh' });
    assert.notEqual(a.sessionFile, b.sessionFile);
    assert.ok(a.args.includes('-EncodedCommand'));
    assert.equal(b.args, undefined);
    assert.ok(!JSON.stringify(a.env).includes('API_KEY'));
    a.cleanup(); b.cleanup();
    assert.deepEqual(fs.readdirSync(folder), []);
});

test('real Windows PowerShell wrappers detect manual Claude launches and pass arguments safely', { skip: process.platform !== 'win32' }, t => {
    const folder = temporary(t);
    const fake = path.join(folder, 'claude.cmd');
    fs.writeFileSync(fake, '@echo off\r\necho %*\r\nexit /b 0\r\n');
    const source = powershellSource(path.join(folder, "settings with ' quote.json"))
        + "\nclaude\nclaude --resume " + id + " --name 'name with spaces'\nprompt\n";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
        env: { ...process.env, PATH: folder + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 15000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const launches = [];
    new MetadataParser({ cwd: folder, onChange() {}, onLaunch: e => launches.push(e) }).feed(result.stdout);
    assert.equal(launches.length, 2, result.stdout + result.stderr);
    assert.match(launches[0].sessionId, /^[a-f0-9-]{36}$/);
    assert.equal(launches[1].sessionId, id);
    assert.ok(result.stdout.includes('name with spaces'), result.stdout + result.stderr);
    assert.ok(result.stdout.includes('settings with'), result.stdout + result.stderr);
});
