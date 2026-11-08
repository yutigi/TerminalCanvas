const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { hasOutputLine, captureScreenshot, inputWaiter } = require('../scripts/smoke.cjs');

test('smoke recognizes Windows output followed by cursor positioning and a prompt', () => {
    const output = '\x1b[?25lC:\\project>echo marker\r\nmarker\x1b[7;1HC:\\project>\x1b[?25h';
    assert.equal(hasOutputLine(output, 'marker'), true);
});

test('smoke accepts plain and colored output but rejects an echoed command alone', () => {
    assert.equal(hasOutputLine('prompt>echo marker\r\n', 'marker'), false);
    assert.equal(hasOutputLine('prompt>echo marker\x1b]0;marker\x07', 'marker'), false);
    assert.equal(hasOutputLine('marker\r\n', 'marker'), true);
    assert.equal(hasOutputLine('\x1b[32mmarker\x1b[0m\r\n', 'marker'), true);
});

function captureWindow(capture) {
    const calls = { captures: 0, repaints: 0 };
    return {
        calls,
        webContents: {
            async capturePage() { calls.captures++; return capture(calls.captures); },
            invalidate() { calls.repaints++; }
        }
    };
}

test('smoke screenshot returns a valid capture without requesting another repaint', async () => {
    const image = { isEmpty: () => false };
    const win = captureWindow(() => image);
    assert.equal(await captureScreenshot(win), image);
    assert.deepEqual(win.calls, { captures: 1, repaints: 0 });
});

test('smoke screenshot recovers from transient compositor failures', async () => {
    const image = { isEmpty: () => false };
    const win = captureWindow(attempt => {
        if (attempt <= 2) throw new Error('UnknownVizError');
        return image;
    });
    assert.equal(await captureScreenshot(win), image);
    assert.deepEqual(win.calls, { captures: 3, repaints: 2 });
});

test('smoke screenshot fails after bounded retries and preserves the compositor error', async () => {
    const error = new Error('UnknownVizError');
    const win = captureWindow(() => { throw error; });
    await assert.rejects(captureScreenshot(win), failure => {
        assert.match(failure.message, /capture failed after 5 attempts: UnknownVizError/);
        assert.equal(failure.cause, error);
        return true;
    });
    assert.deepEqual(win.calls, { captures: 5, repaints: 4 });
});

test('smoke screenshot propagates unrelated failures without retrying', async () => {
    const error = new Error('Render frame was disposed before capture.');
    const win = captureWindow(() => { throw error; });
    await assert.rejects(captureScreenshot(win), failure => failure === error);
    assert.deepEqual(win.calls, { captures: 1, repaints: 0 });
});

test('smoke screenshot rejects an empty image', async () => {
    const win = captureWindow(() => ({ isEmpty: () => true }));
    await assert.rejects(captureScreenshot(win), /Smoke screenshot must not be empty/);
    assert.deepEqual(win.calls, { captures: 1, repaints: 0 });
});

// Runs the generated waiter against a fake page so the test controls which events arrive.
function waiterPage(events) {
    const listeners = new Map(), timers = new Map();
    let nextTimer = 0;
    const window = {
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type) { listeners.delete(type); }
    };
    const context = vm.createContext({ window, setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } });
    vm.runInContext(inputWaiter(events), context);
    let state = 'pending';
    window.__smokeInput.then(() => { state = 'resolved'; }, error => { state = error.message; });
    const flush = async () => {
        for (const [id, timer] of timers) if (timer.ms === 0) { timers.delete(id); timer.fn(); }
        await new Promise(resolve => setImmediate(resolve));
    };
    return { listeners, timers, flush, state: () => state };
}

test('smoke input waits until the renderer dispatches the final native event', async () => {
    const page = waiterPage([{ type: 'mouseDown', x: 10, y: 20 }, { type: 'mouseUp', x: 10, y: 20 }]);
    const pointerup = page.listeners.get('pointerup');
    assert.ok(pointerup, 'listens for the DOM counterpart of the last event');
    pointerup({ clientX: 300, clientY: 300 });
    await page.flush();
    assert.equal(page.state(), 'pending', 'stray pointer input elsewhere is ignored');
    pointerup({ clientX: 10, clientY: 20 });
    await page.flush();
    assert.equal(page.state(), 'resolved');
    assert.equal(page.listeners.has('pointerup'), false);
});

test('smoke input counts repeated final events and times out when input never arrives', async () => {
    const keys = waiterPage([{ type: 'keyDown', keyCode: 'O' }, { type: 'keyUp', keyCode: 'O' }, { type: 'keyDown', keyCode: 'Escape' }, { type: 'keyUp', keyCode: 'Escape' }]);
    keys.listeners.get('keyup')({});
    await keys.flush();
    assert.equal(keys.state(), 'pending');
    keys.listeners.get('keyup')({});
    await keys.flush();
    assert.equal(keys.state(), 'resolved');
    const lost = waiterPage([{ type: 'keyDown', keyCode: 'G' }, { type: 'keyUp', keyCode: 'G' }]);
    [...lost.timers.values()].find(timer => timer.ms === 5000).fn();
    await lost.flush();
    assert.equal(lost.state(), 'Native keyup did not reach the renderer.');
    assert.throws(() => inputWaiter([{ type: 'mouseMove', x: 0, y: 0 }]), /must end with/);
});
