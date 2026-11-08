const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fallbackDirectory } = require('../src/directories.cjs');
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
