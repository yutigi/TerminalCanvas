const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testSummary, guardRestorationEnvironment } = require('./baseline/support.cjs');

test('baseline counts require a completed, nonempty, successful native test report', () => {
    const tap = '# tests 12\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n';
    assert.deepEqual(testSummary(tap), { tests: 12, pass: 10, fail: 0, cancelled: 0, skipped: 2, todo: 0 });
    assert.throws(() => testSummary('a process started'), /Missing TAP/);
    assert.throws(() => testSummary(tap.replace('# tests 12', '# tests 0')), /must execute/);
    assert.throws(() => testSummary(tap.replace('# fail 0', '# fail 1')), /tests failed/);
    assert.throws(() => testSummary(tap.replace('# cancelled 0', '# cancelled 1')), /cancelled/);
});

test('baseline restoration refuses an uncontrolled or ambiguous PATH before any provider can run', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-baseline-'));
    const tools = path.join(folder, 'controlled');
    const other = path.join(folder, 'other');
    fs.mkdirSync(tools); fs.mkdirSync(other);
    fs.writeFileSync(path.join(tools, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n');
    try {
        assert.doesNotThrow(() => guardRestorationEnvironment({ Path: `${tools};${other}` }, tools));
        assert.throws(() => guardRestorationEnvironment({ Path: `${other};${tools}` }, tools), /stand-in first/);
        assert.throws(() => guardRestorationEnvironment({ Path: tools, PATH: other }, tools), /stand-in first/);
        assert.throws(() => guardRestorationEnvironment({}, tools), /controlled PATH/);
        fs.rmSync(path.join(tools, 'claude.cmd'));
        assert.throws(() => guardRestorationEnvironment({ Path: tools }, tools), /ENOENT/);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
