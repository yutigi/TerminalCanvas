const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { launch, until, hasOutputLine, sendInput, click, key, screenshot, psQuote, root } = require('./harness.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 120000 };
const { image } = require('./fixtures.cjs');
const { powerShellLiteral } = require('../baseline/support.cjs');

async function newTerminal(h, title = 'E2E terminal') {
    const folder = path.join(root, '.cache', 'tauri-e2e-project');
    await fs.mkdir(folder, { recursive: true });
    const card = await h.page.evaluate(async ({ folder, title }) => {
        loadWorkspace((await invoke('new')).workspace);
        const { card } = await invoke('create-card', { cwd: folder, title, x: 20, y: 20 });
        workspace.cards.push(card); mount(card); renderCamera();
        await start(card);
        return card;
    }, { folder, title });
    await until(async () => {
        const choice = await h.page.evaluate(card => invoke('duplicate-directory', card), card);
        return !choice.warning;
    }, 'Integrated PowerShell did not reach an idle prompt.');
    return card;
}
async function ioFixture(h) {
    const card = await newTerminal(h);
    const fixture = path.join(__dirname, 'io-fixture.cjs');
    await h.page.evaluate(({ id, command }) => window.terminalCanvas.input(id, command + '\r'), {
        id: card.id, command: `& ${psQuote(process.execPath)} ${psQuote(fixture)}`
    });
    const matched = await until(async () => (await h.output(card.id)).match(/IO_READY (\d+) (\d+)/), 'The controlled child did not start.');
    return { card, pids: matched.slice(1).map(Number) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const scale of [1, 1.25, 1.5]) {
    test(`WebView2 board, image protocol, native note typing, grouping and zoom (scale ${scale})`, windows, async t => {
        const h = await launch({ clean: true, scale }); t.after(() => h.dispose());
        assert.equal(await h.page.evaluate(() => typeof window.Terminal), 'function');
        assert.equal(await h.page.evaluate(() => typeof window.require), 'undefined');
        const asset = await h.page.evaluate(async image => {
            const bytes = Uint8Array.from(atob(image), char => char.charCodeAt(0));
            return (await invoke('import-image', { bytes })).asset;
        }, image);
        await h.page.evaluate(asset => {
            loadWorkspace({ version: 3, name: 'WebView2 board smoke', camera: { x: 40, y: 30, z: .8 }, cards: [], items: [
                { id: 'note', type: 'note', x: 0, y: 0, w: 220, h: 130, text: 'Write the release notes' },
                { id: 'box', type: 'shape', shape: 'rect', x: 300, y: 0, w: 180, h: 120, text: 'Host' },
                { id: 'photo', type: 'image', x: 0, y: 220, w: 160, h: 120, asset }
            ] });
        }, asset);
        await h.page.waitForFunction(() => {
            const image = document.querySelector('.item-image img'); return image?.complete && image.naturalWidth > 0;
        });
        const cleanup = await h.page.evaluate(asset => invoke('unused-images', { keep: [asset] }), asset);
        assert.equal(cleanup.count, 0);
        await h.page.evaluate(() => { select('note'); select('box', { additive: true }); viewport.focus(); });
        await key(h.page, 'Control+g');
        const group = await h.page.evaluate(() => findItem('note').groups?.[0]);
        assert.ok(group);
        assert.equal(await h.page.evaluate(() => findItem('box').groups?.[0]), group);
        await key(h.page, 'Control+z');
        assert.equal(await h.page.evaluate(() => findItem('note').groups ?? null), null);
        await key(h.page, 'Control+Shift+z');
        assert.equal(await h.page.evaluate(() => findItem('note').groups?.[0]), group);
        const point = await h.page.evaluate(() => {
            setTool('note'); const r = viewport.getBoundingClientRect();
            return { x: r.x + workspace.camera.x + 600 * workspace.camera.z, y: r.y + workspace.camera.y + 400 * workspace.camera.z };
        });
        await click(h.page, point);
        assert.equal(await h.page.evaluate(() => document.activeElement.className), 'item-editor');
        await sendInput(h.page, () => h.page.keyboard.type('native note'), { type: 'keyup', count: 11 });
        assert.equal(await h.page.evaluate(() => document.activeElement.value), 'native note');
        await h.page.evaluate(() => { document.activeElement.blur(); setTool('select'); viewport.focus(); });
        assert.equal(await h.page.evaluate(() => workspace.items.at(-1).text), 'native note', 'Leaving the editor commits native typing');
        const before = await h.page.evaluate(() => ({ z: workspace.camera.z, ratio: devicePixelRatio }));
        await h.page.keyboard.down('Control');
        try { await h.page.mouse.wheel(0, -120); } finally { await h.page.keyboard.up('Control'); }
        await until(async () => (await h.page.evaluate(() => workspace.camera.z)) !== before.z, 'Ctrl+wheel did not reach the canvas.');
        assert.equal(await h.page.evaluate(() => devicePixelRatio), before.ratio, 'Browser zoom must remain disabled.');
        await screenshot(h.page, `board-${scale}`);
    });
}

test('native first-click typing reaches xterm and shell directory tracking follows Unicode paths', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const card = await newTerminal(h);
    const requested = path.join(root, '.cache', 'tauri-e2e-project', 'changed ไทย 工作 🚀');
    await fs.mkdir(requested, { recursive: true });
    const changed = await fs.realpath(requested);
    for (const zoom of [.45, .65, .8, 1, 1.5, 'focus']) {
        const point = await h.page.evaluate(({ id, zoom }) => {
            setFocus(null);
            if (zoom === 'focus') setFocus(id);
            else { workspace.camera = { x: 30, y: 30, z: zoom }; renderCamera(); }
            document.querySelector('#search').focus();
            const screen = sessions.get(id).element.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: screen.x + 30, y: screen.y + 20 };
        }, { id: card.id, zoom });
        await click(h.page, point);
        assert.equal(await h.page.evaluate(id => document.activeElement === sessions.get(id).terminal.textarea, card.id), true);
        const marker = `NATIVE_INPUT_${String(zoom).replace('.', '_')}`;
        await h.page.keyboard.type(`Write-Output '${marker}'`);
        await key(h.page, 'Enter');
        await until(async () => hasOutputLine(await h.output(card.id), marker), 'First-click native typing did not reach the shell.');
    }
    await until(async () => !(await h.page.evaluate(card => invoke('duplicate-directory', card), card)).warning, 'The final typed command did not return to its prompt.');
    await h.page.evaluate(({ id, command }) => window.terminalCanvas.input(id, command + '\r'), {
        id: card.id, command: `Set-Location -LiteralPath ${powerShellLiteral(changed)}`
    });
    let lastChoice;
    try {
        await until(async () => {
            lastChoice = await h.page.evaluate(card => invoke('duplicate-directory', card), card);
            return lastChoice.cwd === changed && !lastChoice.warning;
        }, 'Changed Unicode directory was not captured.');
    } catch (error) {
        throw new Error(`${error.message}\n${JSON.stringify({ changed, lastChoice, output: (await h.output(card.id)).slice(-3000) })}`, { cause: error });
    }
    await h.page.evaluate(() => { setFocus(null); select(workspace.cards[0].id); viewport.focus(); });
    await key(h.page, 'Control+Shift+d');
    await until(async () => (await h.state()).host.running === 2, 'Duplicate shortcut did not start a fresh shell.');
    const duplicate = await h.page.evaluate(() => workspace.cards.at(-1));
    assert.equal(duplicate.cwd, changed);
    assert.equal(duplicate.command, '');
    assert.equal(duplicate.profile, 'shell');
    await screenshot(h.page, 'native-input');
});

test('multi-message paste input keeps order, output flood pauses, and Stop kills the process tree', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const { card, pids } = await ioFixture(h);
    // Longer than one input message, with a surrogate pair across the first piece boundary.
    const paste = 'p'.repeat(65535) + '🚀' + 'q'.repeat(134463), typed = 'typed-after-paste', unicode = 'native UTF-8 ไทย 工作 🚀';
    const started = Date.now();
    await h.page.evaluate(({ id, paste, typed, unicode }) => {
        window.terminalCanvas.input(id, paste + '\r');
        window.terminalCanvas.input(id, typed + '\r');
        window.terminalCanvas.input(id, unicode + '\r');
    }, { id: card.id, paste, typed, unicode });
    // ConPTY turns each character into an input record, so 200,000 characters take 10-15 s on a
    // hosted runner. Allow several times that, and report what arrived if it still runs out.
    let records = [];
    try {
        await until(async () => {
            records = [...(await h.output(card.id)).matchAll(/INPUT_RECORD (\d+) ([a-f0-9]{64})/g)];
            return records.length >= 3;
        }, 'Large paste and following input did not finish.', 60000);
    } catch (error) {
        const received = records.map(match => Number(match[1]));
        throw new Error(`${error.message}\n${JSON.stringify({ received, output: (await h.output(card.id)).slice(-1000) })}`, { cause: error });
    }
    t.diagnostic(`Large paste and following input finished in ${Date.now() - started} ms.`);
    assert.deepEqual(records.slice(0, 3).map(match => [Number(match[1]), match[2]]), [paste, typed, unicode]
        .map(value => [value.length, createHash('sha256').update(value).digest('hex')]));
    await h.page.evaluate(id => {
        const terminal = sessions.get(id).terminal;
        window.__originalWrite = terminal.write.bind(terminal); window.__heldUnits = 0;
        terminal.write = data => { window.__heldUnits += data.length; window.__originalWrite(data); };
        window.terminalCanvas.input(id, 'flood\r');
    }, card.id);
    const paused = await until(async () => {
        const terminal = (await h.state()).host.terminals.find(terminal => terminal.id === card.id);
        return terminal.pending > 256000 && terminal;
    }, 'Output flood did not reach the backpressure threshold.');
    assert.ok(paused.pending <= 256000 + 65536, `Reader overshot the threshold: ${paused.pending}`);
    assert.ok(!(await h.output(card.id)).includes('FLOOD_DONE'));
    await h.page.evaluate(id => {
        sessions.get(id).terminal.write = window.__originalWrite;
        window.terminalCanvas.acknowledge(id, window.__heldUnits);
    }, card.id);
    await until(async () => (await h.output(card.id)).includes('FLOOD_DONE'), 'Output did not resume after acknowledgement.');
    await h.page.evaluate(id => invoke('stop', { id }), card.id);
    await until(() => pids.every(pid => !alive(pid)), 'Stop left a child process running.');
});

for (const ending of ['close', 'kill']) {
    test(`process trees end after host ${ending} and reopening restores stopped cards`, windows, async t => {
        const h = await launch({ clean: true }); t.after(() => h.dispose());
        const { pids } = await ioFixture(h);
        await h.page.evaluate(() => invoke('autosave', workspace));
        if (ending === 'close') await h.page.evaluate(() => { void invoke('close', workspace); });
        else h.child.kill();
        await h.waitExit();
        await until(() => pids.every(pid => !alive(pid)), 'Host termination left a child process running.');
        const reopened = await launch(); t.after(() => reopened.dispose());
        assert.equal((await reopened.state()).host.running, 0);
        assert.equal(await reopened.page.evaluate(() => workspace.cards.length), 1);
    });
}

test('killing the WebView2 renderer flushes recovery and closes the host', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const { pids } = await ioFixture(h);
    await h.page.evaluate(() => { workspace.name = 'Renderer crash recovery'; return invoke('autosave', workspace); });
    const cdp = await h.page.context().browser().newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const renderer = processInfo.find(process => process.type === 'renderer');
    assert.ok(renderer, 'CDP must identify the renderer process.');
    process.kill(renderer.id);
    await h.waitExit();
    await until(() => pids.every(pid => !alive(pid)), 'Renderer-crash shutdown left child processes running.');
    const saved = JSON.parse(await fs.readFile(path.join(h.profile, 'workspace.terminalcanvas'), 'utf8'));
    assert.equal(saved.name, 'Renderer crash recovery');
});


test('native close requests allow cancellation, then flush the latest renderer snapshot before exiting', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const { pids } = await ioFixture(h);
    await h.page.evaluate(() => {
        workspace.name = 'Close request before cancellation';
        return window.__TAURI__.core.invoke('e2e_request_close');
    });
    await h.page.waitForFunction(() => document.querySelector('#confirm-dialog').open);
    assert.equal((await h.state()).host.running, 1);
    await h.page.locator('#confirm-cancel').click();
    await h.page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
    assert.equal((await h.state()).host.running, 1, 'Cancel must leave the terminal running.');
    assert.ok(pids.every(alive), 'Cancel must leave the controlled child processes running.');
    await h.page.evaluate(() => window.__TAURI__.core.invoke('e2e_request_close'));
    await h.page.waitForFunction(() => document.querySelector('#confirm-dialog').open);
    await h.page.evaluate(() => { workspace.name = 'Saved by renderer-confirmed close'; clearTimeout(autosaveTimer); });
    await h.page.locator('#confirm-ok').click();
    assert.equal(await h.waitExit(), 0);
    await until(() => pids.every(pid => !alive(pid)), 'Confirmed close left a child process running.');
    const saved = JSON.parse(await fs.readFile(path.join(h.profile, 'workspace.terminalcanvas'), 'utf8'));
    assert.equal(saved.name, 'Saved by renderer-confirmed close');
    assert.equal(saved.cards.length, 1);
});
