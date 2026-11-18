/* Real packaged renderer, loopback authentication, browser keyboard input, and a native PTY. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { launch, until, hasOutputLine, root } = require('./harness.cjs');

test('loopback controller and viewer share the desktop PTY without sharing ownership', {
    skip: process.platform !== 'win32', timeout: 120000
}, async t => {
    // Do not delete an existing profile: all work stays in the harness's isolated E2E profile.
    const h = await launch({ clean: false }); t.after(() => h.dispose());
    assert.equal((await h.page.evaluate(() => invoke('remote-status'))).running, false);
    const folder = path.join(root, '.cache', 'tauri-e2e-remote-project');
    await fs.mkdir(folder, { recursive: true });
    const card = await h.page.evaluate(async folder => {
        loadWorkspace((await invoke('new')).workspace);
        const { card } = await invoke('create-card', { cwd: folder, title: 'Browser control smoke', x: 35, y: 25 });
        workspace.cards.push(card); mount(card); renderCamera();
        await start(card); await invoke('autosave', workspace);
        return card;
    }, folder);
    await until(async () => !(await h.page.evaluate(card => invoke('duplicate-directory', card), card)).warning,
        'The isolated PowerShell did not reach its prompt.');
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
    await controller.evaluate(id => {
        window.__remoteInputProbe = [];
        const s = sessions.get(id);
        s.terminal.onData(() => window.__remoteInputProbe.push({ phase: 'data', userInput: s.userInput }));
        s.element.addEventListener('keydown', () => window.__remoteInputProbe.push({ phase: 'keydown', userInput: s.userInput }), true);
    }, card.id);
    await controller.locator('.xterm-helper-textarea').focus();
    await controller.keyboard.type("Write-Output 'REMOTE_BROWSER_INPUT'");
    await controller.keyboard.press('Enter');
    try {
        await until(async () => hasOutputLine(await h.output(card.id), 'REMOTE_BROWSER_INPUT'),
            'Browser keyboard input did not reach the desktop PTY.');
    } catch (error) {
        t.diagnostic(JSON.stringify(await controller.evaluate(() => window.__remoteInputProbe.slice(-8))));
        throw error;
    }

    const viewerContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const viewer = await viewerContext.newPage();
    viewer.on('pageerror', error => browserErrors.push(error.message));
    await viewer.goto(access.url);
    await viewer.locator('#pair-token').fill(access.viewToken); await viewer.locator('#pair-submit').click();
    await viewer.waitForFunction(() => typeof ready !== 'undefined' && ready && window.terminalCanvas.remote);
    assert.equal(await viewer.evaluate(() => window.terminalCanvas.role), 'view');
    assert.equal(await viewer.evaluate(id => sessions.get(id).terminal.options.disableStdin, card.id), true);
    await h.page.evaluate(id => window.terminalCanvas.input(id, "Write-Output 'REMOTE_SHARED_OUTPUT'\r"), card.id);
    const seesOutput = page => page.evaluate(id => {
        const buffer = sessions.get(id)?.terminal?.buffer.active;
        return buffer && Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true)).includes('REMOTE_SHARED_OUTPUT');
    }, card.id);
    await until(() => seesOutput(controller), 'Controller did not receive desktop output.');
    await until(() => seesOutput(viewer), 'Viewer did not receive desktop output.');
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
    assert.equal(await controller.locator('#canvas-add').isVisible(), false);
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
    await controller.locator(`.terminal-card[data-id="${card.id}"] .xterm-helper-textarea`).focus();
    await controller.keyboard.type("Write-Output 'REMOTE_OTHER_CANVAS_INPUT'");
    await controller.keyboard.press('Enter');
    await until(async () => hasOutputLine(await h.output(card.id), 'REMOTE_OTHER_CANVAS_INPUT'),
        'Browser input did not reach a terminal on the hidden desktop canvas.');
    assert.equal(await h.page.evaluate(() => activeCanvas.id), secondCanvas);
    assert.equal(await viewer.evaluate(() => activeCanvas.id), secondCanvas);
    assert.deepEqual(await controller.evaluate(id => {
        const s = sessions.get(id); return { cols: s.terminal.cols, rows: s.terminal.rows };
    }, card.id), desktopSize);
    // Removing a desktop canvas falls back locally without breaking the surviving terminal.
    await h.page.evaluate(async () => {
        const removing = deleteCanvas(); finishConfirm(true); await removing;
        await invoke('autosave', workspace);
    });
    await viewer.waitForFunction(id => activeCanvas.id === id && canvasStates.length === 1, firstCanvas);
    await controller.waitForFunction(() => canvasStates.length === 1);
    assert.equal(await controller.evaluate(id => sessions.get(id).terminal === window.__originalTerminal, card.id), true);
    await until(async () => (await h.page.evaluate(() => invoke('remote-status'))).clients === 2,
        'Desktop did not report both clients.');
    await controller.screenshot({ path: path.join(root, '.cache', 'tauri-remote-browser-controller.png') });
    await h.page.screenshot({ path: path.join(root, '.cache', 'tauri-remote-browser-desktop.png') });
    assert.ok((await controller.evaluate(() => window.terminalCanvas.invoke('close', {}))).error);
    assert.equal(await h.page.evaluate(() => ready), true);
    await h.page.evaluate(() => invoke('remote-rotate'));
    await controller.waitForFunction(() => document.querySelector('#remote-banner').textContent.includes('closed'));
    await viewer.waitForFunction(() => document.querySelector('#remote-banner').textContent.includes('closed'));
    await h.page.evaluate(() => invoke('remote-stop'));
    assert.equal((await h.page.evaluate(() => invoke('remote-status'))).running, false);
    assert.deepEqual(browserErrors, []);
});
