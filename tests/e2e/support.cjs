const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { until, root } = require('./harness.cjs');

async function withSavedClipboard(task) {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(__dirname, 'clipboard-guard.ps1')], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '', errors = '', ended = false, failure;
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.stdin.on('error', error => { errors += error.message; });
    const exited = new Promise(resolve => {
        child.once('error', error => { failure = error; ended = true; resolve(null); });
        child.once('exit', code => { ended = true; resolve(code); });
    });
    try {
        await until(() => {
            if (ended) throw Object.assign(failure || new Error(`Clipboard snapshot failed: ${errors}`), { terminal: true });
            return output.includes('CLIPBOARD_SAVED');
        }, 'Clipboard snapshot did not finish.');
        return await task();
    } finally {
        if (!ended) child.stdin.end('restore\n');
        await until(() => ended, 'Clipboard guard did not restore the clipboard.');
        assert.equal(await exited, 0, `Clipboard guard failed: ${errors}`);
        assert.ok(output.includes('CLIPBOARD_RESTORED'), errors);
    }
}
async function fixtureScene(page, cards) {
    return page.evaluate(async cards => {
        loadWorkspace((await invoke('new')).workspace);
        for (const options of cards) {
            const { card } = await invoke('create-card', options);
            workspace.cards.push(card); mount(card); setStatus(card, 'exited');
        }
        renderCamera();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return workspace.cards;
    }, cards);
}
async function cellPoint(page, id, col, row, fraction = .5) {
    return page.evaluate(({ id, col, row, fraction }) => {
        const s = sessions.get(id), rect = s.element.querySelector('.xterm-screen').getBoundingClientRect();
        const x = Math.round(rect.left + (col + fraction) * rect.width / s.terminal.cols);
        const y = Math.round(rect.top + (row + .5) * rect.height / s.terminal.rows);
        return { x, y, visible: document.elementFromPoint(x, y)?.closest('.terminal-card') === s.element };
    }, { id, col, row, fraction });
}
const writeTerminal = (page, id, text) => page.evaluate(({ id, text }) => new Promise(resolve => sessions.get(id).terminal.write(text, resolve)), { id, text });
const clipboardRead = page => page.evaluate(() => invoke('clipboard-read').then(result => result.text.replace(/\r\n/g, '\n')));
const clipboardWrite = (page, text) => page.evaluate(text => invoke('clipboard-write', text), text);
const choose = (page, path = null) => page.evaluate(path => window.__TAURI__.core.invoke('e2e_dialog', { path }), path);
const input = (page, id, data) => page.evaluate(({ id, data }) => window.terminalCanvas.input(id, data), { id, data });
async function startTerminal(page, options = {}) {
    return page.evaluate(async options => {
        const { card } = await invoke('create-card', options);
        workspace.cards.push(card); mount(card); await start(card); return card;
    }, options);
}
module.exports = { withSavedClipboard, fixtureScene, cellPoint, writeTerminal, clipboardRead, clipboardWrite, choose, input, startTerminal, root };
