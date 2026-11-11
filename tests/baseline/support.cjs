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

function powerShellLiteral(value) {
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}')))`;
}

function baselineShellInput(data) {
    const match = /^Set-Location -LiteralPath '((?:[^'\r\n]|'')*)'\r$/u.exec(data);
    if (!match || !/[\u{10000}-\u{10ffff}]/u.test(match[1])) return data;
    // Windows' line editor can discard non-BMP input. Construct the same full
    // Unicode argument in PowerShell; keep the archived cwd assertions unchanged.
    return `Set-Location -LiteralPath ${powerShellLiteral(match[1].replace(/''/g, "'"))}\r`;
}

function isolatePowerShellArguments(args) {
    const isolated = [...args];
    if (!isolated.some(argument => argument.toLowerCase() === '-noprofile')) isolated.unshift('-NoProfile');
    const encoded = isolated.findIndex(argument => argument.toLowerCase() === '-encodedcommand');
    if (encoded >= 0 && isolated[encoded + 1]) {
        const prefix = fs.readFileSync(path.join(__dirname, '../fixtures/powershell-test-isolation.ps1'), 'utf8');
        const original = Buffer.from(isolated[encoded + 1], 'base64').toString('utf16le');
        isolated[encoded + 1] = Buffer.from(prefix + '\n' + original, 'utf16le').toString('base64');
    }
    return isolated;
}

module.exports = { testSummary, guardRestorationEnvironment, powerShellLiteral, baselineShellInput, isolatePowerShellArguments };
