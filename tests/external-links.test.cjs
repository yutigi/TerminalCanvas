const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real main-process command without starting Electron or a browser.
function desktop(openExternal) {
    const electron = {
        app: { enableSandbox() {}, whenReady: () => new Promise(() => {}), on() {} },
        protocol: { registerSchemesAsPrivileged() {} }, shell: { openExternal }
    };
    const context = vm.createContext({
        require: name => name === 'electron' ? electron : require(name.startsWith('./') ? path.join(__dirname, '../src', name) : name),
        __dirname: path.join(__dirname, '../src'), process: { argv: [] }, URL, console
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8'), context);
    return context;
}

test('desktop opens validated HTTP and HTTPS links with the default system handler', async () => {
    const opened = [];
    const context = desktop(async url => opened.push(url));
    for (const uri of ['https://github.com/yutigi/TerminalCanvas', 'http://localhost:4174/path?q=1#section', 'HTTPS://GITHUB.COM/a%20b']) {
        const result = await context.command('open-link', uri);
        assert.equal(result.ok, true);
        assert.equal(opened.at(-1), new URL(uri).href);
    }
    assert.equal(opened.length, 3);
});

test('desktop rejects unsupported, malformed, credential-bearing, and control-character links', async () => {
    const opened = [];
    const context = desktop(async url => opened.push(url));
    for (const uri of [
        undefined, null, {}, 42, '', 'not a URL', '/relative', '//github.com',
        'javascript:alert(1)', 'data:text/html,hello', 'file:///C:/Windows/notepad.exe',
        'mailto:someone@example.com', 'vscode://file/C:/test', 'ftp://example.com',
        'https:', 'https://', 'https:github.com', 'http://[invalid]', 'https://github.com:99999',
        'https://user:password@github.com', 'https://user@github.com',
        ' https://github.com', 'https://github.com/a b', 'https://git\nhub.com', 'https://github.com/\u0000'
    ]) {
        await assert.rejects(context.command('open-link', uri), undefined, String(uri));
    }
    assert.deepEqual(opened, []);
});

test('desktop propagates browser-launch failures to the existing IPC error path', async () => {
    const failure = new Error('No default browser available.');
    const context = desktop(async () => { throw failure; });
    await assert.rejects(context.command('open-link', 'https://github.com'), error => error === failure);
});

test('desktop authorization still requires the application main frame', () => {
    const context = desktop(async () => {});
    vm.runInContext(`
        win = { isDestroyed: () => false, webContents: { mainFrame: { url: shellUrl } } };
        globalThis.event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
    `, context);
    assert.equal(vm.runInContext('authorized(event)', context), true);
    assert.equal(vm.runInContext('authorized({ ...event, sender: {} })', context), false);
    assert.equal(vm.runInContext('authorized({ ...event, senderFrame: { url: shellUrl } })', context), false);
    assert.equal(vm.runInContext('event.senderFrame.url = "https://example.com"; authorized(event)', context), false);
});
