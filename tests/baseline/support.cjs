const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function testSummary(tap) {
    const read = name => {
        const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))];
        assert.ok(matches.length, `Missing TAP ${name} summary`);
        return Number(matches.at(-1)[1]);
    };
    const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(name => [name, read(name)]));
    assert.ok(summary.tests > 0, 'The baseline must execute tests');
    assert.equal(summary.fail, 0, 'Baseline tests failed');
    assert.equal(summary.cancelled, 0, 'Baseline tests were cancelled');
    return summary;
}

function guardRestorationEnvironment(env, tools) {
    const expected = fs.realpathSync.native(tools).toLowerCase();
    const paths = Object.entries(env).filter(([name]) => name.toLowerCase() === 'path');
    assert.ok(paths.length, 'The restoration shell needs its controlled PATH');
    for (const [, value] of paths) {
        assert.equal(fs.realpathSync.native(value.split(';')[0]).toLowerCase(), expected,
            'The restoration shell must resolve the local stand-in first');
    }
    const executable = path.join(tools, 'claude.cmd');
    assert.ok(fs.statSync(executable).isFile(), 'The local Claude stand-in must exist');
    assert.equal(fs.realpathSync.native(executable).toLowerCase(), path.join(expected, 'claude.cmd'),
        'The stand-in must remain inside the controlled tools directory');
}

module.exports = { testSummary, guardRestorationEnvironment };
