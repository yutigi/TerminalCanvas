const test = require('node:test');
const assert = require('node:assert/strict');
const { directoryReports, processDirectory, watchDirectory } = require('../src/terminal-cwd.cjs');

test('directory reports handle every split, spaces, Unicode, quotes, BEL and ST', () => {
    for (const end of ['\x07', '\x1b\\']) {
        const stream = 'hello\x1b]9;9;"C:\\some folder\\子"' + end + 'world';
        for (let split = 0; split <= stream.length; split++) {
            const reports = [], observe = directoryReports('win32', cwd => reports.push(cwd));
            observe(stream.slice(0, split)); observe(stream.slice(split));
            assert.deepEqual(reports, ['C:\\some folder\\子']);
        }
    }
});

test('invalid, unrelated, oversized and incomplete metadata cannot become a path', () => {
    const reports = [], observe = directoryReports('win32', cwd => reports.push(cwd));
    observe('C:\\fake prompt> cd fake\r\n\x1b]0;title\x07');
    observe('\x1b]9;9;' + 'a'.repeat(50000)); observe('\x07');
    assert.deepEqual(reports, []);
    observe('\x1b]9;9;relative\x07\x1b]9;9;\x07\x1b]9;9;C:\\bad\npath\x07');
    assert.deepEqual(reports, [null, null, null]);
    observe('\x1b]9;9;C:\\valid\x07');
    assert.equal(reports.at(-1), 'C:\\valid');
});

test('OSC 7 decodes file URIs exactly once for local paths', () => {
    const reports = [], observe = directoryReports('linux', cwd => reports.push(cwd));
    observe('\x1b]7;file://localhost/a%20folder/%25literal/%E5%AD%90\x07');
    assert.deepEqual(reports, ['/a folder/%literal/子']);
});

test('polling recovers from failures and cancellation ignores pending results', async () => {
    const reports = [], timers = [], cancelled = [];
    let resolveRead, calls = 0;
    const watcher = watchDirectory(42, 'linux', cwd => reports.push(cwd), {
        read: () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); },
        schedule(fn, ms) { assert.equal(ms, 1000); timers.push(fn); return timers.length; },
        cancel(timer) { cancelled.push(timer); }
    });
    assert.equal(calls, 1);
    resolveRead('/first path'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reports, ['/first path']);
    void timers[0](); resolveRead(null); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reports, ['/first path', null]);
    void timers[1](); watcher.dispose(); resolveRead('/stale'); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reports, ['/first path', null]); assert.equal(timers.length, 2);
    assert.deepEqual(cancelled, [2]);
});

test('unavailable process directories resolve to unknown', async () => {
    assert.equal(await processDirectory(-1, 'linux'), null);
    assert.equal(await processDirectory(2147483647, 'linux'), null);
    assert.equal(await processDirectory(42, 'unsupported'), null);
});

test('OSC 7 preserves Windows drive paths and UNC shares with reserved characters', () => {
    const reports = [], observe = directoryReports('win32', cwd => reports.push(cwd));
    observe('\x1b]7;file:///C:/a%20folder/%25literal/%23name/%E5%AD%90\x07');
    observe('\x1b]7;file://server/share/a%20folder\x07');
    assert.deepEqual(reports, [String.raw`C:\a folder\%literal\#name\子`, String.raw`\\server\share\a folder`]);
    const remote = [], unix = directoryReports('linux', cwd => remote.push(cwd));
    unix('\x1b]7;file://remote.example/home/user\x07plain text');
    unix('\x1b]7;file:///local\x07');
    assert.deepEqual(remote, ['/local']);
});

test('Linux queries the shell PID symlink and macOS parses NUL-delimited lsof names', async () => {
    const cwd = await processDirectory(123, 'linux', { readlink: async name => {
        assert.equal(name, '/proc/123/cwd'); return '/a folder/子';
    } });
    assert.equal(cwd, '/a folder/子');
    assert.equal(await processDirectory(124, 'darwin', { run: async (file, args, options) => {
        assert.equal(file, '/usr/sbin/lsof');
        assert.deepEqual(args, ['-a', '-p', '124', '-d', 'cwd', '-Fn0']);
        assert.equal(options.timeout, 800);
        return { stdout: 'p124\0\nfcwd\0n/Users/name/a folder/子\0\n' };
    } }), '/Users/name/a folder/子');
    assert.equal(await processDirectory(124, 'darwin', { run: async () => { throw new Error('permission denied'); } }), null);
    assert.equal(await processDirectory(124, 'darwin', { run: async () => ({ stdout: 'p124\0\n' }) }), null);
});

test('PowerShell integration preserves the custom prompt, failed status and native exit code', { skip: process.platform !== 'win32' }, () => {
    const { spawnSync } = require('node:child_process');
    const { powershellArgs } = require('../src/terminal-cwd.cjs');
    const bootstrap = Buffer.from(powershellArgs().at(-1), 'base64').toString('utf16le');
    const script = `function global:prompt { "CUSTOM:$?:$global:LASTEXITCODE>" }; ${bootstrap}
        $global:LASTEXITCODE = 37; Write-Error 'expected failure' -ErrorAction SilentlyContinue
        $result = prompt; Write-Output ('RESULT=' + $result + ';LAST=' + $global:LASTEXITCODE)`;
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /RESULT=CUSTOM:False:37>;LAST=37/);
    const reports = [];
    directoryReports('win32', cwd => reports.push(cwd))(result.stdout);
    assert.deepEqual(reports, [process.cwd()]);
});

test('OSC 7 preserves local-machine and localhost UNC shares without changing drive or Unix paths', () => {
    const hostname = require('node:os').hostname().toLowerCase();
    const suffix = '/share/a%20folder/%25literal/%23name/%E5%AD%90';
    for (const host of [hostname, 'localhost', 'LOCALHOST']) {
        const stream = `\x1b]7;file://${host}${suffix}\x07`;
        const expected = '\\\\' + host.toLowerCase() + String.raw`\share\a folder\%literal\#name\子`;
        for (let split = 0; split <= stream.length; split++) {
            const reports = [], observe = directoryReports('win32', cwd => reports.push(cwd));
            observe(stream.slice(0, split)); observe(stream.slice(split));
            assert.deepEqual(reports, [expected], `UNC host ${host}, split ${split}`);
        }
    }
    const reports = [], observe = directoryReports('win32', cwd => reports.push(cwd));
    observe('\x1b]7;file://localhost/C:/a%20folder\x07');
    observe('\x1b]7;file://localhost/share/encoded%5cseparator\x07');
    assert.deepEqual(reports, [String.raw`C:\a folder`, null]);
    const unix = [];
    directoryReports('linux', cwd => unix.push(cwd))(`\x1b]7;file://${hostname}/a%20folder\x07`);
    assert.deepEqual(unix, ['/a folder']);
});

for (const executable of ['powershell.exe', 'pwsh.exe']) {
    test(`${executable} buffered line acceptance clears readiness and preserves reader output/status`, { skip: process.platform !== 'win32' }, t => {
        const { spawnSync } = require('node:child_process');
        const { powershellArgs } = require('../src/terminal-cwd.cjs');
        const bootstrap = Buffer.from(powershellArgs().at(-1), 'base64').toString('utf16le');
        const script = `$ProgressPreference = 'SilentlyContinue'
            Set-StrictMode -Version Latest
            function global:prompt { 'CUSTOM>' }
            function global:PSConsoleHostReadLine { 'BUFFERED:' + $? + ':' + $global:LASTEXITCODE }
            ${bootstrap}
            $global:LASTEXITCODE = 37
            $result = prompt
            Write-Error 'expected failure' -ErrorAction SilentlyContinue
            $line = PSConsoleHostReadLine
            Write-Output ('LINE=' + $line + ';LAST=' + $global:LASTEXITCODE)
            $result = prompt
            $line = PSConsoleHostReadLine
            Write-Output ('LINE2=' + $line)
            function global:PSConsoleHostReadLine { throw 'reader failed' }
            $result = prompt`;
        const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (executable === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed.');
        assert.equal(result.status, 0, result.error?.message || result.stderr);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /LINE=BUFFERED:False:37;LAST=37/);
        assert.match(result.stdout, /LINE2=BUFFERED:True:37/);
        const readiness = [];
        directoryReports('win32', () => {}, ready => readiness.push(ready))(result.stdout);
        assert.deepEqual(readiness, [true, false, true, false, false], 'buffered lines clear each intermediate prompt; a replaced reader requires review');
    });

    test(`${executable} missing or throwing input readers cannot leave readiness enabled`, { skip: process.platform !== 'win32' }, t => {
        const { spawnSync } = require('node:child_process');
        const { powershellArgs } = require('../src/terminal-cwd.cjs');
        const bootstrap = Buffer.from(powershellArgs().at(-1), 'base64').toString('utf16le');
        for (const reader of ['', "function global:PSConsoleHostReadLine { throw 'reader failed' }"]) {
            const script = `$ProgressPreference = 'SilentlyContinue'
                Set-StrictMode -Version Latest
                Remove-Item Function:PSConsoleHostReadLine -ErrorAction Ignore
                function global:prompt { 'CUSTOM>' }
                ${reader}
                ${bootstrap}
                $result = prompt
                ${reader ? "try { PSConsoleHostReadLine } catch { Write-Output ('CAUGHT=' + $_.Exception.Message) }" : ''}`;
            const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
            if (executable === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed.');
            assert.equal(result.status, 0, result.error?.message || result.stderr);
            assert.equal(result.stderr, '');
            const readiness = [];
            directoryReports('win32', () => {}, ready => readiness.push(ready))(result.stdout);
            assert.deepEqual(readiness, reader ? [true, false] : [false]);
            if (reader) assert.match(result.stdout, /CAUGHT=reader failed/);
        }
    });

    test(`${executable} prompt supports strict mode with missing and existing LASTEXITCODE`, { skip: process.platform !== 'win32' }, t => {
        const { spawnSync } = require('node:child_process');
        const { powershellArgs } = require('../src/terminal-cwd.cjs');
        const bootstrap = Buffer.from(powershellArgs().at(-1), 'base64').toString('utf16le');
        const script = `Set-StrictMode -Version Latest
            $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
            Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore
            function global:prompt { "CUSTOM:$?>" }
            ${bootstrap}
            Write-Error 'expected failure' -ErrorAction SilentlyContinue
            $result = prompt
            $exists = $null -ne (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore)
            Write-Output ('RESULT=' + $result + ';EXISTS=' + $exists)
            $global:LASTEXITCODE = 37
            Write-Error 'expected failure' -ErrorAction SilentlyContinue
            $result = prompt
            Write-Output ('RESULT2=' + $result + ';LAST=' + $global:LASTEXITCODE)`;
        const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (executable === 'pwsh.exe' && result.error?.code === 'ENOENT') return t.skip('PowerShell 7 is not installed.');
        assert.equal(result.status, 0, result.error?.message || result.stderr);
        assert.equal(result.stderr, '');
        assert.match(result.stdout, /RESULT=CUSTOM:False>;EXISTS=False/);
        assert.match(result.stdout, /RESULT2=CUSTOM:False>;LAST=37/);
        const reports = [];
        directoryReports('win32', cwd => reports.push(cwd))(result.stdout);
        assert.deepEqual(reports, [process.cwd(), process.cwd()]);
    });
}

test('readiness metadata survives every chunk boundary and cannot become a directory', () => {
    const stream = '\x1b]777;tc-ready;0\x07\x1b]7;file:///C:/project\x07\x1b]777;tc-ready;1\x1b\\';
    for (let split = 0; split <= stream.length; split++) {
        const directories = [], readiness = [];
        const observe = directoryReports('win32', cwd => directories.push(cwd), ready => readiness.push(ready));
        observe(stream.slice(0, split)); observe(stream.slice(split));
        assert.deepEqual(directories, ['C:\\project']);
        assert.deepEqual(readiness, [false, true]);
        observe('\x1b]777;tc-ready;2\x07');
        assert.deepEqual(readiness, [false, true]);
    }
});
