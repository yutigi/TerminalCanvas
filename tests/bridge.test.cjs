const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/bridge.js'), 'utf8');

function bridge(protocol = 'tauri:') {
    const calls = [];
    let respond = () => Promise.resolve({ ok: true });
    const window = {
        location: { protocol },
        __TAURI__: { core: {
            Channel: class {},
            invoke(command, args) { calls.push({ command, args }); return respond(command, args); }
        } }
    };
    vm.runInNewContext(source, { window, Uint8Array });
    return { api: window.terminalCanvas, calls, respond(fn) { respond = fn; } };
}

test('Tauri bridge keeps the Electron preload and browser preview usable', () => {
    const electron = { terminalCanvas: { electron: true } };
    vm.runInNewContext(source, { window: electron });
    assert.equal(electron.terminalCanvas.electron, true);
    const preview = {};
    vm.runInNewContext(source, { window: preview });
    assert.equal(preview.terminalCanvas, undefined);
});

test('bridge maps action names, preserves absent versus null payloads, and returns host errors', async () => {
    const harness = bridge();
    await harness.api.invoke('save-as', null);
    await harness.api.invoke('new');
    assert.equal(harness.calls[0].command, 'save_as');
    assert.equal(harness.calls[0].args.payload, null);
    assert.equal(Object.hasOwn(harness.calls[1].args, 'payload'), false);
    harness.respond(() => Promise.reject(new Error('Write failed')));
    assert.equal((await harness.api.invoke('save')).error, 'Write failed');
    harness.respond(() => Promise.reject('Unavailable'));
    assert.equal((await harness.api.invoke('save')).error, 'Unavailable');
    assert.equal((await harness.api.invoke(null)).error, 'Unsupported desktop command.');
});

test('bridge sends raw image bytes and exposes the correct platform asset URL', async () => {
    for (const [protocol, prefix] of [
        ['tauri:', 'tc-asset://images/'], ['http:', 'http://tc-asset.localhost/images/']
    ]) {
        const harness = bridge(protocol);
        assert.equal(harness.api.assetPrefix, prefix);
        const bytes = new Uint8Array([1, 2, 3]);
        await harness.api.invoke('import-image', { bytes });
        assert.equal(harness.calls[0].command, 'import_image');
        assert.equal(harness.calls[0].args, bytes);
        assert.equal((await harness.api.invoke('import-image', { bytes: [1, 2] })).error, 'Invalid image data.');
        assert.equal(harness.calls.length, 1);
    }
});

test('one initialization channel delivers ordered events and listener removal works', async () => {
    const harness = bridge(), received = [];
    const remove = harness.api.onEvent(event => received.push(event));
    await harness.api.invoke('initialize');
    const channel = harness.calls[0].args.events;
    channel.onmessage({ type: 'data', data: 'first' });
    channel.onmessage({ type: 'exit' });
    assert.deepEqual(received.map(event => event.type), ['data', 'exit']);
    remove();
    channel.onmessage({ type: 'data' });
    assert.equal(received.length, 2);
});

test('input sequences are independent per terminal and errors return through the event listener', async () => {
    const harness = bridge(), events = [];
    harness.api.onEvent(event => events.push(event));
    harness.api.input('a', 'x'.repeat(64000));
    harness.api.input('b', 'other');
    harness.api.input('a', 'typed');
    assert.deepEqual(harness.calls.map(call => [call.args.id, call.args.seq]), [['a', 0], ['b', 0], ['a', 1]]);
    harness.respond(() => Promise.reject('Resize failed'));
    harness.api.resize('a', 80, 24);
    await Promise.resolve();
    assert.equal(events[0].id, 'a');
    assert.equal(events[0].message, 'Resize failed');
    harness.api.acknowledge('a', 4);
    await Promise.resolve();
    assert.equal(events.length, 1, 'ack errors do not flood the UI');
});

test('long input goes in ordered host-sized pieces that keep surrogate pairs whole', () => {
    const harness = bridge(), limit = 65536;
    harness.api.input('a', 'x'.repeat(limit));
    assert.deepEqual(harness.calls.map(call => [call.args.seq, call.args.data.length]), [[0, limit]]);
    // A bracketed paste near the 1 MB clipboard limit, with a surrogate pair across the first
    // piece boundary.
    const paste = '\x1b[200~' + 'p'.repeat(limit - 7) + '🚀' + 'ไทย\r'.repeat(245000) + '\x1b[201~';
    harness.api.input('a', paste);
    harness.api.input('b', 'other');
    harness.api.input('a', 'typed');
    const a = harness.calls.filter(call => call.args.id === 'a').slice(1);
    assert.deepEqual(a.map(call => call.args.seq), a.map((_, index) => index + 1));
    assert.ok(a.length > 2);
    assert.ok(a.every(call => call.args.data.length > 0 && call.args.data.length <= limit));
    assert.equal(a[0].args.data.length, limit - 1, 'the pair moves whole into the next piece');
    assert.ok(a.slice(0, -1).every(call => !/[\ud800-\udbff]$/.test(call.args.data) && !/^[\udc00-\udfff]/.test(call.args.data)));
    assert.equal(a.slice(0, -1).map(call => call.args.data).join(''), paste);
    assert.equal(a.at(-1).args.data, 'typed');
    assert.deepEqual(harness.calls.filter(call => call.args.id === 'b').map(call => call.args.seq), [0]);
});
