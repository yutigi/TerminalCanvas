const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, hasOutputLine, click, key, screenshot } = require('./harness.cjs');
const { startTerminal, fixtureScene } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 180000 };

// Native keys move between two running PowerShell terminals (#58). Ctrl+Alt+Shift+arrow keys move typing
// straight into the next terminal and never reach a shell; on the board they select without typing. Alt+arrow
// keys stay with the shell, Enter and Ctrl+Shift+E move the keyboard in and out, and the zoom never changes.
test('native Ctrl+Alt+Shift+arrow keys move typing between terminals, select on the board, and leave Alt+arrow keys to the shell', windows, async t => {
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
            outline: selected ? getComputedStyle(sessions.get(selected).element).outlineStyle : null,
            visible: selected ? visible(selected) : null, rightVisible: visible(right)
        };
    }, { left: left.id, right: right.id });
    // What xterm sends to either shell while `action` runs, leaving out focus in/out reports.
    const sent = async action => {
        await h.page.evaluate(ids => {
            window.__sent = []; window.__sentListeners = ids.map(id => sessions.get(id).terminal.onData(data => window.__sent.push(data)));
        }, [left.id, right.id]);
        try {
            await action();
            return (await h.page.evaluate(() => window.__sent)).filter(data => data !== '\x1b[I' && data !== '\x1b[O');
        } finally { await h.page.evaluate(() => window.__sentListeners.forEach(listener => listener.dispose())); }
    };
    const point = await h.page.evaluate(id => {
        setFocus(null); workspace.camera = { x: 120, y: 60, z: .65 }; renderCamera();
        const screen = sessions.get(id).element.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: Math.round(screen.x + 40), y: Math.round(screen.y + 20) };
    }, left.id);
    await click(h.page, point);
    let now = await view();
    assert.equal(now.typingIn, left.id, 'the first click still types in the terminal');
    assert.equal(now.rightVisible, false, 'the second terminal starts out of view');
    // Alt+Right inside a terminal belongs to the shell: xterm sends it on (as Ctrl+Right outside macOS) and nothing moves.
    const alt = await sent(() => key(h.page, 'Alt+ArrowRight'));
    assert.equal(alt.length, 1, JSON.stringify(alt));
    assert.match(alt[0], /^\x1b\[1;[35]C$/);
    now = await view();
    assert.equal(now.selected, left.id);
    assert.equal(now.typingIn, left.id);
    await h.page.keyboard.type("Write-Output 'NAV_LEFT_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(left.id), 'NAV_LEFT_OK'), 'Typing after Alt+Right did not reach the left shell.');
    // While typing, Ctrl+Alt+Shift+Right moves typing straight into the right terminal and pans it into view.
    assert.deepEqual(await sent(() => key(h.page, 'Control+Alt+Shift+ArrowRight')), [], 'no shell receives the chord');
    now = await view();
    assert.deepEqual({ selected: now.selected, typingIn: now.typingIn, z: now.camera.z, visible: now.visible },
        { selected: right.id, typingIn: right.id, z: .65, visible: true });
    assert.equal(now.outline, 'none', 'the highlight gives way to the terminal cursor while typing');
    await h.page.keyboard.type("Write-Output 'NAV_RIGHT_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(right.id), 'NAV_RIGHT_OK'), 'The chord did not move typing into the right shell.');
    assert.equal(hasOutputLine(await h.output(left.id), 'NAV_RIGHT_OK'), false, 'the left shell received keys meant for the right one');
    // Ctrl+Shift+E returns the keyboard to the board with the terminal still selected.
    await key(h.page, 'Control+Shift+e');
    now = await view();
    assert.deepEqual({ selected: now.selected, typingIn: now.typingIn, onBoard: now.onBoard, highlighted: now.highlighted },
        { selected: right.id, typingIn: null, onBoard: true, highlighted: [right.id] });
    // On the board, Alt+Left no longer moves; the chord selects the left terminal, highlights it, and pans to it.
    await key(h.page, 'Alt+ArrowLeft');
    assert.equal((await view()).selected, right.id);
    await key(h.page, 'Control+Alt+Shift+ArrowLeft');
    now = await view();
    assert.deepEqual({ selected: now.selected, typingIn: now.typingIn, highlighted: now.highlighted, z: now.camera.z, visible: now.visible },
        { selected: left.id, typingIn: null, highlighted: [left.id], z: .65, visible: true });
    assert.equal(now.outline, 'solid', 'the keyboard highlight is drawn');
    await screenshot(h.page, 'keyboard-navigation');
    // Typing on the board does not reach either shell until Enter moves the keyboard in.
    await key(h.page, 'Enter');
    assert.equal((await view()).typingIn, left.id);
    // Focus mode: from the board the chord switches the fullscreen terminal without typing in it...
    await h.page.evaluate(id => setFocus(id), left.id);
    await key(h.page, 'Control+Shift+e');
    await key(h.page, 'Control+Alt+Shift+ArrowRight');
    assert.equal(await h.page.evaluate(() => focused), right.id);
    assert.equal((await view()).typingIn, null);
    await key(h.page, 'Enter');
    assert.equal((await view()).typingIn, right.id);
    // ...and while typing, it switches Focus and typing together.
    assert.deepEqual(await sent(() => key(h.page, 'Control+Alt+Shift+ArrowLeft')), []);
    assert.equal(await h.page.evaluate(() => focused), left.id);
    assert.equal((await view()).typingIn, left.id);
    await h.page.keyboard.type("Write-Output 'NAV_FOCUS_OK'");
    await key(h.page, 'Enter');
    await until(async () => hasOutputLine(await h.output(left.id), 'NAV_FOCUS_OK'), 'The chord did not move typing in Focus mode.');
    assert.equal(hasOutputLine(await h.output(right.id), 'NAV_FOCUS_OK'), false);
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

// Terminals pinned beside a live canvas: native pin buttons and header drags build nested splits in the
// dock, terminals refit, the host saves the dock, and dropping one on the canvas unpins it there.
// Display scale 1.5 makes the page about as small as the CI window's.
for (const scale of [1, 1.5]) {
test(`native dock pins terminals beside the canvas in nested splits and unpins them onto it (display scale ${scale})`, windows, async t => {
    const h = await launch({ clean: true, scale }); t.after(() => h.dispose());
    const page = h.page;
    await fixtureScene(page, [0, 700, 1400].map(x => ({ profile: 'shell', title: `Dock ${x}`, x, y: 0 })));
    await page.evaluate(() => { workspace.camera = { x: 40, y: 60, z: .5 }; renderCamera(); });
    const ids = await page.evaluate(() => workspace.cards.map(card => card.id));
    // The middle of a terminal's header control. A terminal on the canvas is brought into view first,
    // since the CI window is small enough to leave some off screen, and the point must reach the control.
    const middle = async (selector, id) => {
        const point = await page.evaluate(({ selector, id }) => {
            if (!isPinned(id)) revealCard(findCard(id));
            const control = sessions.get(id).element.querySelector(selector), box = control.getBoundingClientRect();
            const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
            return { ...point, reached: control.contains(document.elementFromPoint(point.x, point.y)) };
        }, { selector, id });
        assert.equal(point.reached, true, `${selector} of ${id} is covered or off screen`);
        return { x: point.x, y: point.y };
    };
    const box = id => page.evaluate(id => {
        const s = sessions.get(id), r = s.element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cols: s.terminal.cols, parent: s.element.parentElement.id };
    }, id);
    const area = () => page.evaluate(() => [document.querySelector('#dock'), viewport].map(element => {
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), hidden: element.hidden };
    }));
    const [, before] = await area();
    const canvas = await box(ids[0]);
    await click(page, await middle('[data-action="pin"]', ids[0]));
    const [dockBox, view] = await area();
    const pinned = await until(async () => {
        const b = await box(ids[0]);
        return b.parent === 'dock' && Math.abs(b.w - (dockBox.w - 16)) <= 1 && b.cols !== canvas.cols && b;
    }, 'The terminal was not pinned and refitted.');
    assert.equal(dockBox.hidden, false);
    assert.ok(view.x >= dockBox.x + dockBox.w && view.w < before.w, 'the canvas sits beside the dock');
    // Pinned below it, then dragged onto its right edge, the second terminal shares the dock side by side.
    await click(page, await middle('[data-action="pin"]', ids[1]));
    // Narrow pinned terminals keep their status dot and profile mark as handles beside the title.
    const grab = await middle('.card-status', ids[1]), first = await box(ids[0]);
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(first.x + first.w - 20, first.y + Math.round(first.h / 2), { steps: 5 });
    assert.equal(await page.evaluate(() => document.querySelector('#dock-drop').hidden), false, 'the drop target is shown');
    await page.mouse.up();
    const pair = await until(async () => {
        const [a, b] = [await box(ids[0]), await box(ids[1])];
        return Math.abs(a.y - b.y) <= 1 && a.x < b.x && a.cols < pinned.cols && [a, b];
    }, 'The pinned terminals did not share the dock side by side.');
    assert.ok(Math.abs(pair[0].w - pair[1].w) <= 1);
    // The third terminal, dragged from the canvas to the bottom of the dock, goes below both.
    const third = await middle('.card-status', ids[2]), canvasPlace = await page.evaluate(id => ({ ...findCard(id) }), ids[2]);
    await page.mouse.move(third.x, third.y); await page.mouse.down();
    await page.mouse.move(Math.round(dockBox.x + dockBox.w / 2), dockBox.y + dockBox.h - 30, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await box(ids[2])).parent === 'dock', 'The canvas terminal was not pinned by dragging.');
    assert.deepEqual(await page.evaluate(() => dock.layout), { orientation: 'column', sizes: [.5, .5], children: [
        { orientation: 'row', children: [{ cardId: ids[0] }, { cardId: ids[1] }], sizes: [.5, .5] }, { cardId: ids[2] }] });
    const placed = await page.evaluate(id => ({ ...findCard(id) }), ids[2]);
    assert.deepEqual([placed.x, placed.y], [canvasPlace.x, canvasPlace.y], 'it keeps its canvas place');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.pinned-ghost').length), 3);
    // The host validates and saves the dock with its canvas.
    const saved = await page.evaluate(async () => { await invoke('autosave', workspace); return workspaceSnapshot().canvases[0].dock; });
    assert.equal(saved.layout.children[1].cardId, ids[2]);
    await screenshot(page, scale === 1 ? 'dock' : `dock-${scale}`);
    // Dropped on the canvas, the first terminal returns there and the second takes the whole row.
    const header = await middle('.card-status', ids[0]);
    await page.mouse.move(header.x, header.y); await page.mouse.down();
    await page.mouse.move(view.x + Math.round(view.w / 2), view.y + Math.round(view.h / 2), { steps: 5 });
    await page.mouse.up();
    await until(async () => (await box(ids[0])).parent === 'world', 'Dropping on the canvas did not unpin the terminal.');
    assert.deepEqual(await page.evaluate(() => dock.layout), { orientation: 'column', sizes: [.5, .5], children: [{ cardId: ids[1] }, { cardId: ids[2] }] });
    for (const id of ids.slice(1)) await click(page, await middle('[data-action="pin"]', id));
    const [closed, restored] = await area();
    assert.equal(closed.hidden, true);
    assert.deepEqual([restored.x, restored.w], [before.x, before.w], 'the canvas gets its room back');
    assert.equal(await page.evaluate(() => 'dock' in workspaceSnapshot().canvases[0]), false);
});
}
