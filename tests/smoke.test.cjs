const test = require('node:test');
const assert = require('node:assert/strict');
const { hasOutputLine } = require('../scripts/smoke.cjs');

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
