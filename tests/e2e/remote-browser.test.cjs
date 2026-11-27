/* Real packaged renderer, loopback authentication, browser keyboard input, and a native PTY. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { X509Certificate } = require('node:crypto');
const { chromium } = require('playwright-core');
const { image } = require('./fixtures.cjs');
const { launch, until, hasOutputLine, root } = require('./harness.cjs');
const { choose } = require('./support.cjs');

async function visibleTerminalLine(page, id, text) {
    return page.evaluate(({ id, text }) => {
        const screen = sessions.get(id)?.element.querySelector('.xterm-screen');
        const rows = screen?.querySelectorAll('.xterm-rows > div');
        return [...(rows || [])].some(row => {
            if (row.textContent.trim() !== text) return false;
            const range = document.createRange();
            range.selectNodeContents(row);
            const { left, top, width, height } = range.getBoundingClientRect();
            if (!width || !height || !row.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
            // xterm's rendered rows ignore pointer events. Hit-test their screen for clipping or overlays.
            return screen.contains(document.elementFromPoint(left + width / 2, top + height / 2));
        });
    }, { id, text });
}

test('loopback controller manages and types in shared terminals while the viewer follows output', {
    skip: process.platform !== 'win32', timeout: 120000
}, async t => {
    // Do not delete an existing profile: all work stays in the harness's isolated E2E profile.
    const h = await launch({ clean: false }); t.after(() => h.dispose());
    assert.equal((await h.page.evaluate(() => invoke('remote-status'))).running, false);
    const folder = path.join(root, '.cache', 'tauri-e2e-remote-project');
    await fs.mkdir(folder, { recursive: true });
    const card = await h.page.evaluate(async folder => {
        const { workspace: board, titleEpoch } = await invoke('new');
        loadWorkspace(board, titleEpoch);
        const { card } = await invoke('create-card', { cwd: folder, title: 'Browser control smoke', x: 35, y: 25 });
        workspace.cards.push(card); mount(card); renderCamera();
        await start(card); await invoke('autosave', workspace);
        return card;
    }, folder);
    await until(async () => !(await h.page.evaluate(card => invoke('duplicate-directory', card), card)).warning,
        'The isolated PowerShell did not reach its prompt.');
    await h.page.evaluate(id => window.terminalCanvas.input(id,
        "Write-Output 'REMOTE_OLD_SCROLLBACK'; 1..40 | ForEach-Object { Write-Output $_ }; Write-Output 'REMOTE_BEFORE_START'\r"), card.id);
    await until(async () => hasOutputLine(await h.output(card.id), 'REMOTE_BEFORE_START'),
        'The desktop PTY did not produce the line before Browser access started.');
    await until(() => visibleTerminalLine(h.page, card.id, 'REMOTE_BEFORE_START'),
        'The desktop did not render the line written before Browser access started.');
    // Simulate the hidden cursor mode used by a full-screen program.
    await h.page.evaluate(id => new Promise(resolve => {
        sessions.get(id).terminal.write('\x1b[?25l', resolve);
    }), card.id);
    if (!await h.page.locator('#remote-settings').isVisible()) await h.page.locator('#sidebar-toggle').click();
    await h.page.locator('#remote-settings').click();
    await h.page.locator('#remote-start-stop').click();
    const access = await until(async () => {
        const status = await h.page.evaluate(() => invoke('remote-status'));
        return status.running && status;
    }, 'Browser access did not start.');
    await h.page.locator('#remote-done').click();

    const browser = await chromium.launch({ channel: 'msedge', headless: true,
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    t.after(() => browser.close());
    const controllerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const controller = await controllerContext.newPage(), browserErrors = [], browserConsole = [];
    const browserInput = [];
    controller.on('websocket', socket => {
        socket.on('framesent', ({ payload }) => {
            const message = JSON.parse(payload);
            if (message.action === 'input') browserInput.push(message.data);
        });
    });
    controller.on('pageerror', error => browserErrors.push(error.message));
    controller.on('console', message => {
        if (message.type() === 'error') browserConsole.push(message.text());
    });
    await controller.goto(access.url);
    await controller.locator('#pair-token').fill(access.controlToken);
    await controller.locator('#pair-submit').click();
    try {
        await controller.waitForFunction(() => typeof ready !== 'undefined' && ready && window.terminalCanvas.remote);
    } catch (error) {
        t.diagnostic(JSON.stringify({ browserErrors, browserConsole, state: await controller.evaluate(() => ({
            ready: typeof ready === 'undefined' ? 'undefined' : ready,
            remote: window.terminalCanvas?.remote,
            toast: document.querySelector('#toast')?.textContent,
            loginError: document.querySelector('#pair-error')?.textContent
        })) }));
        throw error;
    }
    await controller.waitForFunction(id => sessions.get(id)?.status === 'running', card.id);
    assert.equal(await controller.evaluate(() => window.terminalCanvas.role), 'control');
    await until(() => visibleTerminalLine(controller, card.id, 'REMOTE_BEFORE_START'),
        'The controller did not render the desktop screen present before Browser access started.');
    assert.equal(await controller.evaluate(id => {
        const buffer = sessions.get(id).terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true))
            .includes('REMOTE_OLD_SCROLLBACK');
    }, card.id), false, 'Browser access shared pre-start scrollback outside the terminal screen.');
    await controller.screenshot({ path: path.join(root, '.cache', 'tauri-remote-browser-initial.png') });
    const conflicting = await controllerContext.newPage();
    conflicting.on('pageerror', error => browserErrors.push(error.message));
    await conflicting.goto(access.url);
    await conflicting.waitForFunction(() => document.querySelector('#toast').textContent.includes('Only one controller'));
    await conflicting.close();
    const desktopSize = await h.page.evaluate(id => {
        const s = sessions.get(id); return { cols: s.terminal.cols, rows: s.terminal.rows };
    }, card.id);
    assert.deepEqual(await controller.evaluate(id => {
        const s = sessions.get(id); return { cols: s.terminal.cols, rows: s.terminal.rows };
    }, card.id), desktopSize);
    const controllerScreen = controller.locator(`.terminal-card[data-id="${card.id}"] .xterm-screen`);
    await controllerScreen.click();
    assert.equal(await controller.locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement), true,
        'Clicking a browser terminal should focus its input.');
    assert.equal(await controller.locator('.xterm-cursor').count(), 0,
        'Focusing the browser mirror drew a cursor over the TUI’s hidden cursor cell.');
    // Let a DA2 query finish during a trusted keydown. Only the desktop should reply to it.
    await controller.evaluate(id => {
        const s = sessions.get(id);
        s.element.addEventListener('keydown', () => s.terminal._core._inputHandler.parse('\x1b[>c'),
            { capture: true, once: true });
    }, card.id);
    await controller.keyboard.press('Shift');
    assert.ok(!browserInput.some(data => data.startsWith('\x1b[>')),
        'The browser forwarded its device-attributes reply to the shared PTY.');
    await controller.keyboard.type("Write-Output 'REMOTE_BROWSER_INPUT'");
    await controller.keyboard.press('Enter');
    await until(async () => hasOutputLine(await h.output(card.id), 'REMOTE_BROWSER_INPUT'),
        'Browser keyboard input did not reach the desktop PTY.');

    await until(() => visibleTerminalLine(controller, card.id, 'REMOTE_BROWSER_INPUT'),
        'The controller did not render the result of browser typing.');
    assert.ok(browserInput.length > 0, 'The browser did not send any keyboard input.');

    const viewerContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const viewer = await viewerContext.newPage();
    viewer.on('pageerror', error => browserErrors.push(error.message));
    await viewer.goto(access.url);
    await viewer.locator('#pair-token').fill(access.viewToken); await viewer.locator('#pair-submit').click();
    await viewer.waitForFunction(() => typeof ready !== 'undefined' && ready && window.terminalCanvas.remote);
    assert.equal(await viewer.evaluate(() => window.terminalCanvas.role), 'view');
    assert.equal(await viewer.evaluate(id => sessions.get(id).terminal.options.disableStdin, card.id), true);
    assert.equal(await viewer.locator('#add-terminal').isVisible(), false);
    assert.equal(await viewer.locator(`[data-id="${card.id}"] [data-action="toggle"]`).isVisible(), false);
    assert.match((await viewer.evaluate(() => window.terminalCanvas.invoke('remote-terminal', {
        epoch: titleEpoch, command: { action: 'launch', canvasId: null, options: { title: 'Viewer launch' } }
    }))).error, /read-only/);
    await h.page.evaluate(id => window.terminalCanvas.input(id, "Write-Output 'REMOTE_SHARED_OUTPUT'\r"), card.id);
    await until(() => visibleTerminalLine(controller, card.id, 'REMOTE_SHARED_OUTPUT'),
        'The controller did not render live desktop output.');
    await until(() => visibleTerminalLine(viewer, card.id, 'REMOTE_SHARED_OUTPUT'),
        'The viewer did not render live desktop output.');
    await until(() => visibleTerminalLine(viewer, card.id, 'REMOTE_BEFORE_START'),
        'The viewer did not render the desktop screen present before Browser access started.');
    // A new desktop canvas must arrive without replacing existing browser emulators or navigation.
    await controller.evaluate(id => {
        window.__originalTerminal = sessions.get(id).terminal;
    }, card.id);
    const secondCanvas = await h.page.evaluate(async () => {
        const canvas = createCanvas('Remote second canvas');
        const { card } = await invoke('create-card', { title: 'Second canvas terminal', x: 40, y: 30 });
        workspace.cards.push(card); mount(card); refresh(); await invoke('autosave', workspace);
        return canvas.id;
    });
    await controller.waitForFunction(id => canvasStates.some(canvas => canvas.id === id), secondCanvas);
    await viewer.waitForFunction(id => canvasStates.some(canvas => canvas.id === id), secondCanvas);
    const firstCanvas = await controller.evaluate(id => sessions.get(id).canvas.id, card.id);
    assert.equal(await controller.evaluate(() => activeCanvas.id), firstCanvas);
    assert.equal(await controller.evaluate(id => sessions.get(id).terminal === window.__originalTerminal, card.id), true);
    assert.equal(await controller.locator('#canvas-add').isVisible(), true);
    assert.equal(await viewer.locator('#canvas-add').isVisible(), false);
    await controller.locator('#canvas-list').selectOption(secondCanvas);
    await viewer.locator('#canvas-list').selectOption(secondCanvas);
    assert.equal(await controller.evaluate(id => sessions.get(id).element.hidden, card.id), true);
    await h.page.evaluate(id => window.terminalCanvas.input(id, "Write-Output 'REMOTE_HIDDEN_OUTPUT'\r"), card.id);
    const seesHiddenOutput = page => page.evaluate(id => {
        const buffer = sessions.get(id).terminal.buffer.active;
        return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true)).includes('REMOTE_HIDDEN_OUTPUT');
    }, card.id);
    await until(() => seesHiddenOutput(controller), 'Hidden controller terminal lost output.');
    await until(() => seesHiddenOutput(viewer), 'Hidden viewer terminal lost output.');
    await controller.locator('#canvas-list').selectOption(firstCanvas);
    await controllerScreen.click();
    await controller.keyboard.type("Write-Output 'REMOTE_OTHER_CANVAS_INPUT'");
    await controller.keyboard.press('Enter');
    await until(async () => hasOutputLine(await h.output(card.id), 'REMOTE_OTHER_CANVAS_INPUT'),
        'Browser input did not reach a terminal on the hidden desktop canvas.');
    assert.equal(await h.page.evaluate(() => activeCanvas.id), secondCanvas);
    assert.equal(await viewer.evaluate(() => activeCanvas.id), secondCanvas);
    assert.deepEqual(await controller.evaluate(id => {
        const s = sessions.get(id); return { cols: s.terminal.cols, rows: s.terminal.rows };
    }, card.id), desktopSize);

    // The controller creates on its visible canvas even while the desktop is on another one.
    await controller.locator('#add-terminal').click();
    await controller.locator('#terminal-title').fill('Launched from browser');
    await controller.locator('#cwd').fill(folder);
    await controller.locator('#command').fill("Write-Output 'REMOTE_LAUNCH_COMMAND'");
    await controller.locator('#launch-submit').click();
    const { id: remoteId, error: launchError } = await until(() => controller.evaluate(() => {
        const error = document.querySelector('#launch-error');
        if (!error.hidden) return { error: error.textContent };
        const card = workspace.cards.find(card => card.title === 'Launched from browser');
        return card && { id: card.id };
    }),
        'The controller did not create a terminal.');
    assert.ok(remoteId, launchError);
    await controller.waitForFunction(id => !document.querySelector('#launch-dialog').open && sessions.get(id)?.status === 'running', remoteId);
    await until(async () => hasOutputLine(await h.output(remoteId), 'REMOTE_LAUNCH_COMMAND'),
        'The browser launch command did not reach a native PTY.');
    assert.deepEqual(await h.page.evaluate(id => ({ active: activeCanvas.id, owner: sessions.get(id).canvas.id }), remoteId),
        { active: secondCanvas, owner: firstCanvas });
    await viewer.waitForFunction(id => sessions.get(id)?.status === 'running', remoteId);
    assert.equal(await controller.evaluate(id => sessions.get(id).element.contains(document.activeElement), remoteId), true);
    await controller.keyboard.type("Write-Output 'REMOTE_NEW_TERMINAL_INPUT'");
    await controller.keyboard.press('Enter');
    await until(async () => hasOutputLine(await h.output(remoteId), 'REMOTE_NEW_TERMINAL_INPUT'),
        'The browser-created terminal did not accept keyboard input.');
    const remoteCard = controller.locator(`.terminal-card[data-id="${remoteId}"]`);
    await remoteCard.locator('[data-action="toggle"]').click();
    await controller.waitForFunction(id => sessions.get(id)?.status === 'exited', remoteId);
    await viewer.waitForFunction(id => sessions.get(id)?.status === 'exited', remoteId);
    await remoteCard.locator('[data-action="fresh-shell"]').click();
    await controller.waitForFunction(id => sessions.get(id)?.status === 'running', remoteId);
    await remoteCard.locator('[data-action="close"]').click();
    await controller.locator('#confirm-ok').click();
    for (const page of [controller, viewer, h.page]) await page.waitForFunction(id => !sessions.has(id), remoteId);
    assert.equal((await h.state()).host.workspace.cards.some(card => card.id === remoteId), false);
    await until(async () => {
        const recovery = JSON.parse(await fs.readFile(path.join(h.profile, 'workspace.terminalcanvas'), 'utf8'));
        return !recovery.cards.some(card => card.id === remoteId);
    }, 'Closing from the browser did not remove the terminal from recovery.');
    assert.equal(await h.page.evaluate(() => activeCanvas.id), secondCanvas);

    // Removing a desktop canvas falls back locally without breaking the surviving terminal.
    await h.page.evaluate(async () => {
        const removing = deleteCanvas(); finishConfirm(true); await removing;
        await invoke('autosave', workspace);
    });
    await viewer.waitForFunction(id => activeCanvas.id === id && canvasStates.length === 1, firstCanvas);
    await controller.waitForFunction(() => canvasStates.length === 1);
    assert.equal(await controller.evaluate(id => sessions.get(id).terminal === window.__originalTerminal, card.id), true);
    await controller.locator('#canvas-add').click();
    await h.page.waitForFunction(() => canvasStates.length === 2);
    await viewer.waitForFunction(() => canvasStates.length === 2);
    assert.equal(await h.page.evaluate(() => activeCanvas.id), firstCanvas);
    await controller.locator('#canvas-rename').click();
    await controller.locator('#canvas-name').fill('Browser canvas');
    await controller.locator('#canvas-name').press('Enter');
    await viewer.waitForFunction(() => canvasStates.some(canvas => canvas.name === 'Browser canvas'));
    await controller.locator('[data-tool="rect"]').click();
    await controller.locator('#viewport').click({ position: { x: 260, y: 210 } });
    await h.page.waitForFunction(() => canvasStates.find(canvas => canvas.name === 'Browser canvas')?.board.items.some(item => item.shape === 'rect'));
    const imagePicker = controller.waitForEvent('filechooser');
    await controller.locator('#image-tool').click();
    await (await imagePicker).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
    await h.page.waitForFunction(() => canvasStates.find(canvas => canvas.name === 'Browser canvas')?.board.items.some(item => item.type === 'image'));
    const saved = controller.waitForEvent('download');
    await controller.locator('#save').click();
    const file = await (await saved).path();
    const downloaded = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.ok(downloaded.canvases.some(canvas => canvas.name === 'Browser canvas'));
    assert.ok(downloaded.items.some(item => item.shape === 'rect'));
    assert.ok(downloaded.items.some(item => item.type === 'image'));
    await controller.locator('#remote-settings').click();
    assert.equal(await controller.locator('#remote-limitations').isVisible(), true);
    await controller.locator('#remote-limitations button').click();
    await until(async () => (await h.page.evaluate(() => invoke('remote-status'))).clients === 2,
        'Desktop did not report both clients.');
    await controller.screenshot({ path: path.join(root, '.cache', 'tauri-remote-browser-controller.png') });
    await h.page.screenshot({ path: path.join(root, '.cache', 'tauri-remote-browser-desktop.png') });
    assert.ok((await controller.evaluate(() => window.terminalCanvas.invoke('close', {}))).error);
    assert.equal(await h.page.evaluate(() => ready), true);
    const openPicker = controller.waitForEvent('filechooser');
    await controller.locator('#open-workspace').click();
    const replacement = { ...downloaded, name: 'Reopened from browser' };
    await (await openPicker).setFiles({ name: 'browser-copy.terminalcanvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replacement)) });
    await controller.locator('#confirm-ok').click();
    await h.page.waitForFunction(() => workspace.name === 'Reopened from browser');
    await viewer.waitForFunction(() => workspace.name === 'Reopened from browser');
    await h.page.evaluate(() => invoke('remote-rotate'));
    await controller.waitForFunction(() => document.querySelector('#remote-banner').textContent.includes('closed'));
    await viewer.waitForFunction(() => document.querySelector('#remote-banner').textContent.includes('closed'));
    await h.page.evaluate(() => invoke('remote-stop'));
    assert.equal((await h.page.evaluate(() => invoke('remote-status'))).running, false);
    assert.deepEqual(browserErrors, []);
});

const privateAddress = Object.values(os.networkInterfaces()).flat().find(entry => !entry.internal && entry.family === 'IPv4'
    && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;

test('network browser access pairs using HTTPS on the selected private interface', {
    skip: process.platform !== 'win32' || !privateAddress, timeout: 60000
}, async t => {
    const h = await launch(); t.after(() => h.dispose());
    const result = await h.page.evaluate(address => invoke('remote-start', { port: 0, address }), privateAddress);
    assert.equal(result.https, true);
    assert.equal(new URL(result.url).hostname, privateAddress);
    const file = path.join(root, '.cache', 'tauri-remote-browser-test.cer');
    await choose(h.page, file);
    await h.page.evaluate(() => invoke('remote-certificate'));
    const ca = new X509Certificate(await fs.readFile(file)).toString();
    const login = (options = {}) => new Promise((resolve, reject) => {
        const request = https.request(`${result.url}/login`, {
            method: 'POST', headers: { Origin: result.url, 'Content-Type': 'application/json' }, ...options
        }, response => { response.resume(); resolve(response); });
        request.on('error', reject);
        request.end(JSON.stringify({ token: result.controlToken }));
    });
    await assert.rejects(login(), /verify|certificate/i);
    const response = await login({ ca });
    assert.equal(response.statusCode, 204);
    assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
    assert.equal((await login({ ca, headers: { Origin: 'https://wrong.example', 'Content-Type': 'application/json' } })).statusCode, 403);
    const browser = await chromium.launch({ channel: 'msedge', headless: true,
        args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    t.after(() => browser.close());
    // The request above verifies the exported trust root. This isolated browser context tests WSS.
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(result.url);
    await page.locator('#pair-token').fill(result.viewToken);
    await page.locator('#pair-submit').click();
    await page.waitForFunction(() => typeof ready !== 'undefined' && ready && window.terminalCanvas.role === 'view');
    assert.equal(await page.evaluate(async () => (await fetch('/upload-image', { method: 'POST', body: 'image' })).status), 403);
    await h.page.evaluate(() => invoke('remote-stop'));
    assert.equal((await h.page.evaluate(() => invoke('remote-status'))).running, false);
});
