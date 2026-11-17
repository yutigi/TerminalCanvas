const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, until, hasOutputLine, click, key, screenshot } = require('./harness.cjs');
const { startTerminal } = require('./support.cjs');
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
