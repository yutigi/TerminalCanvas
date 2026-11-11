const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { until, probeCdp, hasOutputLine, sendInput } = require('./e2e/harness.cjs');

test('E2E output checks ignore OSC reports and echoed command mentions', () => {
    assert.equal(hasOutputLine("PS> Write-Output 'MARKER'\r\n\x1b]9;9;C:\\project\x07\x1b[32mMARKER\x1b[0m\r\n", 'MARKER'), true);
    assert.equal(hasOutputLine("PS> Write-Output 'MARKER'\r\n", 'MARKER'), false);
    assert.equal(hasOutputLine('first\x1b[2;3HMARKER\x1b[0m\r\n', 'MARKER'), true);
});

test('E2E polling tolerates transient observation errors and fails immediately after a terminal process error', async () => {
    let calls = 0;
    assert.equal(await until(() => { if (++calls === 1) throw new Error('not ready'); return 'ready'; }, 'missing', 200), 'ready');
    const failure = Object.assign(new Error('Host exited'), { terminal: true });
    await assert.rejects(until(() => { throw failure; }, 'timeout', 200), error => error === failure);
});

test('an unresponsive CDP endpoint is aborted instead of hanging host startup', async () => {
    // AbortSignal's timer is unreferenced; keep this controlled pending request alive until abort.
    const watchdog = setTimeout(() => {}, 3000);
    try {
        await assert.rejects(probeCdp(9222, (url, options) => {
            assert.equal(url, 'http://127.0.0.1:9222/json/version');
            assert.ok(options.signal instanceof AbortSignal);
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        }), error => error.name === 'TimeoutError');
    } finally { clearTimeout(watchdog); }
});

test('native input waiter takes focus and ignores unrelated pointer events before completing after dispatch', async () => {
    const listeners = new Map();
    let focused = false, broughtToFront = false, handlerFinished = false;
    const window = {
        __TAURI__: { core: { async invoke(command) { assert.equal(command, 'e2e_focus'); focused = true; } } },
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); }
    };
    const context = vm.createContext({ window, document: { hasFocus: () => focused }, setTimeout, clearTimeout });
    const page = {
        async bringToFront() { broughtToFront = true; },
        async evaluate(fn, args) { context.args = args; return vm.runInContext(`(${fn.toString()})(args)`, context); }
    };
    await sendInput(page, async () => {
        const listener = listeners.get('pointerup');
        listener({ clientX: 99, clientY: 99 });
        assert.equal(listeners.has('pointerup'), true);
        listener({ clientX: 10, clientY: 20 });
        assert.equal(listeners.has('pointerup'), false);
        handlerFinished = true;
    }, { point: { x: 10, y: 20 } });
    assert.equal(broughtToFront, true);
    assert.equal(handlerFinished, true);
    assert.equal(listeners.size, 0);
});
