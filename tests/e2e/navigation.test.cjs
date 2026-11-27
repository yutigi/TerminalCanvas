const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, hasOutputLine, click, key, screenshot } = require('./harness.cjs');
const { startTerminal, fixtureScene } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };

// Native keys move between two running PowerShell terminals: typing focus changes only on Enter and
// Ctrl+Shift+E, Alt+arrow keys inside a terminal stay with the shell, and the canvas pans at the same zoom.
test('native Alt+arrow navigation selects terminals without typing, and Enter / Ctrl+Shift+E move the keyboard', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const left = await startTerminal(h.page, { title: 'Left', x: 0, y: 0 });
    const right = await startTerminal(h.page, { title: 'Right', x: 2200, y: 0 });
    await until(async () => (await h.state()).host.running === 2, 'Both shells did not start.');
    const view = () => h.page.evaluate(({ left, right }) => {
        const area = viewport.getBoundingClientRect(), rect = id => sessions.get(id).element.getBoundingClientRect();
        const typingIn = [left, right].find(id => sessions.get(id).element.contains(document.activeElement)) || null;
        const visible = id => { const r = rect(id); return r.left >= area.left && r.right <= area.right && r.top >= area.top && r.bottom <= area.bottom; };
        return {
            selected, typingIn, camera: { ...workspace.camera }, onBoard: document.activeElement === viewport,
            highlighted: [left, right].filter(id => sessions.get(id).element.classList.contains('keyboard-current')),
            outline: getComputedStyle(sessions.get(right).element).outlineStyle, rightVisible: visible(right)
        };
    }, { left: left.id, right: right.id });
    const point = await h.page.evaluate(id => {
        setFocus(null); workspace.camera = { x: 120, y: 60, z: .65 }; renderCamera();
        const screen = sessions.get(id).element.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: Math.round(screen.x + 40), y: Math.round(screen.y + 20) };
    }, left.id);
    await click(h.page, point);
    let now = await view();
    assert.equal(now.typingIn, left.id, 'the first click still types in the terminal');
    assert.equal(now.rightVisible, false, 'the second terminal starts out of view');
    // Alt+Right inside a terminal belongs to the shell: nothing moves.
    await key(h.page, 'Alt+ArrowRight');
    now = await view();
    assert.equal(now.selected, left.id);
    assert.equal(now.typingIn, left.id);
    await h.page.keyboard.type("Write-Output 'NAV_LEFT_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(left.id), 'NAV_LEFT_OK'), 'Typing after Alt+Right did not reach the left shell.');
    // Ctrl+Shift+E returns the keyboard to the board with the terminal still selected.
    await key(h.page, 'Control+Shift+e');
    now = await view();
    assert.deepEqual({ selected: now.selected, typingIn: now.typingIn, onBoard: now.onBoard, highlighted: now.highlighted },
        { selected: left.id, typingIn: null, onBoard: true, highlighted: [left.id] });
    // Alt+Right on the board selects the right terminal, pans it into view at the same zoom, and highlights it.
    await key(h.page, 'Alt+ArrowRight');
    now = await view();
    assert.deepEqual({ selected: now.selected, typingIn: now.typingIn, highlighted: now.highlighted, z: now.camera.z, visible: now.rightVisible },
        { selected: right.id, typingIn: null, highlighted: [right.id], z: .65, visible: true });
    assert.equal(now.outline, 'solid', 'the keyboard highlight is drawn');
    await screenshot(h.page, 'keyboard-navigation');
    // Typing on the board does not reach either shell until Enter moves the keyboard in.
    await key(h.page, 'Enter');
    now = await view();
    assert.equal(now.typingIn, right.id);
    assert.equal(now.outline, 'none', 'the highlight gives way to the terminal cursor while typing');
    await h.page.keyboard.type("Write-Output 'NAV_RIGHT_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(right.id), 'NAV_RIGHT_OK'), 'Enter did not move typing into the right shell.');
    assert.equal(hasOutputLine(await h.output(left.id), 'NAV_RIGHT_OK'), false, 'the left shell received keys meant for the right one');
    // Focus mode: Alt+Left from the board switches the fullscreen terminal without typing in it.
    await h.page.evaluate(id => setFocus(id), right.id);
    await key(h.page, 'Control+Shift+e');
    await key(h.page, 'Alt+ArrowLeft');
    now = await view();
    assert.equal(await h.page.evaluate(() => focused), left.id);
    assert.equal(now.typingIn, null);
    await key(h.page, 'Enter');
    assert.equal((await view()).typingIn, left.id);
});

test('native terminal switcher isolates shell keys, restores focus, and reveals duplicate titles without typing', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const left = await startTerminal(h.page, { title: 'Same title', x: 0, y: 0 });
    const right = await startTerminal(h.page, { title: 'Same title', x: 2400, y: 0 });
    await h.page.evaluate(id => {
        setFocus(null); workspace.camera = { x: 120, y: 60, z: .65 }; renderCamera(); select(id);
        $('#outline-toggle').click(); setSidebarCollapsed(true);
    }, left.id);
    const query = h.page.locator('#switcher-query'), dialog = h.page.locator('#terminal-switcher');
    await h.page.locator('#viewport').click({ button: 'right', position: { x: 80, y: 120 } });
    await h.page.locator('#canvas-menu-find').click();
    await query.waitFor({ state: 'visible' });
    assert.equal(await h.page.locator('#canvas-menu').isVisible(), false);
    assert.equal(await h.page.locator('#sidebar').isVisible(), false, 'canvas Find preserves the hidden sidebar');
    await key(h.page, 'Escape');
    assert.equal(await h.page.evaluate(() => document.activeElement === viewport), true, 'cancelled canvas Find returns focus to the canvas');
    await key(h.page, 'Enter');
    await key(h.page, 'Control+Shift+p');
    await query.waitFor({ state: 'visible' });
    assert.equal(await query.evaluate(node => document.activeElement === node), true);
    assert.equal(await h.page.locator('#sidebar').isVisible(), false, 'the switcher works with the sidebar hidden');
    await h.page.keyboard.type('SWITCHER_QUERY_MUST_STAY_LOCAL');
    assert.equal(await h.page.locator('#switcher-status').textContent(), 'No matching terminals.');
    await key(h.page, 'Enter');
    assert.equal(await dialog.evaluate(node => node.open), true, 'no-match confirmation keeps the query open');
    await key(h.page, 'Escape');
    assert.equal(await h.page.evaluate(id => sessions.get(id).element.contains(document.activeElement), left.id), true);
    await h.page.keyboard.type("Write-Output 'SWITCHER_RESTORED_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(left.id), 'SWITCHER_RESTORED_OK'), 'Cancellation did not restore shell input.');
    assert.equal((await h.output()).includes('SWITCHER_QUERY_MUST_STAY_LOCAL'), false, 'query keystrokes leaked to a PTY');
    await h.page.evaluate(() => setSidebarCollapsed(false));
    assert.equal(await h.page.locator('#outline-section').isVisible(), false);
    await h.page.locator('#find-terminal').click();
    assert.equal(await dialog.evaluate(node => node.open), true, 'Find terminal stays available beside the collapsed section');
    await h.page.keyboard.type('same title');
    await key(h.page, 'ArrowDown');
    assert.equal(await query.getAttribute('aria-activedescendant'), `switcher-option-${right.id}`);
    assert.equal(await h.page.locator('[role="option"][aria-selected="true"]').count(), 1);
    await screenshot(h.page, 'terminal-switcher');
    await key(h.page, 'Enter');
    const shown = await h.page.evaluate(id => {
        const area = viewport.getBoundingClientRect(), rect = sessions.get(id).element.getBoundingClientRect();
        return { selected, z: workspace.camera.z, board: document.activeElement === viewport,
            highlighted: sessions.get(id).element.classList.contains('keyboard-current'),
            visible: rect.left >= area.left && rect.right <= area.right && rect.top >= area.top && rect.bottom <= area.bottom };
    }, right.id);
    assert.deepEqual(shown, { selected: right.id, z: .65, board: true, highlighted: true, visible: true });
    await key(h.page, 'Enter');
    await h.page.keyboard.type("Write-Output 'SWITCHER_RIGHT_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(right.id), 'SWITCHER_RIGHT_OK'), 'Explicit Enter did not move typing into the chosen shell.');
    assert.equal(hasOutputLine(await h.output(left.id), 'SWITCHER_RIGHT_OK'), false);
    assert.deepEqual(h.errors, []);
});

// A split view of three terminals: native keys open and close it, a native divider drag and the layout
// buttons refit the terminals, the host saves it, and every card returns to its canvas place.
test('native split view lays out, refits, saves, and restores selected terminals', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const page = h.page;
    await fixtureScene(page, [0, 700, 1400].map(x => ({ profile: 'shell', title: `At ${x}`, x, y: 0 })));
    const view = () => page.evaluate(() => workspace.cards.map(card => {
        const box = sessions.get(card.id).element.getBoundingClientRect(), terminal = sessions.get(card.id).terminal;
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), cols: terminal.cols, rows: terminal.rows };
    }));
    await page.evaluate(() => { workspace.camera = { x: 40, y: 60, z: .5 }; renderCamera(); setSelection(workspace.cards.map(card => card.id)); });
    const canvas = await view();
    await key(page, 'Control+Shift+F');
    const area = await page.evaluate(() => { const box = viewport.getBoundingClientRect(); return { x: box.x + 18, y: box.y + 60, w: box.width - 36, h: box.height - 80 }; });
    const pane = Math.round((area.w - 20) / 3);
    const split = await until(async () => {
        const panes = await view();
        return panes.every((box, index) => Math.abs(box.w - pane) <= 1 && box.cols < canvas[index].cols) && panes;
    }, 'The split view did not lay out and refit three panes.');
    for (const [index, box] of split.entries()) {
        assert.ok(Math.abs(box.x - (area.x + index * (pane + 10))) <= 1, `pane ${index} starts at its place: ${JSON.stringify(box)}`);
        assert.ok(Math.abs(box.h - area.h) <= 1 && Math.abs(box.y - area.y) <= 1);
    }
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#split-layout').hidden, document.querySelectorAll('.split-divider').length]), [false, 2]);
    await screenshot(page, 'split-view');
    // Dragging the first divider 60px right widens the first pane and refits both of its neighbours.
    const divider = await page.evaluate(() => { const box = document.querySelector('.split-divider').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; });
    await page.mouse.move(divider.x, divider.y); await page.mouse.down();
    await page.mouse.move(divider.x + 60, divider.y, { steps: 4 });
    await page.mouse.up();
    const dragged = await until(async () => {
        const panes = await view();
        return Math.abs(panes[0].w - (pane + 60)) <= 1 && Math.abs(panes[1].w - (pane - 60)) <= 1 && panes[0].cols > split[0].cols && panes[1].cols < split[1].cols && panes;
    }, 'The divider did not resize and refit its panes.');
    assert.equal(dragged[2].w, split[2].w, 'the third pane is untouched');
    await click(page, await page.evaluate(() => { const box = document.querySelector('#split-column').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; }));
    const stacked = await until(async () => {
        const panes = await view();
        return panes.every(box => Math.abs(box.w - area.w) <= 1) && panes[0].y < panes[1].y && panes[1].y < panes[2].y && panes;
    }, 'The panes were not stacked.');
    assert.ok(stacked.every(box => box.h < area.h / 2));
    assert.deepEqual(await page.evaluate(() => ['#split-row', '#split-column'].map(id => document.querySelector(id).getAttribute('aria-pressed'))), ['false', 'true']);
    // Buttons fade between states; the screenshot waits until Stacked shows as pressed.
    await until(() => page.evaluate(() => getComputedStyle(document.querySelector('#split-column')).backgroundColor === 'rgb(53, 64, 46)'), 'Stacked did not show as pressed.');
    await screenshot(page, 'split-view-stacked');
    // The host validates and saves the split view with its canvas.
    const saved = await page.evaluate(async () => { await invoke('autosave', workspace); return workspaceSnapshot().canvases[0]; });
    assert.equal(saved.split.orientation, 'column');
    assert.deepEqual(saved.split.cardIds, await page.evaluate(() => workspace.cards.map(card => card.id)));
    await key(page, 'Control+Shift+F');
    const restored = await until(async () => {
        const panes = await view();
        return panes.every((box, index) => box.x === canvas[index].x && box.y === canvas[index].y && box.w === canvas[index].w && box.cols === canvas[index].cols) && panes;
    }, 'The terminals did not return to their canvas places.');
    assert.deepEqual(restored.map(box => box.h), canvas.map(box => box.h));
    assert.equal(await page.evaluate(() => 'split' in workspaceSnapshot().canvases[0]), false);
});
