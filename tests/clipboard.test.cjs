const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real command dispatcher without opening an Electron window.
function commands(clipboard) {
    const filename = path.join(__dirname, '../src/main.cjs');
    const nativeRequire = createRequire(filename);
    const context = vm.createContext({
        require: name => name === 'electron' ? {
            clipboard, app: { enableSandbox() {}, whenReady: () => new Promise(() => {}), on() {} },
            protocol: { registerSchemesAsPrivileged() {} }
        } : nativeRequire(name),
        __dirname: path.dirname(filename), process: { argv: [], platform: 'win32' }, console
    });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
    return vm.runInContext('command', context);
}

test('clipboard IPC resolves asynchronous text reads before returning serializable text', async () => {
    const command = commands({ readText: async () => 'first\nsecond' });
    const result = await command('clipboard-read');
    assert.equal(result.text, 'first\nsecond');
    assert.deepEqual(structuredClone(result), { text: 'first\nsecond' });
});

test('clipboard IPC enforces the paste limit after awaiting the OS clipboard', async () => {
    const command = commands({ readText: async () => 'x'.repeat(64001) });
    await assert.rejects(command('clipboard-read'), /Paste is limited to 64,000 characters/);
    const boundary = commands({ readText: async () => 'x'.repeat(64000) });
    assert.equal((await boundary('clipboard-read')).text.length, 64000);
});

test('clipboard IPC waits for writes and propagates asynchronous OS failures', async () => {
    let finish, settled = false;
    const command = commands({ writeText: () => new Promise(resolve => { finish = resolve; }) });
    const pending = command('clipboard-write', 'selected').then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'do not acknowledge a write that is still pending');
    finish();
    await pending;
    assert.equal(settled, true);
    const failed = commands({ readText: async () => { throw new Error('Read failed'); }, writeText: async () => { throw new Error('Write failed'); } });
    await assert.rejects(failed('clipboard-read'), /Read failed/);
    await assert.rejects(failed('clipboard-write', 'selected'), /Write failed/);
});

test('clipboard IPC rejects invalid or oversized copies without touching the OS clipboard', async () => {
    let writes = 0;
    const command = commands({ writeText: async () => { writes++; } });
    for (const value of [null, 123, 'x'.repeat(1024 * 1024 + 1)]) {
        await assert.rejects(command('clipboard-write', value), /Selection exceeds 1 MB/);
    }
    assert.equal(writes, 0);
});
