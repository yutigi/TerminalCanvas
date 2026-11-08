const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const main = path.join(root, 'src/main.cjs');
const requireMain = createRequire(main);

for (const platform of ['win32', 'linux']) {
    test(`desktop window loads the logo icon on ${platform}`, async () => {
        let ready, options;
        const noop = () => {};
        const electron = {
            app: {
                enableSandbox: noop, on: noop,
                whenReady: () => ({ then(callback) { ready = Promise.resolve().then(callback); return ready; } }),
                exit: () => assert.fail('App initialization failed')
            },
            BrowserWindow: class {
                constructor(value) { options = value; }
                webContents = { on: noop, setWindowOpenHandler: noop };
                on = noop;
                loadURL = async () => {};
            },
            Menu: { setApplicationMenu: noop },
            protocol: { registerSchemesAsPrivileged: noop, handle: noop },
            session: { defaultSession: { setPermissionCheckHandler: noop, setPermissionRequestHandler: noop } },
            ipcMain: { handle: noop, on: noop },
            dialog: { showErrorBox: () => assert.fail('Unexpected startup error') }
        };
        vm.runInNewContext(fs.readFileSync(main, 'utf8'), {
            require: name => name === 'electron' ? electron : name === 'node-pty' ? { spawn: noop } : requireMain(name),
            __dirname: path.dirname(main),
            process: { argv: [], platform }, console
        });
        await ready;
        const expected = path.join(root, 'src/assets', platform === 'win32' ? 'icon.ico' : 'icon.png');
        assert.equal(options.icon, expected);
        assert.ok(fs.statSync(expected).size > 0);
        if (platform === 'win32') {
            const manifest = require('../package.json');
            assert.equal(path.resolve(root, manifest.build.win.icon), expected, 'window and executable must use the same icon');
        }
    });
}

test('Windows icon contains native sizes from 16 to 256 pixels', () => {
    const ico = fs.readFileSync(path.join(root, 'src/assets/icon.ico'));
    const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), sizes.length);
    let offset = 6 + sizes.length * 16;
    sizes.forEach((size, index) => {
        const entry = 6 + index * 16;
        assert.equal(ico[entry] || 256, size);
        assert.equal(ico[entry + 1] || 256, size);
        assert.equal(ico.readUInt32LE(entry + 12), offset);
        const length = ico.readUInt32LE(entry + 8);
        const png = ico.subarray(offset, offset + length);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), size);
        assert.equal(png.readUInt32BE(20), size);
        offset += length;
    });
    assert.equal(offset, ico.length);
});
