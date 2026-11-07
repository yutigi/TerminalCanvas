const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('desktop launch allows a visible window and removes Electron Node mode', () => {
    const env = { ELECTRON_RUN_AS_NODE: '1', PATH: 'sample-path' };
    let launch;
    const scripts = path.resolve(__dirname, '../scripts');
    vm.runInNewContext(fs.readFileSync(path.join(scripts, 'start.cjs'), 'utf8'), {
        require(name) {
            if (name === 'electron') return 'electron.exe';
            if (name === 'node:path') return path;
            if (name === 'node:child_process') return { spawn(...args) {
                launch = args;
                return new EventEmitter();
            } };
            throw new Error('Unexpected module: ' + name);
        },
        __dirname: scripts,
        console,
        process: { env, argv: ['node', 'start.cjs', '--example'] }
    });
    assert.equal(launch[0], 'electron.exe');
    assert.deepEqual(Array.from(launch[1]), [path.resolve(scripts, '..'), '--example']);
    assert.notEqual(launch[2].windowsHide, true);
    assert.equal(launch[2].env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(launch[2].env.PATH, env.PATH);
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});
