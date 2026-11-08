const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createWorkspace, createCard } = require('../src/workspace.cjs');
const mainFile = path.resolve(__dirname, '../src/main.cjs');
const mainRequire = createRequire(mainFile);
const session = { provider: 'claude', sessionId: '12345678-1234-4321-9876-123456789abc', cwd: process.cwd() };

async function host(folder) {
    let ready, command, win;
    const appEvents = new Map(), messages = [], processes = [];
    const electron = {
        app: {
            enableSandbox() {}, on(name, fn) { appEvents.set(name, fn); },
            whenReady: () => ({ then(fn) { ready = Promise.resolve().then(fn); return ready; } }),
            getPath: name => name === 'home' ? process.cwd() : folder,
            quit() {}, exit() { assert.fail('Unexpected app startup failure'); }
        },
        BrowserWindow: class {
            constructor() { win = this; }
            events = new Map(); closed = false;
            isDestroyed() { return this.closed; }
            webContents = {
                events: new Map(), mainFrame: { url: '' },
                on(name, fn) { this.events.set(name, fn); }, setWindowOpenHandler() {},
                send(channel, payload) { messages.push({ channel, payload }); }
            };
            on(name, fn) { this.events.set(name, fn); }
            async loadURL(url) { this.webContents.mainFrame.url = url; }
            close() { this.events.get('close')({ preventDefault() {} }); this.closed = true; }
        },
        ipcMain: { handle(_channel, fn) { command = fn; }, on() {} },
        Menu: { setApplicationMenu() {} }, protocol: { registerSchemesAsPrivileged() {}, handle() {} },
        session: { defaultSession: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} } },
        dialog: { showErrorBox() { assert.fail('Unexpected startup error'); } }
    };
    const spawn = () => {
        const terminal = {
            pid: processes.length + 100, killed: false, writes: [],
            onData(fn) { this.data = fn; return { dispose() {} }; }, onExit(fn) { this.exit = fn; return { dispose() {} }; },
            write(data) { this.writes.push(data); }, kill() { this.killed = true; setImmediate(() => this.exit({ exitCode: 0 })); }
        };
        processes.push(terminal); return terminal;
    };
    vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), {
        require: name => name === 'electron' ? electron : name === 'node-pty' ? { spawn } : mainRequire(name),
        __dirname: path.dirname(mainFile), process: { argv: [], platform: process.platform }, console
    });
    await ready;
    const invoke = (action, payload) => command({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, action, payload);
    return { invoke, win, appEvents, messages, processes };
}
function locationAndSession(terminal, cwd) {
    const control = event => '\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07';
    terminal.data(control({ type: 'launch', provider: session.provider, token: session.sessionId, sessionId: session.sessionId, cwd }));
}

test('app quit follows normal close, flushes host metadata over stale layout, and reopens without spawning', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-host-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const first = await host(folder);
    await first.invoke('initialize');
    const board = createWorkspace(); const card = createCard({ cwd: process.cwd() }); board.cards.push(card);
    assert.equal((await first.invoke('autosave', board)).ok, true);
    assert.equal((await first.invoke('start', { card, cols: 80, rows: 24 })).error, undefined);
    locationAndSession(first.processes[0], process.cwd());
    let prevented = false;
    first.appEvents.get('before-quit')({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(first.messages.at(-1).payload.type, 'closing');
    board.name = 'Last change before debounce';
    assert.equal((await first.invoke('close', board)).ok, true);
    assert.equal(first.processes[0].killed, true);
    const saved = JSON.parse(fs.readFileSync(path.join(folder, 'workspace.terminalcanvas'), 'utf8'));
    assert.equal(saved.name, 'Last change before debounce');
    assert.deepEqual(saved.cards[0].session, session);
    const second = await host(folder);
    const restored = await second.invoke('initialize');
    assert.deepEqual(restored.workspace.cards[0].session, session);
    assert.equal(second.processes.length, 0);
});

test('renderer crashes preserve the last host-known workspace and session metadata', async t => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-crash-'));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    const first = await host(folder);
    await first.invoke('initialize');
    const board = createWorkspace(); const card = createCard(); board.cards.push(card);
    await first.invoke('autosave', board);
    await first.invoke('start', { card, cols: 80, rows: 24 });
    locationAndSession(first.processes[0], process.cwd());
    first.win.webContents.events.get('render-process-gone')();
    const deadline = Date.now() + 2000;
    while (!first.win.closed) {
        if (Date.now() > deadline) assert.fail('Crash snapshot did not finish');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(first.processes[0].killed, true);
    const second = await host(folder);
    const restored = await second.invoke('initialize');
    assert.equal(restored.workspace.cards.length, 1);
    assert.deepEqual(restored.workspace.cards[0].session, session);
    assert.equal(second.processes.length, 0);
});
