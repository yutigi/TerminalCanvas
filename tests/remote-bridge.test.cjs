const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/remote-bridge.js'), 'utf8');

function boot() {
    const sockets = [], clipboard = { text: '' };
    class Socket {
        static OPEN = 1;
        constructor(url) { this.url = url; this.readyState = 1; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
        send(text) { this.sent.push(JSON.parse(text)); }
        close(event) { this.readyState = 3; this.onclose?.(event); }
        event(value) { this.onmessage({ data: JSON.stringify(value) }); }
    }
    const window = { location: { protocol: 'http:', href: 'http://127.0.0.1:4312/' }, WebSocket: Socket,
        navigator: { clipboard: { async readText() { return clipboard.text; }, async writeText(text) { clipboard.text = text; } } } };
    vm.runInNewContext(source, { window, URL });
    return { api: window.terminalCanvas, sockets, clipboard, window };
}

test('browser bridge leaves desktop IPC intact and opens one same-origin socket', async () => {
    const harness = boot();
    const initial = harness.api.invoke('initialize');
    const again = harness.api.invoke('initialize');
    assert.equal(harness.sockets.length, 1);
    assert.equal(harness.sockets[0].url, 'ws://127.0.0.1:4312/ws');
    harness.sockets[0].event({ type: 'remote-initialize', role: 'control', workspace: {} });
    assert.equal((await initial).role, 'control'); await again;
    const existing = harness.api;
    vm.runInNewContext(source, { window: harness.window, URL });
    assert.equal(harness.window.terminalCanvas, existing);
    assert.equal(harness.api.assetPrefix, '/images/');
});

test('controller chunks UTF-16 input in socket order, independently of terminal IDs', async () => {
    const { api, sockets } = boot(), initial = api.invoke('initialize');
    sockets[0].event({ type: 'remote-initialize', role: 'control' }); await initial;
    const paste = 'x'.repeat(65535) + '🚀' + 'y'.repeat(65536);
    api.input('one', paste); api.input('two', 'typed');
    const sent = sockets[0].sent;
    assert.deepEqual(sent.map(m => m.seq), [0, 1, 2, 3]);
    assert.equal(sent.slice(0, 3).map(m => m.data).join(''), paste);
    assert.ok(sent.every(m => m.data.length <= 65536));
    assert.equal(sent[0].data.length, 65535);
    assert.equal(sent[3].id, 'two');
});

test('viewer, resize, acknowledgments, and forbidden commands send no network messages', async () => {
    const { api, sockets } = boot(), initial = api.invoke('initialize');
    sockets[0].event({ type: 'remote-initialize', role: 'view' }); await initial;
    api.input('one', 'danger'); api.resize('one', 1, 1); api.acknowledge('one', 100);
    assert.match((await api.invoke('remote-terminal', { epoch: 1, command: { action: 'launch' } })).error, /read-only/);
    for (const action of ['autosave', 'close', 'start', 'save-as', 'remote-status', 'remote-rotate', 'delete-unused-images']) {
        assert.match((await api.invoke(action, {})).error, /desktop app/);
    }
    assert.equal(sockets[0].sent.length, 0);
});

test('controller terminal requests match their replies and settle when disconnected', async () => {
    const { api, sockets } = boot(), initial = api.invoke('initialize');
    const [socket] = sockets;
    socket.event({ type: 'remote-initialize', role: 'control' }); await initial;
    const command = { action: 'launch', canvasId: 'canvas-1', options: { command: 'echo example' } };
    const launch = api.invoke('remote-terminal', { epoch: 7, command });
    assert.deepEqual(socket.sent, [{ action: 'terminal', request: 1, epoch: 7, command }]);
    assert.match((await api.invoke('remote-terminal', { epoch: 7, command })).error, /in progress/);
    socket.event({ type: 'remote-terminal-result', request: 2, result: { error: 'unrelated' } });
    socket.event({ type: 'remote-terminal-result', request: 1, result: { id: 'new' } });
    assert.equal((await launch).id, 'new');
    assert.match((await api.invoke('remote-stop')).error, /desktop app/);
    const close = api.invoke('remote-terminal', { epoch: 7, command: { action: 'close', id: 'new' } });
    socket.close();
    assert.match((await close).error, /Reload/);
    assert.match((await api.invoke('remote-terminal', { epoch: 7, command })).error, /Reload/);
    assert.equal(socket.sent.length, 2);
});

test('browser clipboard stays on the browser and validates copy size', async () => {
    const { api, clipboard } = boot();
    await api.invoke('clipboard-write', 'copied');
    assert.equal(clipboard.text, 'copied');
    assert.equal((await api.invoke('clipboard-read')).text, 'copied');
    assert.equal((await api.invoke('clipboard-write', 'x'.repeat(1048577))).error, 'Selection exceeds 1 MB.');
});

test('disconnect stops input and exposes a reconnect message; failed initialization settles', async () => {
    const { api, sockets } = boot(), events = [];
    api.onEvent(event => events.push(event));
    const initial = api.invoke('initialize');
    sockets[0].close();
    assert.match((await initial).error, /Reload/);
    api.input('one', 'unsafe');
    assert.equal(sockets[0].sent.length, 0);
    assert.equal(events[0].type, 'remote-disconnected');
});

test('an open socket that closes before initialization reports a workspace loading failure', async () => {
    const { api, sockets } = boot(), initial = api.invoke('initialize');
    const [socket] = sockets;
    socket.onopen();
    socket.onerror();
    socket.close();
    assert.match((await initial).error, /closed while loading the workspace/);
});

test('an initialized socket reports why the server closed it', async () => {
    const { api, sockets } = boot(), events = [], initial = api.invoke('initialize');
    api.onEvent(event => events.push(event));
    const [socket] = sockets;
    socket.onopen();
    socket.event({ type: 'remote-initialize', role: 'view' });
    await initial;
    const reason = 'Browser connection fell behind terminal output. Reload to reconnect.';
    socket.close({ reason });
    assert.equal(events[0].message, reason);
});

test('oversized paste and a stalled socket are bounded', async () => {
    const { api, sockets } = boot(), events = [], initial = api.invoke('initialize');
    api.onEvent(event => events.push(event));
    sockets[0].event({ type: 'remote-initialize', role: 'control' }); await initial;
    api.input('one', 'x'.repeat(1048577));
    assert.equal(sockets[0].sent.length, 0);
    assert.equal(events[0].message, 'Paste exceeds 1 MB.');
    sockets[0].bufferedAmount = 3 * 1024 * 1024;
    api.input('one', 'typed');
    assert.equal(sockets[0].sent.length, 0);
    assert.match(events[1].message, /queue is full/);
});
