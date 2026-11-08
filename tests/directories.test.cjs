const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DirectoryReporter, fallbackDirectory } = require('../src/directories.cjs');
const report = cwd => `\x1b]777;tc-cwd;token;${Buffer.from(cwd).toString('base64')}\x07`;

test('directory reports survive every chunk boundary, preserve surrounding output, and handle ST', () => {
    const cwd = 'C:\\nested space\\日本語', data = 'before' + report(cwd) + 'after';
    for (let i = 0; i <= data.length; i++) {
        const tracker = new DirectoryReporter('token');
        assert.equal(tracker.read(data.slice(0, i)) + tracker.read(data.slice(i)), 'beforeafter');
        assert.equal(tracker.cwd, cwd);
    }
    const tracker = new DirectoryReporter('token');
    let output = '';
    for (const char of data) output += tracker.read(char);
    assert.equal(output, 'beforeafter');
    assert.equal(tracker.read(report('/next').replace('\x07', '\x1b\\')), '');
    assert.equal(tracker.cwd, '/next');
    assert.equal(tracker.read('\x1b]0;normal title\x07'), '\x1b]0;normal title\x07');
    assert.equal(tracker.read(report('/wrong session').replace('token', 'other')), report('/wrong session').replace('token', 'other'));
    assert.equal(tracker.cwd, '/next');
});

test('invalid and oversized directory reports cannot retain a stale path or grow an unbounded buffer', () => {
    const tracker = new DirectoryReporter('token');
    for (const data of [report(''), report('bad\0path'), '\x1b]777;tc-cwd;token;%%%\x07', report('x'.repeat(4097))]) {
        tracker.read(report('/previous'));
        tracker.read(data);
        assert.equal(tracker.cwd, null);
    }
    tracker.read('\x1b]777;tc-cwd;token;' + 'x'.repeat(20000));
    assert.equal(tracker.pending.length, 0);
    assert.equal(tracker.read('ordinary output'), 'ordinary output');
});

test('folder picker receives the valid field directory, falls back for invalid paths, and returns cancellation', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-picker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, 'nested', 'project space'); fs.mkdirSync(nested, { recursive: true });
    const calls = [];
    let response = { canceled: true, filePaths: [] };
    const electron = {
        app: { enableSandbox() {}, whenReady: () => new Promise(() => {}), on() {}, getPath: () => root },
        protocol: { registerSchemesAsPrivileged() {} },
        dialog: { async showOpenDialog(win, options) { calls.push(options); return response; } }
    };
    const context = vm.createContext({
        require: name => name === 'electron' ? electron : require(name.startsWith('./') ? path.join(__dirname, '../src', name) : name),
        __dirname: path.join(__dirname, '../src'), process: { argv: [], cwd: process.cwd }, URL
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8'), context);
    for (const candidate of [nested, path.join(root, 'missing'), __filename, '', null, {}, 'relative', 'bad\0path']) {
        const result = await context.command('pick-folder', { cwd: candidate });
        assert.equal(calls.at(-1).defaultPath, candidate === nested ? nested : root);
        assert.equal(result.path, null);
    }
    response = { canceled: false, filePaths: [nested] };
    assert.equal((await context.command('pick-folder', { cwd: root })).path, nested);
    assert.equal(fallbackDirectory(null, {}, 'relative', __filename, root), root);
});

test('Windows prompt integration preserves custom prompts/readers and reports Unicode locations without running script files', { skip: process.platform !== 'win32' }, t => {
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prompt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const nested = path.join(root, "nested space's 日本語"); fs.mkdirSync(nested);
    const integration = fs.readFileSync(path.join(__dirname, '../src/shell-integration.ps1'), 'utf8');
    const script = `$ProgressPreference = 'SilentlyContinue'; function prompt { 'custom prompt' }; function PSConsoleHostReadLine { 'kept reader' }; $env:TERMINAL_CANVAS_CWD_TOKEN = 'token';\n${integration}\nprompt; PSConsoleHostReadLine; prompt`;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: nested, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const tracker = new DirectoryReporter('token');
    const output = tracker.read(result.stdout);
    assert.equal(tracker.cwd, nested);
    assert.equal((output.match(/custom prompt/g) || []).length, 2);
    assert.match(output, /kept reader/);
    assert.ok(result.stdout.includes(report('')), 'the reader invalidates the directory before executing a command');
});
