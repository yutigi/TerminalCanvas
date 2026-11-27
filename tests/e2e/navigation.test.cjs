const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, hasOutputLine, click, key, screenshot } = require('./harness.cjs');
const { startTerminal } = require('./support.cjs');
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
