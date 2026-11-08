const test = require('node:test');
const assert = require('node:assert/strict');
const { hasOutputLine, captureScreenshot } = require('../scripts/smoke.cjs');

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
