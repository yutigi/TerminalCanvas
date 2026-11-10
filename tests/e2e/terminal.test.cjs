const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, hasOutputLine, sendInput, click, key, screenshot } = require('./harness.cjs');
const { withSavedClipboard, fixtureScene, cellPoint, writeTerminal, clipboardRead, clipboardWrite, input, startTerminal } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };
const normalize = text => text.replace(/\r\n/g, '\n');
const expectedSelection = (lines, from, to) => from.row === to.row ? lines[from.row].slice(from.col, to.col + 1)
    : [lines[from.row].slice(from.col), ...lines.slice(from.row + 1, to.row), lines[to.row].slice(0, to.col + 1)].join('\n');

for (const scale of [1, 1.25, 1.5]) {
test(`native terminal selection, copying, SGR reports and scrolling (display scale ${scale})`, windows, async t => {
    await withSavedClipboard(async () => {
        const h = await launch({ clean: true, scale }); t.after(() => h.dispose());
        const cards = await fixtureScene(h.page, [{ title: 'Selection terminal', x: 0, y: 0 }, { title: 'Wide terminal', x: 1400, y: 900 }]);
        await h.page.evaluate(id => { const card = workspace.cards.find(card => card.id === id); card.w = 1000; card.h = 600; renderGeometry(card); }, cards[1].id);
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
        const lines = Array.from({ length: 12 }, (_, row) => `row${String(row).padStart(2, '0')} ${alphabet.slice(row % 5)} |${row}`);
        for (const card of cards) await writeTerminal(h.page, card.id, lines.join('\r\n'));
        const cases = [
            { index: 0, z: 1, x: 140, y: 80 }, { index: 0, z: .65, x: 420, y: 230 },
            { index: 1, z: .8, x: 160, y: 60 }, { index: 1, z: 1.5, x: 120, y: 40 },
            { index: 0, z: .45, x: 700, y: 400 }, { index: 1, focus: true }
        ];
        const selections = [
            { from: { col: 3, row: 2 }, to: { col: 17, row: 2 } },
            { from: { col: 20, row: 1 }, to: { col: 9, row: 6 } },
            { from: { col: 0, row: 0 }, to: { col: 36, row: 10 } }
        ];
        for (const current of cases) {
            const card = cards[current.index];
            await h.page.evaluate(({ card, current }) => {
                setFocus(null);
                if (current.focus) setFocus(card.id);
                else { workspace.camera = { x: current.x - card.x * current.z, y: current.y - card.y * current.z, z: current.z }; renderCamera(); }
                return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }, { card, current });
            for (const { from, to } of selections) {
                for (const backward of [false, true]) {
                    let a = await cellPoint(h.page, card.id, from.col, from.row, .25);
                    let b = await cellPoint(h.page, card.id, to.col, to.row, .75);
                    if (backward) [a, b] = [b, a];
                    assert.ok(a.visible && b.visible, JSON.stringify({ current, a, b }));
                    await sendInput(h.page, async () => {
                        await h.page.mouse.move(a.x, a.y); await h.page.mouse.down();
                        await h.page.mouse.move(b.x, b.y, { steps: 4 }); await h.page.mouse.up();
                    }, { point: b });
                    const expected = expectedSelection(lines, from, to);
                    await until(async () => normalize(await h.page.evaluate(id => sessions.get(id).terminal.getSelection(), card.id)) === expected,
                        `Pointer selection mismatch: ${JSON.stringify({ current, from, to, backward })}`);
                }
            }
            await h.page.evaluate(id => sessions.get(id).terminal.focus(), card.id);
            await key(h.page, 'Control+Shift+c');
            await until(async () => await clipboardRead(h.page) === expectedSelection(lines, selections[2].from, selections[2].to), 'Native selection copy failed.');
            await h.page.evaluate(id => {
                window.__reports = []; window.__reportListener = sessions.get(id).terminal.onData(data => window.__reports.push(data));
            }, card.id);
            await writeTerminal(h.page, card.id, '\x1b[?1000h\x1b[?1006h');
            const point = await cellPoint(h.page, card.id, 30, 7);
            await click(h.page, point);
            await until(async () => (await h.page.evaluate(() => window.__reports)).length >= 2, 'SGR mouse report was not delivered.');
            assert.equal((await h.page.evaluate(() => window.__reports))[0], '\x1b[<0;31;8M');
            await h.page.evaluate(() => window.__reportListener.dispose());
            await writeTerminal(h.page, card.id, '\x1b[?1006l\x1b[?1000l');
        }
        await h.page.evaluate(() => { setFocus(null); workspace.camera = { x: 300, y: 150, z: .65 }; renderCamera(); });
        await writeTerminal(h.page, cards[0].id, Array.from({ length: 80 }, (_, i) => '\r\nscroll ' + i).join(''));
        const bottom = await h.page.evaluate(id => sessions.get(id).terminal.buffer.active.viewportY, cards[0].id);
        assert.ok(bottom > 0);
        const wheel = await cellPoint(h.page, cards[0].id, 20, 5);
        await h.page.mouse.move(wheel.x, wheel.y); await h.page.mouse.wheel(0, -240);
        await until(async () => (await h.page.evaluate(id => sessions.get(id).terminal.buffer.active.viewportY, cards[0].id)) < bottom, 'Wheel did not scroll terminal scrollback.');
        const anchor = cards[1];
        await h.page.evaluate(card => { workspace.camera = { x: 200 - card.x * .65, y: 100 - card.y * .65, z: .65 }; renderCamera(); }, anchor);
        const point = await cellPoint(h.page, anchor.id, 40, 9);
        assert.ok(point.visible);
        const worldPoint = () => h.page.evaluate(point => {
            const r = viewport.getBoundingClientRect(), c = workspace.camera;
            return { x: (point.x - r.left - c.x) / c.z, y: (point.y - r.top - c.y) / c.z };
        }, point);
        const before = await worldPoint();
        await h.page.mouse.move(point.x, point.y); await h.page.keyboard.down('Control');
        try { await h.page.mouse.wheel(0, -120); } finally { await h.page.keyboard.up('Control'); }
        await until(async () => (await h.page.evaluate(() => workspace.camera.z)) !== .65, 'Ctrl+wheel did not zoom the canvas.');
        const after = await worldPoint();
        assert.ok(Math.abs(before.x - after.x) < 1 && Math.abs(before.y - after.y) < 1, 'Canvas zoom must stay anchored at the native pointer.');
        await screenshot(h.page, `terminal-selection-${scale}`);
    });
});
}

test('native terminal clipboard shortcuts paste once, preserve native fields, and interrupt real processes', windows, async t => {
    await withSavedClipboard(async () => {
        const h = await launch({ clean: true }); t.after(() => h.dispose());
        const [card] = await fixtureScene(h.page, [{ title: 'Clipboard fixture' }]);
        await h.page.evaluate(id => {
            const s = sessions.get(id); s.status = 'running'; window.__inputs = [];
            s.terminal.onData(data => window.__inputs.push(data));
        }, card.id);
        for (const focus of [false, true]) {
            await h.page.evaluate(({ id, focus }) => { setFocus(focus ? id : null); const s = sessions.get(id); s.terminal.reset(); s.terminal.focus(); }, { id: card.id, focus });
            await writeTerminal(h.page, card.id, '\x1b[2J\x1b[HSelected terminal text\r\nSecond line');
            for (const chord of ['Control+c', 'Control+Shift+c']) {
                await clipboardWrite(h.page, 'old clipboard');
                await h.page.evaluate(id => { window.__inputs = []; const t = sessions.get(id).terminal; t.select(0, 0, 22); t.focus(); }, card.id);
                await key(h.page, chord);
                await until(async () => await clipboardRead(h.page) === 'Selected terminal text', 'Copy did not reach the OS clipboard.');
                assert.deepEqual(await h.page.evaluate(() => window.__inputs), []);
            }
            await h.page.evaluate(id => sessions.get(id).terminal.clearSelection(), card.id);
            await key(h.page, 'Control+Shift+c');
            assert.equal(await clipboardRead(h.page), 'Selected terminal text');
            assert.deepEqual(await h.page.evaluate(() => window.__inputs), []);
            await key(h.page, 'Control+c');
            assert.deepEqual(await h.page.evaluate(() => window.__inputs), ['\x03']);
            for (const bracketed of [false, true]) {
                await writeTerminal(h.page, card.id, `\x1b[?2004${bracketed ? 'h' : 'l'}`);
                for (const chord of ['Control+v', 'Control+Shift+v']) {
                    for (const selection of [false, true]) {
                        await clipboardWrite(h.page, 'first\r\nsecond\nthird');
                        await h.page.evaluate(({ id, selection }) => {
                            window.__inputs = []; const t = sessions.get(id).terminal;
                            if (selection) t.select(0, 0, 8); else t.clearSelection(); t.focus();
                        }, { id: card.id, selection });
                        await key(h.page, chord);
                        await until(async () => (await h.page.evaluate(() => window.__inputs)).length > 0, 'Native paste did not reach xterm.');
                        await new Promise(resolve => setTimeout(resolve, 100));
                        const expected = bracketed ? '\x1b[200~first\rsecond\rthird\x1b[201~' : 'first\rsecond\rthird';
                        assert.deepEqual(await h.page.evaluate(() => window.__inputs), [expected]);
                    }
                }
            }
            await h.page.evaluate(() => { const field = document.querySelector('#search'); field.value = 'outside terminal'; field.focus(); field.select(); window.__inputs = []; });
            await key(h.page, 'Control+c');
            await until(async () => await clipboardRead(h.page) === 'outside terminal', 'Native text-field copy failed.');
            await clipboardWrite(h.page, 'native paste'); await key(h.page, 'Control+v');
            assert.equal(await h.page.locator('#search').inputValue(), 'native paste');
            assert.deepEqual(await h.page.evaluate(() => window.__inputs), []);
        }
        await h.page.evaluate(async () => loadWorkspace((await invoke('new')).workspace));
        for (const focus of [false, true]) {
            const real = await startTerminal(h.page, { title: 'Real interruption' });
            await until(async () => !(await h.page.evaluate(card => invoke('duplicate-directory', card), real)).warning, 'Shell was not ready.');
            await h.page.evaluate(({ id, focus }) => { setFocus(focus ? id : null); sessions.get(id).terminal.focus(); }, { id: real.id, focus });
            const marker = `BLOCKING_${focus}`;
            await input(h.page, real.id, `Write-Output '${marker}'; Start-Sleep -Seconds 30\r`);
            await until(async () => hasOutputLine(await h.output(real.id), marker), 'Blocking command did not start.');
            await key(h.page, 'Control+c');
            await input(h.page, real.id, `Write-Output 'RESUMED_${focus}'\r`);
            await until(async () => hasOutputLine(await h.output(real.id), `RESUMED_${focus}`), 'Shell did not resume after a native interrupt.');
            await h.page.evaluate(id => invoke('stop', { id }), real.id);
        }
        await screenshot(h.page, 'clipboard');
    });
});

test('native hyperlink clicks use the validated OS boundary and browser accelerators stay disabled', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const [card] = await fixtureScene(h.page, [{ title: 'Hyperlinks' }]);
    await h.page.evaluate(() => { window.__confirmations = 0; window.confirm = () => { window.__confirmations++; return false; }; });
    await writeTerminal(h.page, card.id, '\x1b]8;;https://github.com/yutigi/TerminalCanvas\x07GitHub\x1b]8;;\x07\r\n\x1b]8;;file:///C:/Windows/notepad.exe\x07Unsafe\x1b]8;;\x07');
    assert.deepEqual((await h.state()).links, []);
    for (const row of [0, 1]) {
        const point = await cellPoint(h.page, card.id, 2, row);
        await h.page.mouse.move(point.x, point.y); await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal((await h.state()).links.length, row);
        await click(h.page, point);
        if (row === 0) await until(async () => (await h.state()).links.length === 1, 'Hyperlink click did not reach the host.');
        else await new Promise(resolve => setTimeout(resolve, 150));
        assert.deepEqual((await h.state()).links, ['https://github.com/yutigi/TerminalCanvas']);
        assert.equal(await h.page.evaluate(() => window.__confirmations), 0);
    }
    await h.page.evaluate(() => { window.__reloadSentinel = 'same-page'; viewport.focus(); });
    for (const chord of ['F5', 'Control+r', 'Control+f', 'Control+p']) {
        await key(h.page, chord);
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await h.page.evaluate(() => window.__reloadSentinel), 'same-page', `${chord} must not reload or replace the app.`);
        assert.equal(await h.page.evaluate(() => document.hasFocus()), true);
    }
    await screenshot(h.page, 'links');
});
