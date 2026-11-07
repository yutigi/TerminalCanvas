const { app, BrowserWindow, ipcMain, dialog, Menu, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { LIMITS, PROFILES, validateWorkspace, createWorkspace, createCard } = require('./workspace.cjs');
const { TerminalManager } = require('./terminal-manager.cjs');

const smoke = process.argv.includes('--smoke-test');
if (smoke) app.setPath('userData', path.resolve(__dirname, '../.cache/smoke-profile'));
app.enableSandbox();
let win, terminals, filename, quitting = false;
let writeQueue = Promise.resolve();
const shellUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const authorized = event => win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === shellUrl;
const emit = payload => { if (win && !win.isDestroyed()) win.webContents.send('terminal:event', payload); };
const recovery = () => path.join(app.getPath('userData'), 'workspace.terminalcanvas');
async function readWorkspace(file) {
    if ((await fs.stat(file)).size > LIMITS.bytes) throw new Error('Workspace files must be smaller than 1 MB.');
    return validateWorkspace(JSON.parse(await fs.readFile(file, 'utf8')));
}
function saveWorkspace(file, raw) {
    const board = validateWorkspace(raw);
    const task = writeQueue.then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(board, null, 2), { flag: 'wx' });
            await fs.rename(temporary, file);
        } finally { await fs.unlink(temporary).catch(() => {}); }
    });
    writeQueue = task.catch(() => {});
    return task;
}
async function command(action, payload) {
    if (action === 'clipboard-read') {
        const text = clipboard.readText();
        if (text.length > 64000) throw new Error('Paste is limited to 64,000 characters.');
        return { text };
    }
    if (action === 'clipboard-write') {
        if (typeof payload !== 'string' || payload.length > 1024 * 1024) throw new Error('Selection exceeds 1 MB.');
        clipboard.writeText(payload);
        return { ok: true };
    }
    if (action === 'initialize') {
        let workspace = createWorkspace(), warning;
        try { workspace = await readWorkspace(recovery()); }
        catch (error) { if (error.code !== 'ENOENT') warning = `Could not restore your last workspace: ${error.message}`; }
        return { workspace, profiles: PROFILES, home: app.getPath('home'), platform: process.platform, warning };
    }
    if (action === 'create-card') return { card: createCard(payload) };
    if (action === 'start') return terminals.start(payload?.card, payload?.cols, payload?.rows);
    if (action === 'stop') { terminals.stop(payload?.id); return { ok: true }; }
    if (action === 'pick-folder') {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a project folder' });
        return { path: result.canceled ? null : result.filePaths[0] };
    }
    if (action === 'autosave') { await saveWorkspace(recovery(), payload); return { ok: true }; }
    if (action === 'save' || action === 'save-as') {
        const board = validateWorkspace(payload);
        let target = action === 'save' ? filename : null;
        if (!target) {
            const result = await dialog.showSaveDialog(win, { title: 'Save workspace', defaultPath: `${board.name.replace(/[^\w -]/g, '') || 'Workspace'}.terminalcanvas`, filters: [{ name: 'Terminal Canvas workspace', extensions: ['terminalcanvas'] }] });
            if (result.canceled) return { canceled: true };
            target = result.filePath;
        }
        await saveWorkspace(target, board);
        filename = target;
        return { ok: true };
    }
    if (action === 'open') {
        const result = await dialog.showOpenDialog(win, { title: 'Open workspace', properties: ['openFile'], filters: [{ name: 'Terminal Canvas workspace', extensions: ['terminalcanvas', 'json'] }] });
        if (result.canceled) return { canceled: true };
        const workspace = await readWorkspace(result.filePaths[0]);
        terminals.stopAll();
        filename = result.filePaths[0];
        return { workspace };
    }
    if (action === 'new') { terminals.stopAll(); filename = null; return { workspace: createWorkspace() }; }
    if (action === 'close') {
        await saveWorkspace(recovery(), payload);
        terminals.stopAll();
        quitting = true;
        win.close();
        return { ok: true };
    }
    throw new Error('Unsupported desktop command.');
}
app.whenReady().then(async () => {
    const pty = require('node-pty');
    terminals = new TerminalManager({ spawn: pty.spawn, emit });
    Menu.setApplicationMenu(null);
    win = new BrowserWindow({
        width: 1500, height: 960, minWidth: 1000, minHeight: 680,
        title: 'Terminal Canvas', backgroundColor: '#111318', autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false }
    });
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ipcMain.handle('terminal:command', async (event, action, payload) => {
        if (!authorized(event)) throw new Error('Unauthorized caller.');
        try { return await command(action, payload); } catch (error) { return { error: error.message }; }
    });
    for (const [channel, method] of [['input', 'write'], ['resize', 'resize'], ['ack', 'acknowledge']]) {
        ipcMain.on(`terminal:${channel}`, (event, ...args) => {
            if (!authorized(event)) return;
            try { terminals[method](...args); } catch (error) { emit({ type: 'error', id: args[0], message: error.message }); }
        });
    }
    win.on('close', event => {
        if (!quitting && !smoke) { event.preventDefault(); emit({ type: 'closing', running: terminals.sessions.size }); }
        else terminals.stopAll();
    });
    win.webContents.on('render-process-gone', () => { terminals.stopAll(); quitting = true; win.close(); });
    await win.loadURL(shellUrl);
    if (smoke) require('../scripts/smoke.cjs').run({ app, win, terminals, createCard }).catch(error => { console.error(error); app.exit(1); });
}).catch(error => {
    console.error(error);
    dialog.showErrorBox('Terminal Canvas could not start', `${error.message}\n\nRun npm install and npm run rebuild, then try again.`);
    app.exit(1);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => terminals?.stopAll());
