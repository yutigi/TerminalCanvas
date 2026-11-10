const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testSummary, guardRestorationEnvironment, baselineShellInput, isolatePowerShellArguments } = require('./baseline/support.cjs');
const { withSavedClipboard } = require('./baseline/clipboard.cjs');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

test('baseline counts require a completed, nonempty, successful native test report', () => {
    const tap = '# tests 12\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 2\n# todo 0\n';
    assert.deepEqual(testSummary(tap), { tests: 12, pass: 10, fail: 0, cancelled: 0, skipped: 2, todo: 0 });
    assert.throws(() => testSummary('a process started'), /Missing TAP/);
    assert.throws(() => testSummary(tap.replace('# tests 12', '# tests 0')), /must execute/);
    assert.throws(() => testSummary(tap.replace('# fail 0', '# fail 1')), /tests failed/);
    assert.throws(() => testSummary(tap.replace('# cancelled 0', '# cancelled 1')), /cancelled/);
});

test('baseline input adaptation preserves the full Unicode directory and leaves other input untouched', () => {
    const folder = "C:\\project's folder\\ไทย 工作 🚀";
    const command = `Set-Location -LiteralPath '${folder.replaceAll("'", "''")}'\r`;
    const adapted = baselineShellInput(command);
    assert.ok(!/[^\x00-\x7f]/.test(adapted));
    const encoded = /FromBase64String\('([^']+)'\)/.exec(adapted)[1];
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), folder);
    for (const data of ["Set-Location -LiteralPath 'C:\\工作'\r", "Write-Output '🚀'\r", command.slice(0, -1), command + "Write-Output 'next'\r"]) {
        assert.equal(baselineShellInput(data), data, 'Only the complete affected fixture command is adapted');
    }
});

test('the baseline shares isolated history settings while preserving the original Unicode bootstrap', () => {
    const original = "Write-Output 'ไทย 工作 🚀'";
    const args = ['-NoExit', '-EncodedCommand', Buffer.from(original, 'utf16le').toString('base64')];
    const isolated = isolatePowerShellArguments(args);
    const script = Buffer.from(isolated.at(-1), 'base64').toString('utf16le');
    assert.equal(isolated[0], '-NoProfile');
    assert.ok(script.includes('-HistorySaveStyle SaveNothing'));
    assert.ok(script.includes('-PredictionSource None'));
    assert.ok(script.endsWith(original));
    assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), original, 'Caller arguments are not mutated');
});

function clipboardGuard({ acknowledge = true } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let restored = false;
    child.stdin = new Writable({ write(data, _encoding, done) {
        assert.equal(data.toString(), 'restore\n');
        restored = true;
        done();
        // A child can exit before Node has delivered its remaining stdout.
        setImmediate(() => child.emit('exit', 0));
        setTimeout(() => {
            if (acknowledge) child.stdout.write('CLIPBOARD_RESTORED\n');
            child.stdout.end(); child.stderr.end(); child.emit('close', 0);
        }, 100);
    } });
    return { launch: () => { setImmediate(() => child.stdout.write('CLIPBOARD_SAVED\n')); return child; },
        restored: () => restored };
}

test('baseline clipboard restoration finishes even when the Electron smoke task fails', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-baseline-clipboard-'));
    const guard = clipboardGuard();
    try {
        await assert.rejects(withSavedClipboard(async () => { throw new Error('smoke child failed'); },
            path.join(folder, 'guard.log'), guard.launch), /smoke child failed/);
        assert.ok(guard.restored());
        assert.match(fs.readFileSync(path.join(folder, 'guard.log'), 'utf8'), /CLIPBOARD_RESTORED/);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('baseline clipboard checks reject an exit without a native restoration acknowledgement', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-baseline-clipboard-'));
    const guard = clipboardGuard({ acknowledge: false });
    try {
        await assert.rejects(withSavedClipboard(async () => {}, path.join(folder, 'guard.log'), guard.launch), /must be restored/);
        assert.ok(guard.restored());
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
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
