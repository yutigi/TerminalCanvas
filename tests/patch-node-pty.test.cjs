const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { patchAgentSource, patchNodePty } = require('../scripts/patch-node-pty.cjs');

// The relevant part of node-pty 1.1.0's lib/conpty_console_list_agent.js.
const original = [
    'var getConsoleProcessList = utils_1.loadNativeModule(\'conpty_console_list\').module.getConsoleProcessList;',
    'var shellPid = parseInt(process.argv[2], 10);',
    'var consoleProcessList = getConsoleProcessList(shellPid);',
    'process.send({ consoleProcessList: consoleProcessList });',
    'process.exit(0);',
    ''
].join('\n');

function runAgent(source, getConsoleProcessList, pid = '1234') {
    const body = source.replace(/^var getConsoleProcessList = .*$/m, '');
    const sent = [];
    const fakeProcess = { argv: ['node', 'agent', pid], send: message => sent.push(message), exit() {} };
    new Function('process', 'getConsoleProcessList', body)(fakeProcess, getConsoleProcessList);
    return sent;
}

test('guards the node-pty 1.1.0 helper so an exited shell reports an empty process list', () => {
    const { status, source } = patchAgentSource(original);
    assert.equal(status, 'patched');
    assert.throws(() => runAgent(original, () => { throw new Error('AttachConsole failed'); }), /AttachConsole failed/);
    assert.deepEqual(runAgent(source, () => { throw new Error('AttachConsole failed'); }), [{ consoleProcessList: [] }]);
    assert.deepEqual(runAgent(source, pid => [pid, 99]), [{ consoleProcessList: [1234, 99] }]);
    assert.deepEqual(runAgent(source, () => { throw new Error('not called'); }, 'invalid'), [{ consoleProcessList: [] }]);
});

test('patching is idempotent, preserves CRLF, and leaves unknown layouts untouched', () => {
    const once = patchAgentSource(original).source;
    assert.deepEqual(patchAgentSource(once), { status: 'already-guarded', source: once });
    const crlf = patchAgentSource(original.replace(/\n/g, '\r\n')).source;
    assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);
    const unknown = 'module.exports = 1;\n';
    assert.deepEqual(patchAgentSource(unknown), { status: 'unrecognized', source: unknown });
});

test('patches an installed helper once and skips projects without node-pty', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-patch-'));
    try {
        const logs = [];
        assert.equal(patchNodePty({ base, log: m => logs.push(m) }), 'missing');
        const lib = path.join(base, 'node_modules', 'node-pty', 'lib');
        fs.mkdirSync(lib, { recursive: true });
        fs.writeFileSync(path.join(base, 'node_modules', 'node-pty', 'package.json'), '{"name":"node-pty","version":"1.1.0"}');
        fs.writeFileSync(path.join(lib, 'conpty_console_list_agent.js'), original);
        assert.equal(patchNodePty({ base, log: m => logs.push(m) }), 'patched');
        assert.equal(patchNodePty({ base, log: m => logs.push(m) }), 'already-guarded');
        assert.equal(logs.length, 1);
        const patched = fs.readFileSync(path.join(lib, 'conpty_console_list_agent.js'), 'utf8');
        assert.equal(spawnSync(process.execPath, ['--check', path.join(lib, 'conpty_console_list_agent.js')]).status, 0);
        assert.match(patched, /catch \(_a\)/);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
