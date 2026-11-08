const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/terminal-pointer.js');

// xterm.js 6 `getCoords` for selections: offset from the screen corner divided by the CSS cell size.
const CELL = { width: 7.2, height: 15.6 };
function xtermCell(event, rect) {
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    return { col: Math.ceil((x + CELL.width / 2) / CELL.width), row: Math.ceil(y / CELL.height) };
}

// A terminal screen of `cols` x `rows` cells placed at `origin` inside a world scaled by `zoom`.
function scaledScreen({ cols = 80, rows = 24, origin = { x: 300, y: 200 }, zoom = 1 } = {}) {
    const width = cols * CELL.width, height = rows * CELL.height;
    const screen = {
        isConnected: true,
        style: { width: `${width}px`, height: `${height}px` },
        offsetWidth: Math.round(width), offsetHeight: Math.round(height),
        getBoundingClientRect: () => ({ left: origin.x, top: origin.y, width: width * zoom, height: height * zoom })
    };
    const terminal = { querySelector: selector => (selector === '.xterm-screen' ? screen : null) };
    const inside = { closest: selector => (selector === '.xterm' ? terminal : null) };
    return { screen, inside, origin, zoom };
}
// The client point of the middle of a cell (1-based), as the user sees it on the zoomed canvas.
const cellCenter = ({ origin, zoom }, col, row) => ({
    clientX: origin.x + (col - 1 + 0.4) * CELL.width * zoom,
    clientY: origin.y + (row - 0.5) * CELL.height * zoom
});

function fakeWindow() {
    const listeners = new Map();
    return {
        getComputedStyle: element => element.style || { width: '', height: '' },
        addEventListener(type, handler, options) { assert.equal(options.capture, true); listeners.set(type, handler); },
        removeEventListener(type) { listeners.delete(type); },
        dispatch(type, values) {
            const event = { type, buttons: 0, ...values };
            listeners.get(type)?.(event);
            return event;
        },
        listeners
    };
}

test('scale and unscaled points follow the rendered size of the element', () => {
    assert.deepEqual(P.scaleOf({ width: 300, height: 100 }, 600, 200), { x: 0.5, y: 0.5 });
    assert.deepEqual(P.scaleOf({ width: 0, height: 0 }, 600, 200), { x: 1, y: 1 }, 'hidden elements are not rescaled');
    assert.equal(P.isScaled({ x: 1.00001, y: 1 }), false);
    assert.equal(P.isScaled({ x: 0.65, y: 0.65 }), true);
    assert.deepEqual(P.unscalePoint({ x: 150, y: 70 }, { left: 100, top: 50 }, { x: 0.5, y: 0.5 }), { x: 200, y: 90 });
    assert.deepEqual(P.unscalePoint({ x: 400, y: 250 }, { left: 100, top: 50 }, { x: 2, y: 2 }), { x: 250, y: 150 });
});

test('a zoomed terminal maps the pointer to the cell under it, where raw coordinates drift', () => {
    for (const zoom of [0.35, 0.65, 1.5, 2.5]) {
        const terminal = scaledScreen({ zoom, origin: { x: 137.5, y: 92.25 } });
        const rect = terminal.screen.getBoundingClientRect();
        const win = fakeWindow();
        P.install(win);
        for (const [col, row] of [[1, 1], [12, 3], [40, 12], [80, 24]]) {
            const raw = cellCenter(terminal, col, row);
            if (col > 1) assert.notDeepEqual(xtermCell(raw, rect), { col, row }, `zoom ${zoom} reproduces the drift without the fix`);
            const event = win.dispatch('mousemove', { ...raw, target: terminal.inside });
            assert.deepEqual(xtermCell(event, rect), { col, row }, `zoom ${zoom}, cell ${col},${row}`);
            assert.equal(event.x, event.clientX);
            assert.equal(event.y, event.clientY);
        }
    }
});

test('drags keep mapping into the terminal where they began, in both directions', () => {
    const terminal = scaledScreen({ zoom: 0.65 });
    const rect = terminal.screen.getBoundingClientRect();
    const win = fakeWindow();
    P.install(win);
    const elsewhere = { closest: () => null };
    const down = win.dispatch('mousedown', { ...cellCenter(terminal, 30, 10), target: terminal.inside, buttons: 1 });
    assert.deepEqual(xtermCell(down, rect), { col: 30, row: 10 });
    // Backward drag that leaves the terminal over unrelated canvas elements.
    const back = win.dispatch('mousemove', { ...cellCenter(terminal, 5, 2), target: elsewhere, buttons: 1 });
    assert.deepEqual(xtermCell(back, rect), { col: 5, row: 2 });
    const forward = win.dispatch('mousemove', { ...cellCenter(terminal, 70, 20), target: elsewhere, buttons: 1 });
    assert.deepEqual(xtermCell(forward, rect), { col: 70, row: 20 });
    const up = win.dispatch('mouseup', { ...cellCenter(terminal, 70, 20), target: elsewhere });
    assert.deepEqual(xtermCell(up, rect), { col: 70, row: 20 });
    // After release, events outside terminals are left untouched.
    const after = win.dispatch('mousemove', { clientX: 5, clientY: 6, target: elsewhere });
    assert.deepEqual([after.clientX, after.clientY], [5, 6]);
});

test('a drag released outside the window stops mapping on the next buttonless move', () => {
    const terminal = scaledScreen({ zoom: 0.5 });
    const win = fakeWindow();
    P.install(win);
    win.dispatch('mousedown', { ...cellCenter(terminal, 3, 3), target: terminal.inside, buttons: 1 });
    const stray = win.dispatch('mousemove', { clientX: 9, clientY: 9, target: { closest: () => null }, buttons: 0 });
    assert.deepEqual([stray.clientX, stray.clientY], [9, 9]);
});

test('unscaled terminals, detached terminals, and other elements are left untouched', () => {
    const win = fakeWindow();
    const uninstall = P.install(win);
    const plain = scaledScreen({ zoom: 1 });
    const focused = win.dispatch('mousedown', { clientX: 412.3, clientY: 245.1, target: plain.inside, buttons: 1 });
    assert.deepEqual([focused.clientX, focused.clientY], [412.3, 245.1]);
    assert.equal(Object.hasOwn(focused, 'x'), false);
    win.dispatch('mouseup', { clientX: 0, clientY: 0, target: plain.inside });
    const detached = scaledScreen({ zoom: 0.5 });
    detached.screen.isConnected = false;
    const gone = win.dispatch('click', { clientX: 400, clientY: 300, target: detached.inside });
    assert.deepEqual([gone.clientX, gone.clientY], [400, 300]);
    const canvas = win.dispatch('wheel', { clientX: 10, clientY: 20, target: { closest: () => null } });
    assert.deepEqual([canvas.clientX, canvas.clientY], [10, 20]);
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel']) {
        assert.equal(win.listeners.has(type), true, `${type} is mapped`);
    }
    uninstall();
    assert.equal(win.listeners.size, 0);
});
