/* Windows WebView2 automation. CDP is enabled only in the child test process. */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');

async function until(check, message, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try { const result = await check(); if (result) return result; }
        catch (error) { if (error.terminal) throw error; lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message, { cause: lastError });
}
function hasOutputLine(output, expected) {
    const clean = output.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[\d;]*[Hf]/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    return clean.split(/\r?\n/).some(line => line.trim() === expected);
}
async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}
// A listening but unresponsive endpoint must not defeat the outer startup deadline.
async function probeCdp(port, request = fetch) {
    return (await request(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
}
async function launch({ phase, clean = false, env = {}, scale } = {}) {
    assert.equal(process.platform, 'win32', 'The E2E harness requires Windows WebView2.');
    const profile = path.join(root, '.cache', phase ? 'tauri-restoration-profile' : 'tauri-smoke-profile');
    if (clean) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const target = process.env.CARGO_TARGET_DIR || path.join(root, 'target');
    const executable = path.resolve(root, target, 'debug/terminal-canvas.exe');
    await fs.access(executable);
    const port = await freePort();
    const args = [`--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'];
    if (scale) args.push(`--force-device-scale-factor=${scale}`);
    const child = spawn(executable, [phase ? `--restoration-smoke=${phase}` : '--smoke-test'], {
        cwd: root, env: { ...process.env, ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: args.join(' ') },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false
    });
    let logs = '', terminal = false, spawnError;
    child.stdout.on('data', data => { logs += data; });
    child.stderr.on('data', data => { logs += data; });
    const exited = new Promise(resolve => {
        child.once('error', error => { spawnError = error; terminal = true; resolve(null); });
        child.once('exit', code => { terminal = true; resolve(code); });
    });
    let browser;
    try {
        await until(async () => {
            if (terminal) throw Object.assign(spawnError || new Error(`Host exited before CDP was ready:\n${logs}`), { terminal: true });
            return probeCdp(port);
        }, 'WebView2 did not expose CDP.', 30000);
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
        const page = await until(() => browser.contexts().flatMap(context => context.pages())
            .find(page => page.url().startsWith('http://tauri.localhost/')), 'The main webview did not load.');
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForFunction(() => document.querySelector('.profile-button') && typeof workspace !== 'undefined');
        await page.evaluate(() => {
            window.__e2eEvents = [];
            window.terminalCanvas.onEvent(event => window.__e2eEvents.push(event));
        });
        return {
            page, child, profile, errors,
            logs: () => logs,
            state: () => page.evaluate(() => window.__TAURI__.core.invoke('e2e_state')),
            output: id => page.evaluate(id => window.__e2eEvents.filter(event => event.type === 'data' && (!id || event.id === id))
                .map(event => event.data).join(''), id),
            async waitExit() {
                await until(() => terminal, `Host did not exit.\n${logs}`, 10000);
                return exited;
            },
            async dispose() {
                try {
                    if (!terminal) {
                        await page.evaluate(() => { void window.terminalCanvas.invoke('close', workspace); }).catch(() => {});
                        await until(() => terminal, 'Host did not close.', 10000);
                    }
                } finally {
                    if (!terminal) { child.kill(); await exited; }
                    await browser.close().catch(() => {});
                }
                assert.deepEqual(errors, [], 'Renderer errors');
            }
        };
    } catch (error) {
        if (!terminal) child.kill();
        await exited;
        if (browser) await browser.close().catch(() => {});
        throw new Error(`${error.message}\nHost output:\n${logs}`, { cause: error });
    }
}
async function ensureFocus(page) {
    await page.bringToFront();
    await page.evaluate(() => window.__TAURI__.core.invoke('e2e_focus'));
    await until(() => page.evaluate(() => document.hasFocus()), 'The webview could not take focus.');
}
// Arm before sending native input; resolve in the next task after the final event's handlers.
async function sendInput(page, action, { type = 'pointerup', count = 1, point = null } = {}) {
    await ensureFocus(page);
    await page.evaluate(({ type, count, point }) => {
        window.__e2eInput = new Promise((resolve, reject) => {
            let seen = 0;
            const done = () => { window.removeEventListener(type, listener, true); clearTimeout(timer); };
            const listener = event => {
                if (point && (Math.abs(event.clientX - point.x) > 1 || Math.abs(event.clientY - point.y) > 1)) return;
                if (++seen === count) { done(); setTimeout(resolve, 0); }
            };
            const timer = setTimeout(() => { done(); reject(new Error(`Native ${type} did not reach the webview.`)); }, 5000);
            window.addEventListener(type, listener, true);
        });
        // Attach the rejection handler before native input, avoiding an unhandled rejection if input fails.
        window.__e2eInput.catch(() => {});
    }, { type, count, point });
    await action();
    await page.evaluate(() => window.__e2eInput);
}
async function click(page, point, modifiers = []) {
    return sendInput(page, async () => {
        for (const modifier of modifiers) await page.keyboard.down(modifier);
        try { await page.mouse.click(point.x, point.y); }
        finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
    }, { point });
}
async function key(page, chord) {
    return sendInput(page, () => page.keyboard.press(chord), { type: 'keyup', count: chord.split('+').length });
}
async function screenshot(page, name) {
    const file = path.join(root, '.cache', `tauri-${name}.png`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = await page.screenshot({ path: file });
    assert.ok(bytes.length > 100, 'Screenshot must contain a rendered image.');
    return file;
}
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
module.exports = { launch, until, probeCdp, hasOutputLine, ensureFocus, sendInput, click, key, screenshot, psQuote, root };
