const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const fixture = require('./golden/renderer.json');
const PROFILES = fixture.profiles;
// Clone host-captured JSON for UI state tests; validation and factory parity live in Rust.
const createWorkspace = () => structuredClone(fixture.workspace);
const createCard = (options = {}) => ({ ...structuredClone(fixture.cards[options.profile || 'shell']), ...options, id: randomUUID() });

function twoCanvases() {
    const workspace = createWorkspace(), first = createCard({ title: 'Foreground' }), second = createCard({ title: 'Background' });
    workspace.cards = [first, second];
    workspace.canvases = [first, second].map((card, index) => ({ id: `canvas-${index}`, name: `Project ${index}`,
        camera: { x: index * -100, y: index * 50, z: index ? .75 : 1 }, cardIds: [card.id], itemIds: [], selected: card.id }));
    workspace.activeCanvas = 'canvas-0';
    return workspace;
}

// A small DOM boundary substitute checks renderer boot/state without claiming visual coverage.
class Element {
    constructor() {
        this.children = []; this.queries = new Map(); this.value = ''; this.hidden = false; this.isConnected = true;
        const classes = new Set();
        this.style = { setProperty() {} };
        this.classList = {
            toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return !!force; },
            add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); },
            contains: name => classes.has(name)
        };
        this.dataset = {}; this.lastChild = { textContent: '' }; this.clientWidth = 1100; this.clientHeight = 720;
        this.listeners = new Map(); this.listenerOptions = new Map(); this.attributes = new Map(); this.captured = new Set();
    }
    append(...children) {
        for (const child of children) {
            if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(node => node !== child);
            child.parentElement = this;
            this.children.push(child);
        }
    }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = children; }
    get childElementCount() { return this.children.length; }
    querySelector(selector) {
        if (!this.queries.has(selector)) { const child = new Element(); child.ownerDocument = this.ownerDocument; this.queries.set(selector, child); }
        return this.queries.get(selector);
    }
    querySelectorAll() { return []; }
    addEventListener(type, handler, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
        this.listenerOptions.set(handler, options);
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    dispatch(type, values = {}) {
        let stopped = false;
        const event = { type, button: 0, pointerId: 1, clientX: 0, clientY: 0, target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...values };
        for (const handler of [...(this.listeners.get(type) || [])]) { handler(event); if (stopped) break; }
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    remove() { this.isConnected = false; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    closest() { return null; }
    contains(element) { return !!element && (element === this || this.children.some(child => child.contains?.(element))); }
    click() { this.onclick?.(); }
    focus() { this.focusCount = (this.focusCount || 0) + 1; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
    blur() { this.dispatch('blur'); }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
}
class KeyboardTerminal {
    constructor(options = {}) { this.selection = ''; this.pasted = []; this.options = { ...options }; this.cols = 80; this.rows = 24; }
    loadAddon(addon) { addon.activate?.(this); }
    open() {}
    onData(handler) { this.dataHandler = handler; }
    onResize(handler) { this.resizeHandler = handler; }
    resize(cols, rows) {
        if (cols === this.cols && rows === this.rows) return;
        this.cols = cols; this.rows = rows; this.resizeHandler?.({ cols, rows });
    }
    attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
    getSelection() { return this.selection; }
    hasSelection() { return !!this.selection; }
    paste(text) { this.pasted.push(text); }
    focus() {}
    reset() { this.selection = ''; }
    writeln() {}
    dispose() {}
}


test('legacy workspaces open as one canvas and keep format-3 serialized defaults', async () => {
    for (const version of [1, 2, 3]) {
        const board = createWorkspace(); board.version = version; board.cards.push(createCard());
        const { context, calls } = await boot(board);
        assert.equal(json(context, 'canvasStates.length'), 1);
        assert.deepEqual(json(context, 'workspaceSnapshot()'), { ...board, version: 3 });
        assert.equal(calls.length, 1, 'Opening a workspace never starts its terminals');
    }
});

test('many canvases can be created, reordered, renamed, and restored with independent cameras and history', async () => {
    const { context, elements } = await boot(createWorkspace());
    vm.runInContext(`
        addItem(makeItem('note', { x: 10, y: 20, w: 100, h: 100 }));
        workspace.camera = { x: 321, y: -456, z: .65 };
        globalThis.original = activeCanvas.id;
        for (let index = 0; index < 160; index++) createCanvas();
        workspace.camera = { x: -80, y: 42, z: 1.2 };
        reorderCanvas(-1); renameCanvas();
    `, context);
    elements.get('#canvas-name').value = 'My project 日本語';
    elements.get('#canvas-form').onsubmit({ preventDefault() {} });
    assert.equal(json(context, 'canvasStates.length'), 161);
    assert.equal(elements.get('#canvas-list').childElementCount, 161);
    assert.equal(json(context, 'canvasStates.indexOf(activeCanvas)'), 159);
    assert.equal(json(context, 'activeCanvas.name'), 'My project 日本語');
    const saved = json(context, 'workspaceSnapshot()');
    vm.runInContext('switchCanvas(original)', context);
    assert.deepEqual(json(context, 'workspace.camera'), { x: 321, y: -456, z: .65 });
    assert.equal(json(context, 'workspace.items.length'), 1);
    assert.equal(json(context, 'boardHistory.undo.length'), 1);
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items.length'), 0);
    context.saved = saved; vm.runInContext('loadWorkspace(saved)', context);
    assert.deepEqual(json(context, 'workspace.camera'), { x: -80, y: 42, z: 1.2 });
    assert.equal(json(context, 'activeCanvas.name'), 'My project 日本語');
    assert.deepEqual(json(context, 'workspaceSnapshot()'), saved);
});

test('workspace themes reach hidden canvases, survive save and reload, and respect independent history', async () => {
    const board = twoCanvases(); board.terminalTheme = 'midnight'; board.cards[1].theme = 'paper';
    const { context, elements, calls } = await boot(board, { terminals: true });
    const backgrounds = () => json(context, '[...sessions.values()].map(s => s.terminal.options.theme.background)');
    const themes = require('../src/terminal-themes.js');
    assert.deepEqual(backgrounds(), [themes.midnight.background, themes.paper.background]);
    vm.runInContext(`
        globalThis.terminalsBefore = [...sessions.values()].map(s => s.terminal);
        addItem(makeItem('note', { x: 10, y: 20, w: 100, h: 100 }));
        switchCanvas('canvas-1'); setTerminalTheme('current'); setTerminalTheme('paper', true);
        switchCanvas('canvas-0'); undo();
    `, context);
    assert.equal(json(context, 'workspace.items.length'), 0);
    assert.equal(elements.get('#workspace-theme').value, 'paper', 'an unrelated undo keeps the shared default');
    assert.deepEqual(backgrounds(), [themes.paper.background, themes.current.background]);
    vm.runInContext(`switchCanvas('canvas-1'); undo()`, context);
    assert.deepEqual(backgrounds(), [themes.midnight.background, themes.current.background]);
    vm.runInContext('redo(); undo(); undo(); redo(); redo(); createCanvas("New canvas")', context);
    assert.equal(elements.get('#workspace-theme').value, 'paper', 'new canvases inherit the workspace default');
    assert.equal(json(context, '[...sessions.values()].every((s, index) => s.terminal === terminalsBefore[index])'), true);
    await vm.runInContext('save()', context);
    const saved = JSON.parse(JSON.stringify(calls.find(call => call.action === 'save').payload));
    assert.equal(saved.terminalTheme, 'paper');
    assert.equal(saved.canvases.length, 3);
    assert.equal(saved.cards[1].theme, 'current');
    context.saved = saved; vm.runInContext('loadWorkspace(saved)', context);
    assert.deepEqual(json(context, 'workspaceSnapshot()'), saved);
    assert.deepEqual(backgrounds(), [themes.paper.background, themes.current.background]);
    vm.runInContext(`switchCanvas('canvas-0'); setTerminalTheme('current', true)`, context);
    assert.equal(json(context, '"terminalTheme" in workspaceSnapshot()'), false);
    assert.equal(json(context, 'canvasStates.every(canvas => !("terminalTheme" in canvas.board))'), true);
    assert.equal(calls.some(call => ['start', 'stop'].includes(call.action)), false);
});

test('hidden canvases keep complete writes, acknowledgments, cwd and session metadata without fitting', async () => {
    const board = twoCanvases(), hiddenId = board.cards[1].id;
    const { context, bridge, onEvent, calls, elements } = await boot(board, { terminals: true });
    context.hiddenId = hiddenId;
    vm.runInContext(`
        globalThis.output = []; globalThis.acks = [];
        const background = sessions.get(hiddenId);
        background.status = 'running';
        background.terminal.write = (data, done) => { output.push(data); done(); };
        background.terminal.writeln = data => output.push(data);
        background.fit.proposeDimensions = () => { throw new Error('Hidden terminal was fitted'); };
        Object.defineProperty(background.element, 'offsetWidth', { get() { throw new Error('Hidden terminal layout was read'); }, configurable: true });
        bridge.acknowledge = (id, length) => acks.push({ id, length });
        fitTerminal(background);
    `, context);
    const chunks = Array.from({ length: 400 }, (_, index) => `${index} 日本語 😀\r\n`);
    for (const data of chunks) onEvent({ type: 'data', id: hiddenId, data });
    assert.deepEqual(json(context, 'output'), chunks);
    assert.deepEqual(json(context, 'acks'), chunks.map(data => ({ id: hiddenId, length: data.length })));
    assert.equal(json(context, 'sessions.get(hiddenId).element.hidden'), true);
    assert.match(elements.get('#canvas-list').children[1].textContent, /New output/);
    assert.equal(elements.get('#canvas-activity').hidden, false);
    assert.match(elements.get('#canvas-activity').textContent, /Project 1: New output/);
    const session = { provider: 'codex', sessionId: randomUUID(), cwd: '/agent' };
    onEvent({ type: 'cwd', id: hiddenId, cwd: '/live' });
    onEvent({ type: 'metadata', id: hiddenId, cwd: '/latest', session });
    assert.equal(json(context, 'anyCard(hiddenId).cwd'), '/latest');
    assert.deepEqual(json(context, 'anyCard(hiddenId).session'), session);
    assert.equal(calls.some(call => call.action === 'stop'), false);
    onEvent({ type: 'recovered', id: hiddenId, exitCode: 1 });
    assert.equal(json(context, 'sessions.get(hiddenId).status'), 'running');
    assert.match(json(context, 'output.at(-1)'), /Started a fresh shell/);
    assert.deepEqual(json(context, 'output.slice(0, -1)'), chunks);

    onEvent({ type: 'exit', id: hiddenId, exitCode: 7 });
    assert.equal(json(context, 'sessions.get(hiddenId).status'), 'exited');
    assert.match(elements.get('#canvas-list').children[1].textContent, /Exited/);
    vm.runInContext(`delete sessions.get(hiddenId).element.offsetWidth; switchCanvas('canvas-1')`, context);
    assert.equal(json(context, 'sessions.get(hiddenId).element.hidden'), false);
    assert.doesNotMatch(elements.get('#canvas-list').children[1].textContent, /Exited|New output/);
    assert.equal(elements.get('#canvas-activity').hidden, true);
    await bridge.invoke('noop');
});

test('a hidden window acknowledges output on arrival so throttled parsing cannot pause the terminal', async () => {
    const board = createWorkspace(), card = createCard(); board.cards.push(card);
    const { context, onEvent, document, documentListeners } = await boot(board, { terminals: true });
    context.id = card.id;
    vm.runInContext(`
        globalThis.parsed = []; globalThis.acks = [];
        // Writes wait for xterm's (throttled) parse timer until the test runs it.
        sessions.get(id).terminal.write = (data, done) => parsed.push(done);
        bridge.acknowledge = (terminal, amount) => acks.push({ terminal, amount });
    `, context);
    const total = () => json(context, 'acks.reduce((sum, ack) => sum + ack.amount, 0)');
    const parse = () => vm.runInContext('parsed.shift()()', context);

    onEvent({ type: 'data', id: card.id, data: 'visible' });
    assert.equal(total(), 0, 'a visible window acknowledges only parsed output');
    parse();
    assert.deepEqual(json(context, 'acks'), [{ terminal: card.id, amount: 7 }]);

    onEvent({ type: 'data', id: card.id, data: 'waiting 日本語' });
    document.hidden = true; documentListeners.get('visibilitychange')();
    assert.equal(total(), 7 + 11, 'output already waiting is released when the window hides');
    onEvent({ type: 'data', id: card.id, data: '😀 while hidden' });
    assert.equal(total(), 7 + 11 + 15, 'hidden output is acknowledged on arrival');
    parse(); parse();
    assert.equal(total(), 7 + 11 + 15, 'parsing later never acknowledges twice');

    const chunk = 'x'.repeat(1_000_000);
    for (let index = 0; index < 5; index++) onEvent({ type: 'data', id: card.id, data: chunk });
    assert.equal(total(), 7 + 11 + 15 + 4_000_000, 'the unparsed backlog is bounded');
    assert.ok(json(context, 'acks.every(ack => ack.amount <= 1024 * 1024)'), 'each acknowledgment stays within the host limit');
    parse();
    assert.equal(total(), 33 + 5_000_000, 'parsing releases what the bound held back');
    onEvent({ type: 'data', id: card.id, data: 'held' });
    assert.equal(total(), 33 + 5_000_000, 'at the bound, output waits for parsing');
    parse();
    assert.equal(total(), 33 + 5_000_004);

    document.hidden = false; documentListeners.get('visibilitychange')();
    onEvent({ type: 'data', id: card.id, data: 'visible again' });
    assert.equal(total(), 33 + 5_000_004, 'a shown window waits for parsing again');
    while (json(context, 'parsed.length')) parse();
    assert.equal(total(), 33 + 5_000_004 + 13);
    assert.equal(json(context, 'sessions.get(id).unacknowledged'), 0);
});

test('canvas switches restore selection, fullscreen focus, and hide SVG connectors as well as cards', async () => {
    const board = twoCanvases();
    board.items = [{ id: 'connector', type: 'line', start: { id: board.cards[0].id }, end: { x: 12, y: 34 }, arrow: true }];
    board.canvases[0].itemIds = ['connector']; board.canvases[0].focused = board.cards[0].id;
    const { context, calls } = await boot(board);
    assert.equal(json(context, 'focused'), board.cards[0].id);
    vm.runInContext(`switchCanvas('canvas-1')`, context);
    assert.equal(json(context, 'focused'), null);
    assert.equal(json(context, 'itemViews.get("connector").element.style.display'), 'none');
    assert.equal(json(context, 'selected'), board.cards[1].id);
    context.firstId = board.cards[0].id;
    assert.equal(vm.runInContext('showTerminal(firstId)', context), true);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-0');
    assert.equal(json(context, 'focused'), board.cards[0].id);
    assert.equal(json(context, 'itemViews.get("connector").element.style.display'), '');
    assert.equal(calls.some(call => ['start', 'stop'].includes(call.action)), false);
});

test('deleting a canvas cancels safely and stops only its terminals after confirmation', async () => {
    const board = twoCanvases();
    const { context, elements, calls } = await boot(board);
    vm.runInContext('for (const s of sessions.values()) s.status = "running"', context);
    const canceled = vm.runInContext('deleteCanvas()', context);
    assert.equal(elements.get('#confirm-dialog').open, true);
    assert.match(elements.get('#confirm-description').textContent, /1 running terminal/);
    assert.equal(calls.filter(call => call.action === 'stop').length, 0);
    elements.get('#confirm-cancel').onclick(); await canceled;
    assert.equal(json(context, 'canvasStates.length'), 2);
    const deleted = vm.runInContext('deleteCanvas()', context);
    elements.get('#confirm-ok').onclick(); await deleted;
    assert.deepEqual(calls.filter(call => call.action === 'stop').map(call => call.payload.id), [board.cards[0].id]);
    assert.equal(json(context, 'canvasStates.length'), 1);
    assert.equal(json(context, 'sessions.size'), 1);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.equal(json(context, '[...sessions.values()][0].status'), 'running');
    assert.equal(elements.get('#canvas-delete').disabled, true);
});

test('a failed process stop preserves the canvas and its terminal views', async () => {
    const { context, elements } = await boot(twoCanvases(), { respond: action => action === 'stop' ? { error: 'Stop failed' } : undefined });
    const deleting = vm.runInContext('deleteCanvas()', context);
    elements.get('#confirm-ok').onclick();
    await assert.rejects(deleting, /Stop failed/);
    assert.equal(json(context, 'canvasStates.length'), 2);
    assert.equal(json(context, 'sessions.size'), 2);
    assert.equal(json(context, 'canvasMutation'), false);
});

test('save, export and close include hidden canvases, images and their undo history', async () => {
    const { context, calls } = await boot(createWorkspace());
    vm.runInContext(`
        const image = { id: 'image', type: 'image', asset: '${'a'.repeat(64)}.png', x: 10, y: 20, w: 100, h: 100 };
        addItem(image); recordHistory(); removeItems(['image']);
        createCanvas('Second');
        addItem({ ...image, id: 'other', asset: '${'b'.repeat(64)}.png' });
    `, context);
    assert.deepEqual(json(context, 'referencedImages().sort()'), [`${'a'.repeat(64)}.png`, `${'b'.repeat(64)}.png`]);
    for (const action of ['autosave', 'save', 'export', 'close']) {
        context.action = action; await vm.runInContext('invoke(action, workspace)', context);
        const saved = calls.at(-1).payload;
        assert.equal(saved.canvases.length, 2); assert.equal(saved.items.length, 1);
        assert.equal(saved.activeCanvas, saved.canvases[1].id);
    }
});

test('canvas shortcuts work from xterm and mutations wait for gestures and imports', async () => {
    const board = twoCanvases();
    const { context, documentListeners } = await boot(board, { terminals: true });
    context.firstId = board.cards[0].id;
    assert.equal(vm.runInContext(`sessions.get(firstId).terminal.keyHandler({ key: 'PageDown', ctrlKey: true, shiftKey: true })`, context), false);
    const key = { key: 'PageDown', ctrlKey: true, shiftKey: true, preventDefault() {}, target: new Element() };
    documentListeners.get('keydown')(key);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    vm.runInContext('imageImports++;', context);
    assert.equal(vm.runInContext(`switchCanvas('canvas-0')`, context), false);
    vm.runInContext('imageImports--; activeDrags++;', context);
    assert.equal(vm.runInContext('createCanvas()', context), false);
    vm.runInContext('activeDrags--', context);
    documentListeners.get('keydown')({ ...key, key: 'K' });
    assert.equal(json(context, 'canvasStates.length'), 3);
});

test('a requested terminal beside a hidden parent switches to its owning canvas before placement', async () => {
    const board = twoCanvases();
    const { context } = await boot(board, { respond: (action, options) => action === 'create-card' ? { card: createCard(options) } : undefined });
    context.parentId = board.cards[1].id;
    vm.runInContext(`start = async () => {};`, context);
    await vm.runInContext(`openRequestedTerminal({ external: true, parent: parentId, profile: 'shell', title: 'Child' })`, context);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.equal(json(context, 'workspace.cards.length'), 2);
    assert.equal(json(context, 'workspace.items[0].start.id'), board.cards[1].id);
    assert.equal(json(context, 'canvasStates[0].board.cards.length'), 1);
    assert.equal(json(context, 'canvasMutation'), false);
});

test('a terminal finishing startup on a hidden canvas does not take the keyboard', async () => {
    const board = twoCanvases();
    const { context } = await boot(board, { terminals: true });
    context.id = board.cards[0].id;
    vm.runInContext(`
        sessions.get(id).terminal.focus = () => { globalThis.stolenFocus = true; };
        bridge.invoke = async action => action === 'start' ? new Promise(resolve => { globalThis.completeStart = resolve; }) : ({ ok: true });
    `, context);
    const starting = vm.runInContext('start(workspace.cards[0])', context);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext(`switchCanvas('canvas-1'); completeStart({ cwd: '/ready' })`, context);
    await starting;
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.equal(vm.runInContext('globalThis.stolenFocus', context), undefined);
    assert.equal(json(context, 'anyCard(id).cwd'), '/ready');
});

test('using the canvas selector remembers the terminal that had typing focus', async () => {
    const board = twoCanvases();
    const { context, document, documentListeners } = await boot(board, { terminals: true });
    vm.runInContext(`const current = sessions.get(selected); current.status = 'running'; current.terminal.focus = () => { globalThis.focusRestored = true; };`, context);
    documentListeners.get('focusin')({ target: { closest: selector => selector === '.xterm' ? {} : null } });
    document.activeElement = { closest: selector => selector === '.canvas-manager' ? {} : null };
    vm.runInContext(`switchCanvas('canvas-1'); switchCanvas('canvas-0')`, context);
    assert.equal(json(context, 'globalThis.focusRestored'), true);
});

test('the workspace item budget includes hidden boards and prevents undo from exceeding it', async () => {
    const { context, elements } = await boot(createWorkspace());
    vm.runInContext(`
        globalThis.firstCanvas = activeCanvas.id;
        addItem(makeItem('note', { x: 0, y: 0, w: 100, h: 100 }));
        recordHistory(); removeItems([workspace.items[0].id]);
        createCanvas();
        addItems(Array.from({ length: 1000 }, () => makeItem('note', { x: 0, y: 0, w: 100, h: 100 })));
        switchCanvas(firstCanvas);
        undo();
    `, context);
    assert.equal(json(context, 'workspace.items.length'), 0);
    assert.equal(json(context, 'boardHistory.undo.length'), 2, 'A blocked undo must remain available');
    assert.equal(json(context, 'workspaceItemCount()'), 1000);
    assert.match(elements.get('#toast').textContent, /1,000 canvas items/);
});
async function boot(workspace, { initialized = true, respond, terminals = false, clipboard = { text: '' }, readClipboard, platform = 'win32', remote = false, role = 'control', ...windowOverrides } = {}) {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
    elements.get('#toast').hidden = true;
    elements.get('#canvas-menu').hidden = true;
    elements.get('#minimap-map').clientWidth = 198;
    elements.get('#minimap-map').clientHeight = 120;
    const calls = [];
    let onEvent;
    const bridge = {
        remote,
        role,
        async invoke(action, payload) {
            calls.push({ action, payload });
            const response = respond?.(action, payload);
            if (response) return response;
            if (action === 'initialize') return initialized ? { workspace: structuredClone(workspace), profiles: PROFILES, home: '', platform } : new Promise(() => {});
            if (action === 'clipboard-write') clipboard.text = payload;
            if (action === 'clipboard-read') return readClipboard ? readClipboard() : { text: clipboard.text };
            return { ok: true };
        },
        onEvent(handler) { onEvent = handler; this.event = handler; }, resize() {}, acknowledge() {}, input() {}
    };
    const documentListeners = new Map();
    const document = Object.assign(new Element(), {
        body: new Element(),
        querySelector: selector => selector === 'dialog[open]' ? [...elements.values()].find(e => e.open) : elements.get(selector),
        querySelectorAll: () => [], createElement: () => new Element(), createElementNS: () => new Element(), addEventListener(type, fn) { documentListeners.set(type, fn); Element.prototype.addEventListener.call(this, type, fn); }
    });
    for (const element of elements.values()) element.ownerDocument = document;
    const window = Object.assign(new Element(), { terminalCanvas: bridge }, terminals ? { Terminal: KeyboardTerminal, FitAddon: { FitAddon: class {} } } : {}, windowOverrides);
    const frames = [];
    const context = vm.createContext({ document, window, ResizeObserver: class { observe() {} disconnect() {} }, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => frames.push(callback) });
    // Load renderer scripts in the same order as index.html.
    for (const [, script] of html.matchAll(/<script src="\.\/([^"]+)" defer>/g)) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', script), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    return { elements, calls, context, onEvent, document, window, bridge, documentListeners, frames, event: payload => bridge.event(payload) };
}

const canvasTarget = selector => ({ closest: query => query.split(',').map(part => part.trim()).includes(selector) ? {} : null });
function openMenu(elements, values = {}) {
    let prevented = false;
    elements.get('#viewport').dispatch('contextmenu', { button: 2, clientX: 400, clientY: 300, preventDefault() { prevented = true; }, ...values });
    return prevented;
}

test('canvas menu opens only on empty background and uses the sidebar launch profiles', async () => {
    const { elements, calls } = await boot(createWorkspace());
    const menu = elements.get('#canvas-menu'), profiles = elements.get('#canvas-menu-profiles').children;
    assert.equal(menu.hidden, true);
    assert.deepEqual(profiles.map(button => button.children[1].textContent), PROFILES.map(profile => profile.name));
    for (const button of profiles) assert.equal(button.attributes.get('role'), 'menuitem');
    for (const selector of ['.terminal-card', '.canvas-item', '.canvas-line', '.minimap', '.canvas-toolbar', '.create-toolbar', '.style-toolbar', '.exit-focus', 'button', 'input', '[contenteditable="true"]']) {
        assert.equal(openMenu(elements, { target: canvasTarget(selector) }), false, selector);
        assert.equal(menu.hidden, true, selector);
    }
    assert.equal(openMenu(elements), true);
    assert.equal(menu.hidden, false);
    assert.equal(profiles[0].focusCount, 1);
    assert.equal(profiles[0].tabIndex, 0);
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
});

test('canvas menu clears old launch points on a canvas switch and creates only on the active canvas', async () => {
    const board = twoCanvases();
    const { elements, context, calls } = await boot(board, { respond: (action, payload) => action === 'create-card' ? { card: createCard(payload) } : null });
    vm.runInContext('start = async () => {}; canvasMutation = true', context);
    assert.equal(openMenu(elements), false, 'an asynchronous canvas mutation cannot open a menu');
    vm.runInContext('canvasMutation = false', context);
    assert.equal(openMenu(elements), true);
    assert.ok(json(context, 'canvasMenuPoint'));
    vm.runInContext('switchCanvas("canvas-1")', context);
    assert.equal(elements.get('#canvas-menu').hidden, true);
    assert.equal(json(context, 'canvasMenuPoint'), null);
    assert.equal(openMenu(elements), true);
    const point = json(context, 'canvasMenuPoint');
    elements.get('#canvas-menu-profiles').children[0].click();
    assert.equal(vm.runInContext('switchCanvas("canvas-0")', context), false, 'the launch dialog keeps its owning canvas active');
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    const request = calls.find(call => call.action === 'create-card').payload;
    assert.deepEqual({ x: request.x, y: request.y }, point);
    assert.deepEqual(json(context, 'canvasStates.map(canvas => canvas.board.cards.length)'), [1, 2]);
    assert.equal(json(context, 'sessions.get(workspace.cards.at(-1).id).canvas.id'), 'canvas-1');
});

test('canvas menu is unavailable before initialization, during drags, in Focus, or behind a dialog', async () => {
    const loading = await boot(createWorkspace(), { initialized: false });
    assert.equal(openMenu(loading.elements), false);
    const board = createWorkspace(); board.cards.push(createCard());
    const { elements, context } = await boot(board);
    vm.runInContext('activeDrags = 1', context);
    assert.equal(openMenu(elements), false);
    vm.runInContext('activeDrags = 0; setFocus(workspace.cards[0].id)', context);
    assert.equal(openMenu(elements), false);
    vm.runInContext('setFocus(null); openLaunch()', context);
    assert.equal(openMenu(elements), false);
});

test('hand tool hit testing keeps cards and shapes out of the background menu', async () => {
    const board = createWorkspace(); board.camera = { x: 0, y: 0, z: 1 };
    board.cards.push(createCard({ x: 100, y: 100 }));
    board.items.push({ id: 'shape', type: 'shape', shape: 'rect', x: 800, y: 100, w: 150, h: 100, text: '' });
    const { elements, context } = await boot(board);
    vm.runInContext('setTool("hand")', context);
    // In hand mode the browser targets the viewport even above an existing item.
    assert.equal(openMenu(elements, { clientX: 200, clientY: 200 }), false);
    assert.equal(openMenu(elements, { clientX: 850, clientY: 150 }), false);
    assert.equal(openMenu(elements, { clientX: 1000, clientY: 200 }), true);
});

test('menu creation retains the clicked world point through the launch form at different zooms', async () => {
    for (const z of [.35, 1, 1.5]) {
        const board = createWorkspace(); board.camera = { x: -160, y: 85, z };
        const { elements, context, calls } = await boot(board, { respond: (action, payload) => action === 'create-card' ? { card: createCard(payload) } : null });
        const viewport = elements.get('#viewport');
        viewport.getBoundingClientRect = () => ({ left: 250, top: 140, width: 1100, height: 720 });
        vm.runInContext('start = async card => invoke("start", { card })', context);
        assert.equal(openMenu(elements, { clientX: 683, clientY: 465 }), true);
        const expected = { x: (683 - 250 + 160) / z, y: (465 - 140 - 85) / z };
        elements.get('#canvas-menu-profiles').children[1].click();
        assert.equal(elements.get('#canvas-menu').hidden, true);
        assert.equal(elements.get('#launch-dialog').open, true);
        assert.equal(elements.get('#profile').value, PROFILES[1].id);
        assert.equal(elements.get('#command').value, PROFILES[1].command);
        assert.equal(calls.length, 1, 'choosing a profile does not start anything');
        // A camera change while the form is open must not move the requested world point.
        vm.runInContext('workspace.camera = { x: 12, y: 34, z: 1.2 }', context);
        elements.get('#terminal-title').value = 'Reviewed name'; elements.get('#terminal-title').oninput();
        elements.get('#cwd').value = '/project';
        elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
        const request = calls.find(call => call.action === 'create-card').payload;
        assert.deepEqual({ x: request.x, y: request.y }, expected);
        assert.equal(request.title, 'Reviewed name'); assert.equal(request.cwd, '/project');
        assert.equal(request.titleMode, 'manual');
        assert.equal(calls.filter(call => call.action === 'start').length, 1);
    }
});

test('canceling a menu launch does not create a card or change the next normal launch position', async () => {
    const { elements, calls, context } = await boot(createWorkspace(), { respond: (action, payload) => action === 'create-card' ? { card: createCard(payload) } : null });
    vm.runInContext('start = async () => {}', context);
    openMenu(elements); elements.get('#canvas-menu-profiles').children[0].click();
    elements.get('#terminal-title').value = 'Cancelled manual name'; elements.get('#terminal-title').oninput();
    elements.get('#launch-dialog').close();
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
    elements.get('#add-terminal').click();
    const expected = json(context, '({ x: Math.round((60 - workspace.camera.x) / workspace.camera.z), y: Math.round((40 - workspace.camera.y) / workspace.camera.z) })');
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    const request = calls.find(call => call.action === 'create-card').payload;
    assert.deepEqual({ x: request.x, y: request.y }, expected);
    assert.equal(request.titleMode, 'automatic', 'cancelled menu edits do not make the next ordinary title manual');
});

test('menu launches reset reviewed duplicate appearance and duplicate review resets menu placement', async () => {
    const board = createWorkspace(); board.terminalTheme = 'midnight';
    board.cards.push(createCard({ fontSize: 20, color: 'red', theme: 'paper', claudeAccount: 'Work' }));
    const { elements, calls, context } = await boot(board, { terminals: true, respond: (action, payload) =>
        action === 'create-card' ? { card: createCard(payload) }
            : action === 'duplicate-directory' ? { cwd: '/review', warning: 'Review folder.' } : null });
    vm.runInContext('start = async () => {}', context);
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    elements.get('#launch-dialog').close();
    assert.equal(openMenu(elements), true);
    const point = json(context, 'canvasMenuPoint');
    elements.get('#canvas-menu-profiles').children[0].click();
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    const request = calls.find(call => call.action === 'create-card').payload;
    assert.deepEqual({ x: request.x, y: request.y }, point);
    assert.equal(request.titleMode, 'automatic');
    assert.deepEqual(json(context, '[workspace.cards.at(-1).fontSize ?? null, workspace.cards.at(-1).color ?? null, workspace.cards.at(-1).theme ?? null, workspace.cards.at(-1).claudeAccount ?? null]'), [null, null, null, null]);
    assert.equal(json(context, 'sessions.get(workspace.cards.at(-1).id).terminal.options.theme.background'), vm.runInContext('window.TerminalCanvasThemes.midnight.background', context));

    // A cancelled menu launch must not supply the position for a reviewed duplicate.
    openMenu(elements); elements.get('#canvas-menu-profiles').children[0].click();
    elements.get('#launch-dialog').close();
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    const expected = json(context, '({ x: Math.round((60 - workspace.camera.x) / workspace.camera.z + (workspace.cards.length % 4) * 35), y: Math.round((40 - workspace.camera.y) / workspace.camera.z + (workspace.cards.length % 4) * 35) })');
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    const duplicate = calls.filter(call => call.action === 'create-card').at(-1).payload;
    assert.deepEqual({ x: duplicate.x, y: duplicate.y }, expected);
    assert.deepEqual(json(context, '[workspace.cards.at(-1).fontSize, workspace.cards.at(-1).color, workspace.cards.at(-1).theme, workspace.cards.at(-1).claudeAccount]'), [20, 'red', 'paper', 'Work']);
    assert.equal(json(context, 'sessions.get(workspace.cards.at(-1).id).terminal.options.theme.background'), vm.runInContext('window.TerminalCanvasThemes.paper.background', context));
});

test('canvas Find opens the shared switcher; a result reveals and highlights without typing', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ x: 5000, y: -3000, title: 'repo · Codex', titleMode: 'automatic' }));
    const { elements, calls, context, onEvent } = await boot(board);
    const query = elements.get('#switcher-query');
    const before = json(context, 'workspace.camera');
    openMenu(elements); elements.get('#canvas-menu-find').click();
    assert.equal(elements.get('#canvas-menu').hidden, true);
    assert.equal(elements.get('#terminal-switcher').open, true);
    assert.equal(query.focusCount, 1);
    query.value = 'Far away'; query.oninput();
    assert.deepEqual(switcherState(context).matches, []);
    onEvent({ type: 'title', id: board.cards[0].id, title: 'Far away', titleMode: 'automatic', titleRevision: 1 });
    assert.deepEqual(switcherState(context).matches, [board.cards[0].id]);
    assert.equal(query.value, 'Far away');
    elements.get('#switcher-results').children[0].click();
    assert.equal(elements.get('#terminal-switcher').open, false);
    assert.equal(json(context, 'keyboardCurrent'), board.cards[0].id);
    assert.equal(json(context, 'selected'), board.cards[0].id);
    assert.equal(json(context, 'workspace.camera.z'), before.z);
    assert.notDeepEqual(json(context, 'workspace.camera'), before);
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).element.classList.contains("keyboard-current")', context), true);
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
});

test('canvas Find preserves collapsed sidebar preferences and cancellation restores canvas focus', async () => {
    const { elements, document, context } = await boot(createWorkspace(), { localStorage: sidebarStorage() });
    for (const selector of ['#workspace-toggle', '#profiles-toggle', '#outline-toggle', '#sidebar-toggle']) elements.get(selector).click();
    const before = json(context, 'workspace.camera');
    assert.equal(openMenu(elements), true);
    elements.get('#canvas-menu-find').click();
    assert.equal(elements.get('#canvas-menu').hidden, true);
    assert.equal(document.activeElement, elements.get('#switcher-query'));
    assert.equal(elements.get('#terminal-switcher').open, true);
    assert.equal(elements.get('#sidebar').hidden, true);
    assert.equal(elements.get('#outline-toggle').attributes.get('aria-expanded'), 'false');
    assert.equal(elements.get('#workspace-section').hidden, true);
    assert.equal(elements.get('#profile-list').hidden, true);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Escape' });
    assert.equal(document.activeElement, elements.get('#viewport'));
    assert.deepEqual(json(context, 'workspace.camera'), before);
});

test('Menu key and Shift+F10 open at the last background point or view center and keep terminal keys alone', async () => {
    const { elements, document, context } = await boot(createWorkspace());
    const viewport = elements.get('#viewport'), menu = elements.get('#canvas-menu');
    const point = (x, y) => json(context, `toWorld({ clientX: ${x}, clientY: ${y} })`);
    document.dispatch('keydown', { key: 'F10', shiftKey: true, isComposing: true, target: viewport });
    assert.equal(menu.hidden, true, 'text composition keeps its keys');
    for (const values of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
        document.dispatch('keydown', { ...values, target: viewport });
        assert.equal(menu.hidden, false);
        assert.deepEqual(json(context, 'canvasMenuPoint'), point(550, 360));
        document.dispatch('keydown', { key: 'Escape', target: viewport });
    }
    viewport.dispatch('pointermove', { clientX: 380, clientY: 220 });
    document.dispatch('keydown', { key: 'ContextMenu', target: viewport });
    assert.deepEqual(json(context, 'canvasMenuPoint'), point(380, 220));
    document.dispatch('keydown', { key: 'Escape', target: viewport });
    for (const selector of ['.terminal-card', '.canvas-item', '.minimap', 'input', 'button']) {
        document.dispatch('keydown', { key: 'F10', shiftKey: true, target: canvasTarget(selector) });
        assert.equal(menu.hidden, true, selector);
    }
});

test('menu keyboard navigation wraps, activates once, isolates canvas shortcuts, and dismisses', async () => {
    const { elements, document, context } = await boot(createWorkspace());
    const viewport = elements.get('#viewport'), menu = elements.get('#canvas-menu');
    const buttons = [...elements.get('#canvas-menu-profiles').children, elements.get('#canvas-menu-find')];
    const key = (key, values = {}) => document.dispatch('keydown', { key, target: viewport, ...values });
    openMenu(elements);
    key('ArrowUp', { isComposing: true }); assert.equal(buttons[0].tabIndex, 0);
    key('ArrowUp'); assert.equal(buttons.at(-1).tabIndex, 0);
    key('ArrowDown'); assert.equal(buttons[0].tabIndex, 0);
    key('ArrowDown'); assert.equal(buttons[1].tabIndex, 0);
    key('Home'); assert.equal(buttons[0].tabIndex, 0);
    key('End'); assert.equal(buttons.at(-1).tabIndex, 0);
    key('n'); assert.equal(json(context, 'activeTool'), 'select');
    key('Delete'); assert.equal(menu.hidden, false);
    key('Enter', { repeat: true }); assert.equal(menu.hidden, false);
    key('Enter'); assert.equal(menu.hidden, true); assert.equal(elements.get('#switcher-query').focusCount, 1);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Escape' });
    openMenu(elements); key('Escape'); assert.equal(menu.hidden, true); assert.ok(viewport.focusCount);
    openMenu(elements); key('Tab'); assert.equal(menu.hidden, true);
    openMenu(elements); key(' '); assert.equal(menu.hidden, true); assert.equal(elements.get('#launch-dialog').open, true);
});

test('menu clamps its displayed bounds without moving the launch point and closes on outside actions', async () => {
    const { elements, document, window, context } = await boot(createWorkspace());
    const menu = elements.get('#canvas-menu');
    menu.getBoundingClientRect = () => ({ width: 230, height: 280 });
    openMenu(elements, { clientX: 1098, clientY: 719 });
    assert.equal(menu.style.left, '870px'); assert.equal(menu.style.top, '440px');
    assert.deepEqual(json(context, 'canvasMenuPoint'), json(context, 'toWorld({ clientX: 1098, clientY: 719 })'));
    document.dispatch('pointerdown', { target: canvasTarget('#canvas-menu') });
    assert.equal(menu.hidden, false, 'menu clicks are not outside clicks');
    document.dispatch('scroll', { target: canvasTarget('#canvas-menu') });
    document.dispatch('wheel', { target: canvasTarget('#canvas-menu') });
    assert.equal(menu.hidden, false, 'a profile list taller than the window can still scroll');
    const dismissals = [
        () => document.dispatch('pointerdown'), () => document.dispatch('wheel'), () => document.dispatch('scroll'),
        () => window.dispatch('blur'), () => window.dispatch('resize'), () => vm.runInContext('zoom(1.1)', context)
    ];
    for (const dismiss of dismissals) { openMenu(elements); dismiss(); assert.equal(menu.hidden, true); }
    elements.get('#viewport').clientWidth = 150; elements.get('#viewport').clientHeight = 100;
    openMenu(elements); assert.equal(menu.style.left, '0px'); assert.equal(menu.style.top, '0px');
});

test('restored AI sessions offer Resume and a fresh shell without launching anything', async () => {
    const workspace = createWorkspace();
    const card = { ...createCard({ profile: 'claude' }), session: { provider: 'claude', sessionId: '12345678-1234-4321-9876-123456789abc', cwd: '/project' } };
    workspace.cards.push(card);
    const { context, calls } = await boot(workspace);
    assert.equal(vm.runInContext('[...sessions.values()][0].status', context), 'idle');
    assert.match(vm.runInContext('[...sessions.values()][0].element.querySelector(\'[data-action="start"]\').innerHTML', context), /Resume session/);
    assert.match(vm.runInContext('[...sessions.values()][0].element.querySelector(\'.placeholder-copy\').textContent', context), /Saved Claude Code session/);
    assert.deepEqual(calls.map(c => c.action), ['initialize']);
});

test('automatic titles refresh header, outline, minimap, and search while rejecting stale or malformed events', async () => {
    const workspace = createWorkspace();
    const card = createCard({ title: 'repo · Codex', titleMode: 'automatic' }); workspace.cards.push(card);
    const { context, onEvent, elements, calls } = await boot(workspace);
    const event = { type: 'title', id: card.id, title: 'Fix ไทย 🚀', titleMode: 'automatic', titleRevision: 1 };
    onEvent(event);
    assert.equal(json(context, 'workspace.cards[0].title'), event.title);
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).element.querySelector(".card-title").textContent', context), event.title);
    assert.equal(elements.get('#outline').children[0].children[1].textContent, event.title);
    assert.equal(elements.get('#minimap-cards').children[0].title, event.title);
    elements.get('#search').value = 'ไทย'; elements.get('#search').oninput();
    assert.equal(elements.get('#outline').children[0].children[1].textContent, event.title);
    for (const patch of [{ title: 'Old', titleRevision: 0 }, { title: 'bad\nname', titleRevision: 2 },
        { title: '🚀'.repeat(51), titleRevision: 2 }, { title: 'bidi\u202e', titleRevision: 2 }]) onEvent({ ...event, ...patch });
    assert.equal(json(context, 'workspace.cards[0].title'), event.title);
    assert.deepEqual(calls.map(call => call.action), ['initialize'], 'title events never execute commands');
});

test('renaming immediately takes manual precedence during pending generation and can return to automatic', async () => {
    const workspace = createWorkspace();
    const card = createCard({ title: 'repo · Codex', titleMode: 'automatic' }); workspace.cards.push(card);
    let finish, revision = 2;
    const respond = (action, payload) => action === 'rename-title' ? new Promise(resolve => {
        finish = () => resolve({ card: { title: payload.mode === 'manual' ? payload.title : 'repo · Codex', titleMode: payload.mode, titleRevision: revision++ } });
    }) : null;
    const { context, onEvent, elements } = await boot(workspace, { respond });
    vm.runInContext('sessions.get(workspace.cards[0].id).element.querySelector(".card-title").onclick()', context);
    assert.equal(elements.get('#title-dialog').open, true);
    assert.match(elements.get('#title-mode').textContent, /Automatic/);
    const saving = vm.runInContext('renameTerminal(workspace.cards[0], "manual", "My own title")', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(json(context, 'workspace.cards[0].titleMode'), 'manual');
    onEvent({ type: 'title', id: card.id, title: 'Late generation', titleMode: 'automatic', titleRevision: 1 });
    assert.equal(json(context, 'workspace.cards[0].title'), 'My own title');
    finish(); await saving;
    assert.equal(elements.get('#title-dialog').open, false);
    onEvent({ type: 'title', id: card.id, title: 'Another generation', titleMode: 'automatic', titleRevision: 3 });
    assert.equal(json(context, 'workspace.cards[0].title'), 'My own title');
    const automatic = vm.runInContext('renameTerminal(workspace.cards[0], "automatic")', context);
    await new Promise(resolve => setImmediate(resolve));
    onEvent({ type: 'title', id: card.id, title: 'New session task', titleMode: 'automatic', titleRevision: 4 });
    finish(); await automatic;
    assert.equal(json(context, 'workspace.cards[0].titleMode'), 'automatic');
    assert.equal(json(context, 'workspace.cards[0].title'), 'New session task');
});

test('legacy names remain manual, invalid edits fail, and pending renames cannot mutate a replacement workspace', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard({ title: 'Codex' }));
    const { context, onEvent } = await boot(workspace);
    onEvent({ type: 'title', id: workspace.cards[0].id, title: 'Should not apply', titleMode: 'automatic', titleRevision: 1 });
    assert.equal(json(context, 'workspace.cards[0].title'), 'Codex');
    for (const invalid of ['', 'a\nb', '🚀'.repeat(51)]) {
        context.invalid = invalid;
        await assert.rejects(vm.runInContext('renameTerminal(workspace.cards[0], "manual", invalid)', context), /without controls/);
    }
    vm.runInContext(`bridge.invoke = async action => action === 'rename-title'
        ? new Promise(resolve => { globalThis.finishRename = resolve; }) : ({ ok: true });`, context);
    const saving = vm.runInContext('renameTerminal(workspace.cards[0], "manual", "Pending")', context);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext('loadWorkspace({ version: 3, name: "Other", camera: { x: 0, y: 0, z: 1 }, cards: [], items: [] }); finishRename({ card: { title: "Late", titleMode: "manual", titleRevision: 2 } })', context);
    await saving;
    assert.deepEqual(json(context, 'workspace.cards'), []);
});

test('launch defaults are automatic, while typed names stay manual even when equal to the profile default', async () => {
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) } : null;
    const { elements, calls } = await boot(createWorkspace(), { respond, terminals: true });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    elements.get('#add-terminal').onclick();
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(calls.find(call => call.action === 'create-card').payload.titleMode, 'automatic');
    elements.get('#add-terminal').onclick();
    elements.get('#terminal-title').value = 'Terminal'; elements.get('#terminal-title').oninput();
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(calls.filter(call => call.action === 'create-card').at(-1).payload.titleMode, 'manual');
});

test('title events from an earlier workspace cannot rename a restored card with the same ID', async () => {
    const workspace = createWorkspace();
    const card = createCard({ title: 'Saved title', titleMode: 'automatic' }); workspace.cards.push(card);
    const { context, onEvent } = await boot(workspace);
    vm.runInContext('loadWorkspace(workspace, 20)', context);
    onEvent({ type: 'title', id: card.id, title: 'Other workspace', titleMode: 'automatic', titleRevision: 50, titleEpoch: 19 });
    assert.equal(json(context, 'workspace.cards[0].title'), 'Saved title');
    onEvent({ type: 'title', id: card.id, title: 'Current workspace', titleMode: 'automatic', titleRevision: 1, titleEpoch: 20 });
    assert.equal(json(context, 'workspace.cards[0].title'), 'Current workspace');
});

test('browser layout updates preserve terminal emulators, local camera, and desktop dimensions', async () => {
    const workspace = createWorkspace(), card = createCard(); workspace.cards.push(card);
    const { context, bridge, onEvent, calls } = await boot(workspace, { remote: true, terminals: true });
    const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
    const camera = json(context, 'workspace.camera');
    const board = structuredClone(workspace); board.name = 'Changed on desktop'; board.cards[0].x = 421;
    board.camera = { x: 999, y: 999, z: 2 };
    onEvent({ type: 'remote-workspace', workspace: board });
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context), terminal);
    assert.equal(json(context, 'workspace.cards[0].x'), 421);
    assert.deepEqual(json(context, 'workspace.camera'), camera);
    onEvent({ type: 'remote-terminals', terminals: [{ id: card.id, running: true, generation: 1, cols: 110, rows: 37 }] });
    assert.equal(terminal.cols, 110); assert.equal(terminal.rows, 37);
    vm.runInContext('fitTerminal(sessions.get(workspace.cards[0].id)); changed()', context);
    assert.equal(terminal.cols, 110);
    assert.deepEqual(calls.map(c => c.action), ['initialize']);
    const sent = []; bridge.input = (id, data) => sent.push([id, data]);
    terminal.dataHandler('automatic-query-response');
    assert.equal(sent.length, 0);
    vm.runInContext('sessions.get(workspace.cards[0].id).userInput = true', context);
    terminal.dataHandler('typed');
    assert.deepEqual(sent, [[card.id, 'typed']]);
    bridge.role = 'view'; terminal.dataHandler('blocked');
    assert.equal(sent.length, 1);
    board.canvases = [
        { id: 'desktop-original', name: 'Original', camera: board.camera, cardIds: [card.id], itemIds: [] },
        { id: 'desktop-new', name: 'New canvas', camera: board.camera, cardIds: [], itemIds: [] }
    ];
    board.activeCanvas = 'desktop-new';
    onEvent({ type: 'remote-workspace', workspace: board });
    assert.equal(json(context, 'activeCanvas.id'), 'desktop-original');
    assert.deepEqual(json(context, 'workspace.camera'), camera);
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context), terminal);
    assert.equal(json(context, 'workspaceSnapshot().cards.length'), 1);
});

test('browser snapshots reconcile every canvas while preserving local navigation and hidden terminals', async () => {
    const board = twoCanvases(), first = board.cards[0].id, hidden = board.cards[1].id;
    const { context, onEvent, calls } = await boot(board, { remote: true, terminals: true });
    context.first = first; context.hiddenId = hidden;
    vm.runInContext(`
        globalThis.originalTerminal = sessions.get(hiddenId).terminal;
        globalThis.originalCard = anyCard(hiddenId);
        workspace.camera = { x: 123, y: -456, z: .6 };
        setFocus(first); switchCanvas('canvas-1');
        workspace.camera = { x: 91, y: 82, z: .8 };
        globalThis.output = [];
        sessions.get(first).terminal.write = (data, done) => { output.push(data); done(); };
    `, context);
    const update = structuredClone(board);
    update.name = 'Desktop update'; update.terminalTheme = 'paper';
    update.activeCanvas = 'canvas-0'; update.canvases[1].name = 'Renamed on desktop';
    update.cards[1].x = 900; update.cards[1].fontSize = 19;
    update.items = [{ id: 'note', type: 'note', text: 'Background item', x: 10, y: 20, w: 100, h: 100 }];
    update.canvases[0].itemIds = ['note'];
    onEvent({ type: 'remote-workspace', workspace: update });
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.deepEqual(json(context, 'workspace.camera'), { x: 91, y: 82, z: .8 });
    assert.equal(json(context, 'sessions.get(hiddenId).terminal === originalTerminal && anyCard(hiddenId) === originalCard'), true);
    assert.equal(json(context, 'anyCard(hiddenId).x'), 900);
    assert.equal(json(context, 'sessions.get(hiddenId).terminal.options.fontSize'), 19);
    assert.equal(json(context, 'sessions.get(first).terminal.options.theme.background'), require('../src/terminal-themes.js').paper.background);
    assert.equal(json(context, 'itemViews.get("note").element.style.display'), 'none');
    onEvent({ type: 'remote-terminals', terminals: [first, hidden].map(id => ({ id, running: true, generation: 1, cols: 117, rows: 39 })) });
    onEvent({ type: 'data', id: first, data: 'background output' });
    assert.deepEqual(json(context, 'output'), ['background output']);
    assert.equal(json(context, 'sessions.get(first).status'), 'running');
    assert.equal(json(context, 'sessions.get(first).terminal.cols'), 117);
    vm.runInContext(`switchCanvas('canvas-0')`, context);
    assert.deepEqual(json(context, 'workspace.camera'), { x: 123, y: -456, z: .6 });
    assert.equal(json(context, 'focused'), first);
    assert.equal(json(context, 'sessions.get(first).element.hidden'), false);
    assert.equal(json(context, 'itemViews.get("note").element.style.display'), '');
    // Moving a card between canvases keeps its emulator and updates its owner.
    update.canvases[0].cardIds.push(hidden); update.canvases[1].cardIds = [];
    onEvent({ type: 'remote-workspace', workspace: update });
    assert.equal(json(context, 'sessions.get(hiddenId).canvas.id'), 'canvas-0');
    assert.equal(json(context, 'sessions.get(hiddenId).terminal === originalTerminal'), true);
    // Removing the browser's current canvas selects a surviving one and drops stale focus.
    update.canvases.shift(); update.cards = []; update.items = [];
    update.activeCanvas = 'canvas-1';
    onEvent({ type: 'remote-workspace', workspace: update });
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.equal(json(context, 'sessions.size'), 0);
    assert.equal(json(context, 'focused'), null);
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
});

test('browser viewers can switch canvases but cannot create, reorder, rename, or delete them', async () => {
    const { context, calls, elements } = await boot(twoCanvases(), { remote: true, role: 'view' });
    const before = json(context, 'workspaceSnapshot()');
    await vm.runInContext(`createCanvas(); reorderCanvas(1); renameCanvas(); deleteCanvas()`, context);
    assert.deepEqual(json(context, 'workspaceSnapshot()'), before);
    assert.equal(elements.get('#canvas-dialog').open, undefined);
    assert.equal(elements.get('#confirm-dialog').open, undefined);
    assert.equal(vm.runInContext(`switchCanvas('canvas-1')`, context), true);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
});

test('browser title events and desktop renames update hidden canvases while rejecting old workspace epochs', async () => {
    const board = twoCanvases(), id = board.cards[1].id;
    board.cards.forEach(card => { card.titleMode = 'automatic'; });
    const { context, onEvent, elements, calls } = await boot(board, { remote: true, role: 'view', terminals: true,
        respond: action => action === 'initialize' ? { workspace: structuredClone(board), profiles: PROFILES, home: '', platform: 'win32', titleEpoch: 7 } : null });
    const title = () => vm.runInContext(`anyCard('${id}').title`, context);
    const header = vm.runInContext(`sessions.get('${id}').element.querySelector('.card-title')`, context);
    onEvent({ type: 'title', id, title: 'Browser task', titleMode: 'automatic', titleRevision: 1, titleEpoch: 7 });
    assert.equal(title(), 'Browser task');
    assert.equal(header.textContent, 'Browser task');
    assert.equal(header.disabled, true);
    const update = structuredClone(board);
    Object.assign(update.cards[1], { title: 'Desktop manual title', titleMode: 'manual', titleRevision: 2 });
    onEvent({ type: 'remote-workspace', workspace: update, titleEpoch: 7 });
    assert.equal(header.textContent, 'Desktop manual title');
    onEvent({ type: 'title', id, title: 'Late automatic title', titleMode: 'automatic', titleRevision: 3, titleEpoch: 7 });
    assert.equal(title(), 'Desktop manual title');
    Object.assign(update.cards[1], { title: 'Restored task', titleMode: 'automatic', titleRevision: 0 });
    onEvent({ type: 'remote-workspace', workspace: update, titleEpoch: 8 });
    onEvent({ type: 'title', id, title: 'Old workspace', titleMode: 'automatic', titleRevision: 99, titleEpoch: 7 });
    assert.equal(title(), 'Restored task');
    onEvent({ type: 'title', id, title: 'Current workspace', titleMode: 'automatic', titleRevision: 1, titleEpoch: 8 });
    assert.equal(title(), 'Current workspace');
    await vm.runInContext(`openTitleDialog(anyCard('${id}')); renameTerminal(anyCard('${id}'), 'manual', 'Browser edit')`, context);
    assert.equal(elements.get('#title-dialog').open, false);
    assert.equal(title(), 'Current workspace');
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
    vm.runInContext(`switchCanvas('canvas-1')`, context);
    assert.equal(elements.get('#minimap-cards').children[0].title, 'Current workspace');
});

test('a rejected browser connection reports the error before the remote banner exists', async () => {
    const { onEvent, elements, context } = await boot(createWorkspace(), { remote: true, initialized: false });
    assert.doesNotThrow(() => onEvent({ type: 'remote-disconnected', message: 'Only one controller can connect.' }));
    assert.equal(elements.get('#toast').textContent, 'Only one controller can connect.');
    assert.equal(vm.runInContext('ready', context), false);
});

test('host metadata updates the renderer model and folder display without running commands', async () => {
    const workspace = createWorkspace(); const card = createCard(); workspace.cards.push(card);
    const { context, calls, onEvent } = await boot(workspace);
    const session = { provider: 'codex', sessionId: '12345678-1234-4321-9876-123456789abc', cwd: '/agent' };
    onEvent({ type: 'metadata', id: card.id, cwd: '/current', session });
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(workspace.cards[0].session)', context)), session);
    assert.equal(vm.runInContext('[...sessions.values()][0].element.querySelector(".card-directory span").textContent', context), '/current');
    assert.deepEqual(calls.map(c => c.action), ['initialize']);
});

test('metadata received during startup takes precedence over an older start response', async () => {
    const workspace = createWorkspace(); const card = createCard();
    const oldSession = { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/old' };
    const latestSession = { provider: 'claude', sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/latest' };
    workspace.cards.push({ ...card, cwd: '/old', session: oldSession });
    const { context, onEvent } = await boot(workspace);
    vm.runInContext(`
        sessions.get(workspace.cards[0].id).terminal = { reset() {}, focus() {}, cols: 80, rows: 24 };
        bridge.invoke = async action => action === 'start' ? new Promise(resolve => { globalThis.finishStart = resolve; }) : ({ ok: true });
    `, context);
    const starting = vm.runInContext('start(workspace.cards[0])', context);
    await new Promise(resolve => setImmediate(resolve));
    onEvent({ type: 'metadata', id: card.id, cwd: '/latest', session: latestSession });
    context.startResponse = { cwd: '/old', session: oldSession };
    vm.runInContext('finishStart(startResponse)', context);
    await starting;
    assert.equal(json(context, 'workspace.cards[0].cwd'), '/latest');
    assert.deepEqual(json(context, 'workspace.cards[0].session'), latestSession);
    assert.equal(vm.runInContext('[...sessions.values()][0].element.querySelector(".card-directory span").textContent', context), '/latest');
});

test('start responses still supply metadata when no newer event has arrived', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard());
    const { context } = await boot(workspace);
    vm.runInContext(`
        sessions.get(workspace.cards[0].id).terminal = { reset() {}, focus() {}, cols: 80, rows: 24 };
        bridge.invoke = async action => action === 'start' ? ({ cwd: '/home' }) : ({ ok: true });
    `, context);
    await vm.runInContext('start(workspace.cards[0])', context);
    assert.equal(json(context, 'workspace.cards[0].cwd'), '/home');
});

test('Resume and Start fresh send explicit start modes and shutdown sends the latest metadata', async () => {
    const workspace = createWorkspace(); const card = createCard();
    card.session = { provider: 'codex', sessionId: '12345678-1234-4321-9876-123456789abc', cwd: '/agent' };
    workspace.cards.push(card);
    const { context, calls, onEvent } = await boot(workspace);
    vm.runInContext('sessions.get(workspace.cards[0].id).terminal = { reset() {}, focus() {}, cols: 80, rows: 24 }', context);
    await vm.runInContext('start(workspace.cards[0])', context);
    assert.equal(calls.find(c => c.action === 'start').payload.mode, 'resume');
    vm.runInContext('sessions.get(workspace.cards[0].id).status = "idle"', context);
    await vm.runInContext('start(workspace.cards[0], "fresh")', context);
    assert.equal(calls.filter(c => c.action === 'start').at(-1).payload.mode, 'fresh');
    onEvent({ type: 'metadata', id: card.id, cwd: '/last', session: card.session });
    onEvent({ type: 'closing', running: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.find(c => c.action === 'close').payload.cards[0].cwd, '/last');
});
test('renderer initializes an empty workspace and enables the launch dialog', async () => {
    const { elements, calls } = await boot(createWorkspace());
    assert.equal(elements.get('#toast').hidden, true, elements.get('#toast').textContent);
    assert.equal(elements.get('#profile-list').childElementCount, PROFILES.length);
    assert.equal(elements.get('#empty-state').hidden, false);
    elements.get('#add-terminal').onclick();
    assert.equal(elements.get('#launch-dialog').open, true);
    assert.equal(elements.get('#profile').value, 'shell');
    assert.deepEqual(calls.map(c => c.action), ['initialize']);
    assert.equal(elements.get('#minimap').hidden, true);
    assert.equal(elements.get('#minimap-toggle').disabled, true);
});

test('canvas input before the workspace loads is ignored instead of throwing', async () => {
    const { elements } = await boot(createWorkspace(), { initialized: false });
    const viewport = elements.get('#viewport');
    viewport.dispatch('wheel', { ctrlKey: true, deltaY: -100 });
    viewport.dispatch('pointerdown', { target: viewport });
    viewport.dispatch('pointerdown', { target: viewport, shiftKey: true });
    elements.get('#workspace-theme').value = 'paper';
    elements.get('#workspace-theme').onchange();
    assert.equal(elements.get('#workspace-theme').value, 'current');
    assert.equal(viewport.captured.size, 0);
});

test('minimap tracks selection, zoom, card geometry, visibility, and focus mode', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard({ x: -1600, y: -700 }), createCard({ profile: 'codex', x: 1800 }));
    const { elements, context } = await boot(workspace);
    const nodes = elements.get('#minimap-cards');
    assert.equal(elements.get('#minimap').hidden, false);
    assert.equal(nodes.childElementCount, 2);
    const initialWidth = parseFloat(elements.get('#minimap-viewport').style.width);
    elements.get('#zoom-in').onclick();
    assert.ok(parseFloat(elements.get('#minimap-viewport').style.width) < initialWidth);
    elements.get('#outline').children[0].onclick();
    assert.match(nodes.children[0].className, /selected/);
    const initialCardWidth = parseFloat(nodes.children[0].style.width);
    vm.runInContext('workspace.cards[0].w = 1200; renderGeometry(workspace.cards[0]);', context);
    assert.ok(parseFloat(nodes.children[0].style.width) > initialCardWidth);
    elements.get('#focus-toggle').onclick();
    assert.equal(elements.get('#minimap').hidden, true);
    elements.get('#exit-focus').onclick();
    assert.equal(elements.get('#minimap').hidden, false);
    elements.get('#minimap-toggle').onclick();
    assert.equal(elements.get('#minimap').hidden, true);
    assert.equal(elements.get('#minimap-toggle').attributes.get('aria-pressed'), 'false');
    elements.get('#zoom-out').onclick();
    assert.equal(elements.get('#minimap').hidden, true);
    elements.get('#minimap-toggle').onclick();
    assert.equal(elements.get('#minimap').hidden, false);
    vm.runInContext('loadWorkspace({ version: 1, name: "Empty", cards: [], camera: { x: 0, y: 0, z: 1 } });', context);
    assert.equal(elements.get('#minimap').hidden, true);
});

test('minimap click, drag, cancellation, and keyboard pan preserve zoom and bounded camera coordinates', async () => {
    const workspace = createWorkspace(); workspace.camera.z = .75;
    workspace.cards.push(createCard({ x: -3000 }), createCard({ x: 3000 }));
    const { elements, context } = await boot(workspace);
    const map = elements.get('#minimap-map');
    const camera = () => JSON.parse(vm.runInContext('JSON.stringify(workspace.camera)', context));
    const before = camera();
    map.dispatch('pointerdown', { clientX: 170, clientY: 60 });
    assert.notEqual(camera().x, before.x);
    const clicked = camera();
    map.dispatch('pointermove', { clientX: 180, clientY: 60, pointerId: 2 });
    assert.deepEqual(camera(), clicked);
    map.dispatch('pointermove', { clientX: 180, clientY: 60 });
    assert.ok(camera().x < clicked.x);
    assert.equal(camera().z, .75);
    map.dispatch('pointercancel');
    assert.equal(map.listeners.get('pointermove').size, 0);
    assert.equal(map.captured.size, 0);
    const frame = elements.get('#minimap-viewport').style;
    const center = { clientX: parseFloat(frame.left) + parseFloat(frame.width) / 2, clientY: parseFloat(frame.top) + parseFloat(frame.height) / 2 };
    const current = camera();
    map.dispatch('pointerdown', center);
    assert.ok(Math.abs(camera().x - current.x) < 1e-8, 'grabbing the current viewport does not jump');
    map.dispatch('pointermove', { clientX: 1e8, clientY: -1e8 });
    assert.equal(camera().x, -100000);
    assert.equal(camera().y, 100000);
    map.dispatch('pointerup');
    map.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(camera().x, -100000 + 110);
    map.dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
    assert.equal(camera().y, 100000 - 360);
    assert.equal(camera().z, .75);
});
test('renderer restores terminal cards without executing commands and supports canvas zoom', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard({ profile: 'codex' }));
    const { elements, calls } = await boot(workspace);
    assert.equal(elements.get('#toast').hidden, true, elements.get('#toast').textContent);
    assert.equal(elements.get('#world').childElementCount, 1);
    assert.equal(elements.get('#empty-state').hidden, true);
    assert.equal(elements.get('#running-count').textContent, '0 running');
    assert.equal(calls.some(c => c.action === 'start'), false);
    elements.get('#zoom-in').onclick();
    assert.equal(elements.get('#zoom-reset').textContent, '115%');
    elements.get('#zoom-reset').onclick();
    assert.equal(elements.get('#zoom-reset').textContent, '100%');
});

test('selecting terminal cards raises them without moving their DOM nodes', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard(), createCard());
    const { elements, context } = await boot(workspace);
    const world = elements.get('#world');
    const cards = [...world.children];
    vm.runInContext(`for (const s of sessions.values()) {
        s.status = 'running'; s.focusCount = 0;
        s.terminal = { focus() { s.focusCount++; } };
    }`, context);
    for (const index of [0, 1, 0]) {
        cards[index].dispatch('pointerdown');
        assert.deepEqual(world.children, cards, 'selection must keep terminal nodes attached in place');
        assert.ok(Number(cards[index].style.zIndex) > Number(cards[1 - index].style.zIndex), 'selected card is on top');
        assert.equal(vm.runInContext('selected', context), workspace.cards[index].id);
    }
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).focusCount', context), 2);
    assert.equal(vm.runInContext('sessions.get(workspace.cards[1].id).focusCount', context), 1);
});

const json = (context, expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
const note = (id, x, y, extra = {}) => ({ id, type: 'note', x, y, w: 200, h: 200, text: '', ...extra });
test('board items restore beside terminals, connectors render as arrows, and the minimap includes them', async () => {
    const workspace = createWorkspace();
    workspace.items.push(
        note('note-1', 0, 0, { text: 'Hello\nboard' }),
        { id: 'ring', type: 'shape', shape: 'ellipse', x: 400, y: 0, w: 100, h: 100, text: '' },
        { id: 'frame', type: 'frame', x: -50, y: -50, w: 700, h: 400, title: 'Plan' },
        { id: 'wire', type: 'line', start: { id: 'note-1' }, end: { id: 'ring' }, arrow: true }
    );
    const { elements, context } = await boot(workspace);
    assert.equal(elements.get('#toast').hidden, true, elements.get('#toast').textContent);
    assert.equal(elements.get('#world').childElementCount, 3, 'rectangular items live in the world');
    assert.equal(elements.get('#line-layer').childElementCount, 1, 'lines live in the SVG layer');
    assert.equal(elements.get('#empty-state').hidden, true);
    assert.equal(elements.get('#minimap').hidden, false);
    assert.equal(elements.get('#minimap-cards').childElementCount, 3, 'lines are omitted from the minimap');
    const stroke = vm.runInContext('itemViews.get("wire").stroke', context);
    assert.match(stroke.attributes.get('d'), /^M200 /, 'the connector leaves the note at its right edge');
    const head = vm.runInContext('itemViews.get("wire").head', context);
    assert.match(head.attributes.get('d'), /Z$/, 'the arrowhead is a filled path beside the shaft');
    const end = json(context, 'linePoints(workspace.items[3]).end');
    assert.ok(head.attributes.get('transform').startsWith(`translate(${end.x} ${end.y}) rotate(`), 'the head follows the attached endpoint');
    assert.equal(vm.runInContext('itemViews.get("note-1").text.textContent', context), 'Hello\nboard');
    assert.ok(Number(vm.runInContext('itemViews.get("frame").element.style.zIndex', context)) < 0, 'frames stay behind other items');
});
test('arrowheads follow endpoint direction, remain finite at zero length, and disappear for plain lines', async () => {
    const workspace = createWorkspace();
    workspace.items.push({ id: 'arrow', type: 'line', start: { x: 100, y: 100 }, end: { x: 200, y: 100 }, arrow: true });
    const { context } = await boot(workspace);
    const head = vm.runInContext('itemViews.get("arrow").head', context);
    for (const [x, y, angle] of [[200, 100, 0], [100, 200, 90], [0, 100, 180], [100, 0, -90], [200, 200, 45], [100, 100, 0]]) {
        vm.runInContext(`workspace.items[0].end = { x: ${x}, y: ${y} }; renderLines()`, context);
        assert.equal(head.attributes.get('transform'), `translate(${x} ${y}) rotate(${angle})`);
        assert.match(head.attributes.get('d'), /Z$/);
    }
    vm.runInContext('workspace.items[0].arrow = false; renderLines()', context);
    assert.equal(head.attributes.get('d'), '', 'plain lines have no arrowhead');
    assert.equal(head.style.display, 'none', 'the no-arrow state is explicitly hidden');
    const lastTransform = head.attributes.get('transform');
    vm.runInContext('workspace.items[0].end = { x: 300, y: 400 }; renderLines()', context);
    assert.equal(head.attributes.get('transform'), lastTransform, 'plain lines skip arrow rotation work');
    vm.runInContext('workspace.items[0].arrow = true; renderLines()', context);
    assert.match(head.attributes.get('d'), /Z$/, 'restoring the arrow redraws its head');
    assert.equal(head.style.display, '');
});
test('creation tools draw a sticky note, edit it in place, and return to the select tool', async () => {
    const { elements, context } = await boot(createWorkspace());
    const viewport = elements.get('#viewport');
    vm.runInContext('setTool("note")', context);
    viewport.dispatch('pointerdown', { clientX: 300, clientY: 200 });
    viewport.dispatch('pointerup', { clientX: 300, clientY: 200 });
    const [item] = json(context, 'workspace.items');
    assert.deepEqual({ type: item.type, x: item.x, y: item.y, w: item.w, h: item.h }, { type: 'note', x: 152, y: 52, w: 200, h: 200 });
    assert.equal(vm.runInContext('activeTool', context), 'select');
    assert.equal(vm.runInContext('editing', context), item.id);
    const editor = vm.runInContext('itemViews.get(workspace.items[0].id).editor', context);
    editor.value = 'Ship\r\nit\x07';
    editor.blur();
    assert.equal(json(context, 'workspace.items[0].text'), 'Ship\nit');
    assert.equal(vm.runInContext('editing', context), null);
    vm.runInContext('setTool("rect")', context);
    viewport.dispatch('pointerdown', { clientX: 100, clientY: 100 });
    viewport.dispatch('pointermove', { clientX: 400, clientY: 300 });
    viewport.dispatch('pointerup', { clientX: 400, clientY: 300 });
    const shape = json(context, 'workspace.items[1]');
    assert.deepEqual({ type: shape.type, shape: shape.shape, x: shape.x, y: shape.y, w: shape.w, h: shape.h }, { type: 'shape', shape: 'rect', x: 52, y: 52, w: 300, h: 200 });
    assert.equal(vm.runInContext('editing', context), null, 'shapes are not edited on creation');
});
test('empty text labels are discarded after editing', async () => {
    const { elements, context } = await boot(createWorkspace());
    vm.runInContext('setTool("text")', context);
    elements.get('#viewport').dispatch('pointerdown', { clientX: 300, clientY: 200 });
    elements.get('#viewport').dispatch('pointerup', { clientX: 300, clientY: 200 });
    assert.equal(json(context, 'workspace.items.length'), 1);
    vm.runInContext('itemViews.get(workspace.items[0].id).editor', context).blur();
    assert.equal(json(context, 'workspace.items.length'), 0);
    assert.equal(json(context, 'itemViews.size'), 0);
});
test('a line drawn between two items attaches to both and follows them', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(note('a', 0, 0), note('b', 600, 0));
    const { elements, context } = await boot(workspace);
    const viewport = elements.get('#viewport');
    vm.runInContext('setTool("arrow")', context);
    viewport.dispatch('pointerdown', { clientX: 100, clientY: 100 });
    viewport.dispatch('pointermove', { clientX: 700, clientY: 100 });
    viewport.dispatch('pointerup', { clientX: 700, clientY: 100 });
    const line = json(context, 'workspace.items[2]');
    assert.deepEqual({ start: line.start, end: line.end, arrow: line.arrow }, { start: { id: 'a' }, end: { id: 'b' }, arrow: true });
    const element = vm.runInContext('itemViews.get("b").element', context);
    element.dispatch('pointerdown', { clientX: 700, clientY: 100 });
    element.dispatch('pointermove', { clientX: 700, clientY: 400 });
    element.dispatch('pointerup', { clientX: 700, clientY: 400 });
    assert.equal(json(context, 'workspace.items[1].y'), 300);
    assert.match(vm.runInContext(`itemViews.get("${line.id}").stroke.attributes.get('d')`, context), /^M\d/);
    assert.notEqual(vm.runInContext(`itemViews.get("${line.id}").stroke.attributes.get('d')`, context), 'M200 100L600 100', 'the connector redraws after the move');
});
test('grouped items select and move together until ungrouped', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 300, 0), note('c', 600, 0));
    const { context } = await boot(workspace);
    vm.runInContext('select("a"); select("b", { additive: true }); groupSelection(); setSelection([]); select("a")', context);
    assert.deepEqual(json(context, '[...selection].sort()'), ['a', 'b']);
    assert.deepEqual(json(context, 'workspace.items[0].groups'), json(context, 'workspace.items[1].groups'));
    const element = vm.runInContext('itemViews.get("a").element', context);
    element.dispatch('pointerdown', { clientX: 10, clientY: 10 });
    element.dispatch('pointermove', { clientX: 110, clientY: 60 });
    element.dispatch('pointerup', { clientX: 110, clientY: 60 });
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.x, i.y])'), [[100, 50], [400, 50], [600, 0]]);
    vm.runInContext('ungroupSelection(); select("a")', context);
    assert.deepEqual(json(context, '[...selection]'), ['a']);
    assert.equal(json(context, 'workspace.items.some(i => i.groups)'), false);
});
test('grouping groups nests them, and ungrouping unwraps one level at a time', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 300, 0), note('c', 600, 0), note('d', 900, 0));
    const { elements, context } = await boot(workspace);
    vm.runInContext('select("a"); select("b", { additive: true }); groupSelection()', context);
    const inner = json(context, 'workspace.items[0].groups[0]');
    vm.runInContext('select("a"); groupSelection()', context);
    assert.match(elements.get('#toast').textContent, /two or more items or groups/, 'one group alone is not grouped again');
    vm.runInContext('select("c", { additive: true }); groupSelection(); setSelection([]); select("b")', context);
    assert.deepEqual(json(context, '[...selection].sort()'), ['a', 'b', 'c'], 'a nested member selects the whole outer group');
    const outer = json(context, 'workspace.items[2].groups[0]');
    assert.deepEqual(json(context, 'workspace.items.map(i => i.groups)'), [[outer, inner], [outer, inner], [outer], null]);
    vm.runInContext('ungroupSelection(); setSelection([]); select("a")', context);
    assert.deepEqual(json(context, '[...selection].sort()'), ['a', 'b'], 'the inner group remains after one ungroup');
    assert.deepEqual(json(context, 'workspace.items.map(i => i.groups)'), [[inner], [inner], null, null]);
    vm.runInContext('select("b"); deleteSelection()', context);
    assert.equal(json(context, 'workspace.items.some(i => i.groups)'), false, 'a group left with one member is removed');
});
test('clicking a grouped terminal still focuses it for typing, while Shift additions do not', async () => {
    const workspace = createWorkspace();
    const card = { ...createCard(), groups: ['pair'] };
    workspace.cards.push(card);
    workspace.items.push(note('a', 900, 0, { groups: ['pair'] }), note('b', 1300, 0));
    const { elements, context } = await boot(workspace);
    vm.runInContext('for (const s of sessions.values()) { s.status = "running"; s.focusCount = 0; s.terminal = { focus() { s.focusCount++; } }; }', context);
    const cardElement = elements.get('#world').children[0];
    cardElement.dispatch('pointerdown');
    assert.deepEqual(json(context, '[...selection].sort()'), [card.id, 'a'].sort());
    assert.equal(vm.runInContext('[...sessions.values()][0].focusCount', context), 1);
    vm.runInContext('select("b")', context);
    cardElement.dispatch('pointerdown', { shiftKey: true });
    assert.deepEqual(json(context, '[...selection].sort()'), [card.id, 'a', 'b'].sort());
    assert.equal(vm.runInContext('[...sessions.values()][0].focusCount', context), 1);
});
test('moving a frame carries enclosed items and free lines but not items outside it', async () => {
    const workspace = createWorkspace();
    workspace.items.push(
        { id: 'frame', type: 'frame', x: 0, y: 0, w: 700, h: 400, title: 'Frame' },
        note('inside', 50, 50), note('outside', 900, 0),
        { id: 'free', type: 'line', start: { x: 100, y: 300 }, end: { x: 200, y: 300 } },
        { id: 'wire', type: 'line', start: { id: 'inside' }, end: { id: 'outside' } }
    );
    const { context } = await boot(workspace);
    const title = vm.runInContext('itemViews.get("frame").title', context);
    title.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    title.dispatch('pointermove', { clientX: 10, clientY: 20 });
    title.dispatch('pointerup', { clientX: 10, clientY: 20 });
    const items = Object.fromEntries(json(context, 'workspace.items').map(i => [i.id, i]));
    assert.deepEqual([items.frame.x, items.frame.y, items.inside.x, items.inside.y], [10, 20, 60, 70]);
    assert.deepEqual([items.outside.x, items.outside.y], [900, 0]);
    assert.deepEqual([items.free.start, items.free.end], [{ x: 110, y: 320 }, { x: 210, y: 320 }]);
    assert.deepEqual(items.wire.start, { id: 'inside' }, 'attached ends stay attached');
});
test('deleting items keeps connectors as free lines and never deletes terminals from the keyboard', async () => {
    const workspace = createWorkspace();
    const card = createCard({ x: 0, y: 600 });
    workspace.cards.push(card);
    workspace.items.push(note('a', 0, 0), note('b', 600, 0), { id: 'wire', type: 'line', start: { id: 'a' }, end: { id: card.id } });
    const { elements, context } = await boot(workspace);
    vm.runInContext('select("a"); deleteSelection()', context);
    const wire = json(context, 'workspace.items.find(i => i.id === "wire")');
    assert.equal(typeof wire.start.x, 'number');
    assert.equal(wire.start.id, undefined);
    assert.deepEqual(wire.end, { id: card.id });
    assert.equal(json(context, 'workspace.items.some(i => i.id === "a")'), false);
    vm.runInContext(`select(${JSON.stringify(card.id)}); deleteSelection()`, context);
    assert.equal(json(context, 'workspace.cards.length'), 1);
    assert.match(elements.get('#toast').textContent, /close button/);
});
test('shift-dragging empty canvas selects enclosed items; clicking empty canvas clears the selection', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(note('a', 10, 10), note('b', 300, 10), note('far', 2000, 2000));
    const { elements, context } = await boot(workspace);
    const viewport = elements.get('#viewport');
    viewport.dispatch('pointerdown', { shiftKey: true, clientX: 0, clientY: 0 });
    viewport.dispatch('pointermove', { clientX: 600, clientY: 600 });
    viewport.dispatch('pointerup', { clientX: 600, clientY: 600 });
    assert.deepEqual(json(context, '[...selection].sort()'), ['a', 'b']);
    assert.equal(json(context, 'workspace.camera.x'), 0, 'selecting an area does not pan');
    viewport.dispatch('pointerdown', { clientX: 900, clientY: 900 });
    viewport.dispatch('pointerup', { clientX: 900, clientY: 900 });
    assert.deepEqual(json(context, '[...selection]'), []);
});
test('the style toolbar colors selected items and sizes only items that hold text', async () => {
    const workspace = createWorkspace();
    const card = createCard({ x: 0, y: 900 });
    workspace.cards.push(card);
    workspace.items.push(
        note('a', 0, 0), { id: 'box', type: 'shape', shape: 'rect', x: 300, y: 0, w: 180, h: 110, text: 'Hi' },
        { id: 'frame', type: 'frame', x: -50, y: -50, w: 900, h: 500, title: 'Plan' },
        { id: 'pic', type: 'image', x: 0, y: 400, w: 100, h: 100, asset: `${'a'.repeat(64)}.png` },
        { id: 'wire', type: 'line', start: { id: 'a' }, end: { id: 'box' } }
    );
    const { elements, context } = await boot(workspace);
    const bar = elements.get('#style-toolbar'), sizes = elements.get('#style-sizes');
    assert.equal(bar.hidden, true, 'nothing selected');
    vm.runInContext(`select(${JSON.stringify(card.id)}); select("pic", { additive: true })`, context);
    assert.equal(bar.hidden, false, 'terminals take a color even alongside images');
    assert.equal(sizes.hidden, true, 'terminal text size still uses its own controls');
    vm.runInContext('select("pic")', context);
    assert.equal(bar.hidden, true, 'images have no style');
    vm.runInContext('select("frame"); select("wire", { additive: true })', context);
    assert.deepEqual([bar.hidden, sizes.hidden], [false, true], 'frames and lines take a color but no text size');
    vm.runInContext('select("a"); select("box", { additive: true }); select("wire", { additive: true }); select("pic", { additive: true })', context);
    assert.deepEqual([bar.hidden, sizes.hidden], [false, false]);
    vm.runInContext('setItemColor("blue"); setItemFontSize("huge")', context);
    const style = () => json(context, 'workspace.items.map(i => [i.id, i.color ?? null, i.fontSize ?? null])');
    assert.deepEqual(style(), [['a', 'blue', 'huge'], ['box', 'blue', 'huge'], ['frame', null, null], ['pic', null, null], ['wire', 'blue', null]]);
    vm.runInContext('setItemColor("magenta"); setItemFontSize("12px")', context);
    assert.deepEqual(style()[0], ['a', 'blue', 'huge'], 'values outside the palettes are ignored');
    vm.runInContext('setItemColor("default"); setItemFontSize("medium")', context);
    assert.deepEqual(style(), [['a', null, null], ['box', null, null], ['frame', null, null], ['pic', null, null], ['wire', null, null]], 'defaults are stored as absent fields');
    vm.runInContext(`setFocus(${JSON.stringify(card.id)})`, context);
    assert.equal(bar.hidden, true, 'focus mode hides the style toolbar');
});

test('terminal card colors share the item palette, clear to absent, and undo across mixed selections', async () => {
    const board = createWorkspace(); board.cards.push(createCard()); board.items.push(note('a', 700, 0));
    const { context, elements } = await boot(board, { terminals: true });
    vm.runInContext('select(workspace.cards[0].id); select("a", { additive: true }); setItemColor("purple")', context);
    assert.deepEqual(json(context, '[workspace.cards[0].color, workspace.items[0].color]'), ['purple', 'purple']);
    const session = vm.runInContext('sessions.get(workspace.cards[0].id)', context);
    assert.ok(session.element.classList.contains('color-purple'));
    assert.ok(elements.get('#outline').children[0].classList.contains('color-purple'));
    assert.ok(elements.get('#minimap-cards').children[0].classList.contains('color-purple'));
    vm.runInContext('setItemColor("purple"); setItemColor("invalid")', context);
    assert.equal(json(context, 'boardHistory.undo.length'), 1, 'repeated and invalid colors add no step');
    vm.runInContext('setItemColor("default")', context);
    assert.equal(json(context, '"color" in workspace.cards[0]'), false);
    assert.equal(session.element.classList.contains('colored'), false);
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, '[workspace.cards[0].color, workspace.items[0].color]'), ['purple', 'purple']);
    vm.runInContext('undo()', context);
    assert.equal(json(context, '"color" in workspace.cards[0]'), false);
    vm.runInContext('redo(); redo()', context);
    assert.equal(json(context, '"color" in workspace.cards[0]'), false);
    assert.equal(session, vm.runInContext('sessions.get(workspace.cards[0].id)', context));
});

test('workspace themes and per-terminal overrides apply live and undo without resetting terminals', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard({ theme: 'current' }));
    const { context, elements, calls } = await boot(board, { terminals: true });
    const sessions = Array.from(vm.runInContext('[...sessions.values()]', context)), terminals = sessions.map(s => s.terminal);
    for (const s of sessions) {
        s.status = 'running';
        s.terminal.scrollback = ['kept output']; s.terminal.selection = 'selected output';
        s.terminal.reset = s.terminal.dispose = () => assert.fail('theme changes must preserve the terminal');
    }
    const backgrounds = () => sessions.map(s => s.terminal.options.theme.background);
    const themes = require('../src/terminal-themes.js');
    const current = themes.current.background, midnight = themes.midnight.background, paper = themes.paper.background;
    assert.deepEqual(backgrounds(), [current, current]);
    elements.get('#workspace-theme').value = 'midnight'; elements.get('#workspace-theme').onchange();
    assert.deepEqual(backgrounds(), [midnight, current], 'an explicit Current overrides the workspace default');
    vm.runInContext('select(workspace.cards[1].id); setTerminalTheme("paper")', context);
    assert.deepEqual(backgrounds(), [midnight, paper]);
    vm.runInContext('setTerminalTheme("paper"); setTerminalTheme("invalid")', context);
    assert.equal(json(context, 'boardHistory.undo.length'), 2);
    elements.get('#terminal-theme').value = ''; elements.get('#terminal-theme').onchange();
    assert.equal(json(context, '"theme" in workspace.cards[1]'), false);
    assert.deepEqual(backgrounds(), [midnight, midnight]);
    vm.runInContext('undo(); undo(); undo()', context);
    assert.deepEqual(backgrounds(), [current, current]);
    assert.equal(json(context, '"terminalTheme" in workspace'), false);
    assert.equal(elements.get('#workspace-theme').value, 'current');
    vm.runInContext('redo(); redo(); redo(); setTerminalTheme("current", true)', context);
    assert.deepEqual(backgrounds(), [current, current]);
    assert.equal(json(context, '"terminalTheme" in workspace'), false);
    vm.runInContext('undo()', context);
    assert.deepEqual(backgrounds(), [midnight, midnight]);
    for (let i = 0; i < terminals.length; i++) {
        assert.equal(sessions[i].terminal, terminals[i]);
        assert.deepEqual(terminals[i].scrollback, ['kept output']);
        assert.equal(terminals[i].selection, 'selected output');
        assert.equal(sessions[i].status, 'running');
    }
    assert.deepEqual(calls.map(call => call.action), ['initialize'], 'no PTY commands are sent');
    assert.equal(json(context, 'JSON.parse(JSON.stringify(workspace)).terminalTheme'), 'midnight');
});

test('mixed terminal themes, grouped selection, and global history keep new terminals and closed terminals safe', async () => {
    const board = createWorkspace();
    board.cards.push(createCard({ theme: 'paper', groups: ['g'] }), createCard({ groups: ['g'] }));
    const { context, elements } = await boot(board, { terminals: true });
    vm.runInContext('select(workspace.cards[0].id)', context);
    assert.equal(elements.get('#terminal-theme').value, 'mixed');
    vm.runInContext('setTerminalTheme("midnight")', context);
    assert.equal(elements.get('#terminal-theme').value, 'midnight');
    vm.runInContext('setTerminalTheme("paper", true); removeCard(workspace.cards[0]); undo(); undo()', context);
    assert.equal(json(context, 'workspace.cards.length'), 1, 'undo never recreates the closed card');
    assert.equal(json(context, '"theme" in workspace.cards[0]'), false);
    assert.equal(json(context, '"terminalTheme" in workspace'), false);
});

test('saved coloring loads before mounting, new cards inherit, and older workspaces reset the theme controls', async () => {
    const saved = require('./golden/terminal-styles.json');
    const { context, elements, calls } = await boot(saved, { terminals: true });
    assert.equal(elements.get('#workspace-theme').value, 'midnight');
    assert.deepEqual(json(context, '[...sessions.values()].map(s => s.terminal.options.theme.background)'), ['#faf7f0', '#15191f', '#101827']);
    await vm.runInContext('save()', context);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.action === 'save').payload)), saved);
    for (const version of [1, 2, 3]) {
        context.older = { ...createWorkspace(), version, cards: [createCard()] };
        vm.runInContext('loadWorkspace(older)', context);
        assert.equal(elements.get('#workspace-theme').value, 'current');
        assert.equal(json(context, '[...sessions.values()][0].terminal.options.theme.background'), '#15191f');
        assert.equal(json(context, 'boardHistory.undo.length'), 0);
    }
    vm.runInContext('setTerminalTheme("paper", true); mount({ ...workspace.cards[0], id: "new-terminal" })', context);
    assert.equal(json(context, 'sessions.get("new-terminal").terminal.options.theme.background'), '#faf7f0');
    context.empty = createWorkspace();
    vm.runInContext('loadWorkspace(empty); setTerminalTheme("midnight", true); undo()', context);
    assert.equal(json(context, '"terminalTheme" in workspace'), false, 'an empty workspace default is undoable');
});

const drag = (element, from, to) => {
    element.dispatch('pointerdown', { clientX: from[0], clientY: from[1] });
    element.dispatch('pointermove', { clientX: to[0], clientY: to[1] });
    element.dispatch('pointerup', { clientX: to[0], clientY: to[1] });
};
test('undo and redo step through item creation, moves, styles, groups, and deletion', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(note('a', 0, 0, { text: 'A' }), note('b', 400, 0));
    const { elements, context } = await boot(workspace);
    const state = () => json(context, 'workspace.items.map(i => ({ id: i.id, x: i.x, y: i.y, color: i.color, groups: i.groups }))');
    const undoButton = elements.get('#undo'), redoButton = elements.get('#redo');
    assert.deepEqual([undoButton.disabled, redoButton.disabled], [true, true]);
    const initial = state();
    drag(vm.runInContext('itemViews.get("a").element', context), [10, 10], [110, 60]);
    vm.runInContext('select("a"); setItemColor("red"); select("b", { additive: true }); groupSelection(); setTool("rect")', context);
    elements.get('#viewport').dispatch('pointerdown', { clientX: 800, clientY: 400 });
    elements.get('#viewport').dispatch('pointerup', { clientX: 800, clientY: 400 });
    vm.runInContext('select("a"); deleteSelection()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id).length'), 1, 'the grouped pair was deleted, leaving the rectangle');
    assert.deepEqual([undoButton.disabled, redoButton.disabled], [false, true]);
    const steps = [], selections = [];
    for (let i = 0; i < 5; i++) { vm.runInContext('undo()', context); steps.push(state()); selections.push(json(context, '[...selection].sort()')); }
    assert.equal(steps[0].length, 3, 'undo delete restores the pair');
    assert.deepEqual(selections[0], ['a', 'b'], 'and the selection it had');
    assert.equal(steps[1].length, 2, 'undo create removes the rectangle');
    assert.equal(json(context, 'itemViews.size'), 2);
    assert.equal(steps[2][0].groups, undefined, 'undo group');
    assert.equal(steps[3][0].color, undefined, 'undo color');
    assert.deepEqual(steps[4], initial, 'undo move');
    assert.deepEqual([undoButton.disabled, redoButton.disabled], [true, false]);
    vm.runInContext('undo()', context);
    assert.deepEqual(state(), initial, 'undo with an empty history does nothing');
    vm.runInContext('redo(); redo()', context);
    assert.deepEqual(state()[0], { id: 'a', x: 100, y: 50, color: 'red' });
    vm.runInContext('select("b"); setItemColor("blue")', context);
    assert.equal(redoButton.disabled, true, 'a new change clears redo');
    vm.runInContext('redo()', context);
    assert.equal(state()[0].groups, undefined);
    vm.runInContext('loadWorkspace({ version: 3, name: "Other", camera: { x: 0, y: 0, z: 1 }, cards: [], items: [] })', context);
    assert.deepEqual([undoButton.disabled, redoButton.disabled], [true, true], 'opening a workspace clears history');
});
test('text edits are undoable, and a new item with its first text is one step', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0, { text: 'Before' }));
    const { elements, context } = await boot(workspace);
    vm.runInContext('startEditing("a")', context);
    vm.runInContext('itemViews.get("a").editor', context).value = 'After';
    vm.runInContext('itemViews.get("a").editor', context).blur();
    vm.runInContext('startEditing("a")', context);
    vm.runInContext('itemViews.get("a").editor', context).blur();
    assert.equal(json(context, 'boardHistory.undo.length'), 1, 'an unchanged edit records nothing');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items[0].text'), 'Before');
    assert.equal(vm.runInContext('itemViews.get("a").text.textContent', context), 'Before');
    vm.runInContext('redo(); setTool("note")', context);
    elements.get('#viewport').dispatch('pointerdown', { clientX: 600, clientY: 300 });
    elements.get('#viewport').dispatch('pointerup', { clientX: 600, clientY: 300 });
    const created = json(context, 'workspace.items[1].id');
    vm.runInContext(`itemViews.get("${created}").editor`, context).value = 'Fresh';
    vm.runInContext(`itemViews.get("${created}").editor`, context).blur();
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.text)'), ['After'], 'one undo removes the typed note');
    vm.runInContext('setTool("text")', context);
    elements.get('#viewport').dispatch('pointerdown', { clientX: 600, clientY: 300 });
    elements.get('#viewport').dispatch('pointerup', { clientX: 600, clientY: 300 });
    vm.runInContext('itemViews.get(workspace.items[1].id).editor', context).blur();
    assert.equal(json(context, 'workspace.items.length'), 1);
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.text)'), ['Before'], 'a discarded empty label leaves no history step');
});
test('undo restores terminal geometry but never recreates a closed terminal', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    const card = createCard({ x: 0, y: 0 });
    workspace.cards.push(card);
    workspace.items.push(note('a', 900, 0), { id: 'wire', type: 'line', start: { id: 'a' }, end: { id: card.id } });
    const { context } = await boot(workspace);
    const header = vm.runInContext(`sessions.get(${JSON.stringify(card.id)}).element.querySelector('.card-header')`, context);
    drag(header, [10, 10], [210, 110]);
    assert.deepEqual(json(context, '[workspace.cards[0].x, workspace.cards[0].y]'), [200, 100]);
    vm.runInContext('select("a"); recordHistory(); removeItems(["a"])', context);
    vm.runInContext('removeCard(workspace.cards[0])', context);
    assert.equal(json(context, 'workspace.cards.length'), 0);
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.cards.length'), 0, 'the closed terminal stays closed');
    const wire = json(context, 'workspace.items.find(i => i.id === "wire")');
    assert.deepEqual(wire.start, { id: 'a' }, 'the restored note is attached again');
    assert.deepEqual(Object.keys(wire.end).sort(), ['x', 'y'], 'the end at the closed terminal is free');
    assert.equal(wire.end.x, 200 + card.w, 'at the edge where the terminal was');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.cards.length'), 0);
});
test('closing a terminal removes every arrow attached to it, and undo does not bring them back', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    const parent = createCard({ x: 0, y: 0 });
    const child = createCard({ x: 900, y: 0 });
    workspace.cards.push(parent, child);
    workspace.items.push(
        note('a', 0, 900),
        { id: 'spawn', type: 'line', start: { id: parent.id }, end: { id: child.id }, arrow: true },
        { id: 'back', type: 'line', start: { id: child.id }, end: { id: 'a' }, arrow: true },
        { id: 'wire', type: 'line', start: { id: 'a' }, end: { id: child.id } },
        { id: 'other', type: 'line', start: { id: parent.id }, end: { id: 'a' }, arrow: true }
    );
    const { context } = await boot(workspace);
    vm.runInContext('select("a"); setItemColor("green")', context);
    vm.runInContext('setSelection(["spawn", "back"])', context);
    vm.runInContext(`removeCard(findCard(${JSON.stringify(child.id)}))`, context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id)'), ['a', 'wire', 'other'], 'both arrows on the closed terminal are gone');
    assert.deepEqual(json(context, '[...selection]'), [], 'removed arrows leave the selection');
    assert.equal(vm.runInContext('itemViews.has("spawn") || itemViews.has("back")', context), false, 'their views are disposed');
    assert.deepEqual(Object.keys(json(context, 'workspace.items[1].end')).sort(), ['x', 'y'], 'a plain line is detached, not removed');
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id)'), ['a', 'wire', 'other'], 'undo keeps them removed');
    assert.equal(json(context, 'workspace.items[0].color ?? null'), null, 'while still undoing the earlier step');
});
test('undo waits until a drag or text edit finishes', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 400, 0));
    const { context } = await boot(workspace);
    vm.runInContext('select("a"); setItemColor("green")', context);
    const element = vm.runInContext('itemViews.get("b").element', context);
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 50, clientY: 0 });
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items[0].color'), 'green', 'ignored during a drag');
    element.dispatch('pointerup', { clientX: 50, clientY: 0 });
    vm.runInContext('startEditing("a"); undo()', context);
    assert.equal(json(context, 'workspace.items[0].color'), 'green', 'ignored while editing text');
    vm.runInContext('itemViews.get("a").editor', context).blur();
    vm.runInContext('undo(); undo()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.x, i.color ?? null])'), [[0, null], [400, null]]);
});

test('copy and paste clone items with new IDs, keep internal connectors, and free external ones', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    const card = createCard({ x: 0, y: 600 });
    const lone = createCard({ x: 900, y: 600 });
    workspace.cards.push({ ...card, groups: ['mixed'] }, lone);
    workspace.items.push(
        note('a', 0, 0, { groups: ['pair'], color: 'green' }), note('b', 300, 0, { groups: ['pair'] }), note('far', 2000, 0, { groups: ['mixed'] }),
        { id: 'inner', type: 'line', start: { id: 'a' }, end: { id: 'b' }, groups: ['pair'] },
        { id: 'out', type: 'line', start: { id: 'b' }, end: { id: card.id }, groups: ['pair'] }
    );
    const { elements, context } = await boot(workspace);
    vm.runInContext(`select(${JSON.stringify(lone.id)})`, context);
    assert.equal(vm.runInContext('copySelection()', context), false);
    assert.match(elements.get('#toast').textContent, /Terminals cannot be copied/);
    vm.runInContext(`select(${JSON.stringify(card.id)}); duplicateSelection()`, context);
    const fromTerminalGroup = json(context, 'workspace.items.at(-1)');
    assert.deepEqual([fromTerminalGroup.x, fromTerminalGroup.groups], [2024, undefined], 'only the items of a terminal\'s group are copied');
    vm.runInContext('undo()', context);
    vm.runInContext('select("a"); copySelection()', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(json(context, 'boardClipboard.items.map(i => i.id)'), ['a', 'b', 'inner', 'out'], 'selecting one member copies the whole group');
    assert.equal(json(context, 'boardClipboard.marker'), '4 canvas items');
    assert.equal(vm.runInContext('pasteFromClipboard({ files: [], getData: () => "something else" })', context), false, 'other clipboard text wins');
    assert.equal(vm.runInContext('pasteFromClipboard({ files: [], getData: () => "4 canvas items\\r\\n" })', context), true);
    const pasted = json(context, 'workspace.items.slice(5)');
    assert.equal(pasted.length, 4);
    assert.equal(new Set(pasted.map(i => i.id)).size, 4);
    assert.ok(pasted.every(i => !['a', 'b', 'inner', 'out'].includes(i.id)), 'fresh IDs');
    const [a2, b2, inner2, out2] = pasted;
    assert.deepEqual([a2.x, a2.y, a2.color], [24, 24, 'green']);
    assert.deepEqual([inner2.start, inner2.end], [{ id: a2.id }, { id: b2.id }], 'connectors inside the copy attach to the copies');
    assert.equal(out2.start.id, b2.id);
    assert.deepEqual(Object.keys(out2.end).sort(), ['x', 'y'], 'a connector to an uncopied terminal gets a free end');
    assert.ok(pasted.every(i => i.groups?.length === 1 && i.groups[0] === a2.groups[0] && a2.groups[0] !== 'pair'), 'the group is cloned');
    assert.deepEqual(json(context, '[...selection].length'), 4, 'the paste is selected');
    vm.runInContext('pasteBoardItems()', context);
    assert.deepEqual(json(context, '[workspace.items[9].x, workspace.items[9].y]'), [48, 48], 'repeated pastes step further away');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items.length'), 9, 'a paste is one undo step');
});
test('duplicate, cut, frames, and pasting out of sight', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(
        { id: 'frame', type: 'frame', x: 0, y: 0, w: 600, h: 400, title: 'Plan' }, note('inside', 50, 50, { text: 'Inside' }),
        note('solo', 5000, 5000, { groups: ['lonely'] })
    );
    const { context } = await boot(workspace);
    vm.runInContext('select("frame"); duplicateSelection()', context);
    assert.deepEqual(json(context, 'workspace.items.slice(3).map(i => [i.type, i.x, i.y])'), [['frame', 24, 24], ['note', 74, 74]], 'a frame copies with its contents');
    vm.runInContext('undo()', context);
    vm.runInContext('select("frame"); copySelection({ cut: true })', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id).filter(id => ["frame", "inside"].includes(id))'), [], 'cut removes the copied items');
    assert.equal(json(context, 'boardClipboard.marker'), 'Plan\n\nInside');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items.filter(i => i.id === "frame" || i.id === "inside").length'), 2, 'cut is undoable');
    vm.runInContext('select("solo"); copySelection(); workspace.camera = { x: 0, y: 0, z: 1 }; pasteBoardItems()', context);
    const copy = json(context, 'workspace.items.at(-1)');
    assert.deepEqual([copy.x + copy.w / 2, copy.y + copy.h / 2], [550, 360], 'lands in the middle of the view');
    assert.equal(copy.groups, undefined, 'a one-member group is not kept');
    vm.runInContext('pasteBoardItems()', context);
    const next = json(context, 'workspace.items.at(-1)');
    assert.deepEqual([next.x - copy.x, next.y - copy.y], [24, 24], 'the next paste steps on instead of stacking');
});

test('image cleanup keeps images used by the workspace, history, and clipboard, and asks before deleting', async () => {
    const workspace = createWorkspace();
    const image = (id, letter) => ({ id, type: 'image', x: 0, y: 0, w: 100, h: 100, asset: `${letter.repeat(64)}.png` });
    workspace.items.push(image('kept', 'a'), image('deleted', 'b'), image('copied', 'c'));
    let unused = { count: 2, bytes: 3 * 1024 * 1024 };
    const { elements, calls, context } = await boot(workspace, { respond: action => {
        if (action === 'unused-images') return unused;
        if (action === 'delete-unused-images') return { deleted: 2, bytes: 3 * 1024 * 1024 };
    } });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    vm.runInContext('select("copied"); copySelection(); select("deleted"); deleteSelection(); select("copied"); recordHistory(); removeItems(["copied"]); clearHistory()', context);
    vm.runInContext('select("kept"); recordHistory(); removeItems(["kept"]); undo()', context);
    vm.runInContext('select("deleted")', context);
    elements.get('#clean-images').onclick();
    await settle();
    const request = calls.find(c => c.action === 'unused-images');
    assert.deepEqual([...request.payload.keep].sort(), [`${'a'.repeat(64)}.png`, `${'c'.repeat(64)}.png`], 'kept: on the board and in history; copied: on the clipboard');
    assert.equal(elements.get('#confirm-dialog').open, true);
    assert.equal(elements.get('#confirm-title').textContent, 'Delete 2 unused images?');
    assert.match(elements.get('#confirm-description').textContent, /3\.0 MB/);
    elements.get('#confirm-cancel').onclick();
    await settle();
    assert.equal(calls.some(c => c.action === 'delete-unused-images'), false, 'cancel deletes nothing');
    elements.get('#clean-images').onclick();
    await settle();
    elements.get('#confirm-ok').onclick();
    await settle();
    assert.equal(calls.filter(c => c.action === 'delete-unused-images').length, 1);
    assert.match(elements.get('#toast').textContent, /Deleted 2 unused images \(3\.0 MB\)/);
    unused = { count: 0, bytes: 0 };
    elements.get('#clean-images').onclick();
    await settle();
    assert.match(elements.get('#toast').textContent, /No unused images/);
    vm.runInContext('imageImports = 1', context);
    elements.get('#clean-images').onclick();
    await settle();
    assert.match(elements.get('#toast').textContent, /finish importing/);
    assert.equal(calls.filter(c => c.action === 'unused-images').length, 3, 'no request while an import is in progress');
});
test('layouts saved by the browser preview in format 2 load their single groups as group paths', async () => {
    const workspace = { ...createWorkspace(), version: 2 };
    workspace.items.push(note('a', 0, 0, { group: 'pair' }), note('b', 300, 0, { group: 'pair' }));
    const { context } = await boot(workspace);
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.groups, "group" in i])'), [[['pair'], false], [['pair'], false]]);
    vm.runInContext('select("a")', context);
    assert.deepEqual(json(context, '[...selection].sort()'), ['a', 'b']);
});

test('a drag records its undo step on the first movement, and a plain click records nothing', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 400, 0));
    const { context } = await boot(workspace);
    const history = () => json(context, '[boardHistory.undo.length, boardHistory.redo.length]');
    vm.runInContext('select("b"); setItemColor("blue"); undo()', context);
    assert.deepEqual(history(), [0, 1]);
    const element = vm.runInContext('itemViews.get("a").element', context);
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointerup', { clientX: 0, clientY: 0 });
    assert.deepEqual(history(), [0, 1], 'a click neither records a step nor clears redo');
    const jitter = vm.runInContext('itemViews.get("b").element', context);
    jitter.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    jitter.dispatch('pointermove', { clientX: 2, clientY: 0 });
    jitter.dispatch('pointerup', { clientX: 2, clientY: 0 });
    assert.deepEqual(history(), [0, 1], 'a jitter below the drag threshold keeps redo');
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 50, clientY: 0 });
    vm.runInContext('groupSelection(); deleteSelection(); setItemColor("red"); duplicateSelection(); copySelection({ cut: true })', context);
    vm.runInContext('select("a"); select("b", { additive: true })', context);
    assert.equal(json(context, 'activeDrags'), 1);
    vm.runInContext('groupSelection(); deleteSelection(); setItemColor("red"); duplicateSelection(); copySelection({ cut: true })', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.id, i.groups ?? null, i.color ?? null])'), [['a', null, null], ['b', null, null]], 'board commands wait for the drag');
    element.dispatch('pointerup', { clientX: 50, clientY: 0 });
    assert.deepEqual(history(), [1, 0]);
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items[0].x'), 0);
});
test('a drag still ends when its element is removed mid-drag, so undo keeps working', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 400, 0));
    const { context, window } = await boot(workspace);
    const element = vm.runInContext('itemViews.get("a").element', context);
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 50, clientY: 0 });
    vm.runInContext('removeItems(["a"])', context);
    window.dispatch('pointerup', { clientX: 50, clientY: 0 });
    assert.equal(json(context, 'activeDrags'), 0);
    element.dispatch('pointerup', { clientX: 50, clientY: 0 });
    assert.equal(json(context, 'activeDrags'), 0, 'a drag ends only once');
    const other = vm.runInContext('itemViews.get("b").element', context);
    other.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    other.dispatch('pointermove', { clientX: 30, clientY: 0 });
    other.dispatch('lostpointercapture', { clientX: 30, clientY: 0 });
    assert.equal(json(context, 'activeDrags'), 0, 'losing pointer capture ends a drag');
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.id, i.x])'), [['b', 400]], 'undo works after both drags');
});
test('discarding a new empty text label keeps the redo steps it would have cleared', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0));
    const { elements, context } = await boot(workspace);
    vm.runInContext('select("a"); setItemColor("blue"); undo(); setTool("text")', context);
    elements.get('#viewport').dispatch('pointerdown', { clientX: 600, clientY: 300 });
    elements.get('#viewport').dispatch('pointerup', { clientX: 600, clientY: 300 });
    vm.runInContext('itemViews.get(workspace.items[1].id).editor', context).blur();
    vm.runInContext('redo()', context);
    assert.equal(json(context, 'workspace.items[0].color'), 'blue');
});

test('repeating a color, text size, or Arrange that changes nothing adds no undo step', async () => {
    const workspace = createWorkspace();
    workspace.cards.push(createCard({ x: 30, y: 40 }), createCard({ x: 900, y: 40 }));
    workspace.items.push(note('a', 0, 0));
    const { elements, context } = await boot(workspace);
    const steps = () => json(context, 'boardHistory.undo.length');
    vm.runInContext('select("a"); setItemColor("blue"); setItemColor("blue"); setItemFontSize("large"); setItemFontSize("large"); setItemColor("default"); setItemColor("default")', context);
    assert.equal(steps(), 3);
    vm.runInContext('undo()', context);
    vm.runInContext('setItemColor("blue")', context);
    assert.equal(json(context, 'boardHistory.redo.length'), 1, 'a no-op keeps redo');
    elements.get('#arrange').onclick();
    elements.get('#arrange').onclick();
    assert.equal(steps(), 3, 'only the first Arrange moved anything');
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.cards.map(c => [c.x, c.y])'), [[30, 40], [900, 40]]);
});

test('Arrange follows terminal connectors, keeps sizes and attachments, and is one undo step', async () => {
    const board = createWorkspace();
    const [a, b, c, loose] = [{ x: 900, y: 700 }, { x: 40, y: 2000, w: 500, h: 300 }, { x: 1600, y: 50, w: 800, h: 600 }, { x: 300, y: 300 }]
        .map(options => createCard(options));
    board.cards.push(c, a, loose, b);
    board.items.push(
        { id: 'a-b', type: 'line', start: { id: a.id }, end: { id: b.id }, arrow: true },
        { id: 'a-c', type: 'line', start: { id: a.id }, end: { id: c.id }, arrow: true },
        // A plain line still sets the flow; one to a note, a free end, and other canvases' cards do not.
        { id: 'c-b', type: 'line', start: { id: c.id }, end: { id: b.id } },
        { id: 'to-note', type: 'line', start: { id: loose.id }, end: { id: 'pad' }, arrow: true },
        { id: 'free', type: 'line', start: { id: loose.id }, end: { x: 0, y: 0 }, arrow: true },
        { id: 'frame', type: 'frame', x: 0, y: 0, w: 4000, h: 4000, title: 'Frames stay behind' },
        note('pad', 0, 0)
    );
    const { elements, context } = await boot(board);
    const steps = () => json(context, 'boardHistory.undo.length');
    const before = json(context, 'workspace.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))');
    const camera = json(context, 'workspace.camera');
    elements.get('#arrange').onclick();
    assert.equal(steps(), 1);
    const after = new Map(json(context, 'workspace.cards').map(card => [card.id, card]));
    const at = card => [after.get(card.id).x, after.get(card.id).y];
    const gap = json(context, 'Geometry.ARRANGE_GAP'), top = 200 + gap.clear;
    // c is first in card order but has an incoming connector, so the flow starts at a.
    assert.deepEqual(at(a), [40, top], 'the note at the top-left corner pushes the cards below it; the frame does not');
    assert.deepEqual(at(c), [40 + 660 + gap.column, top], 'a -> c, found first in card order, continues the row');
    assert.deepEqual(at(b), [40 + 660 + gap.column + 800 + gap.column, top], 'b follows its longest path through c');
    assert.deepEqual(at(loose), [40, top + 600 + gap.section], 'the unconnected terminal goes below the flow');
    for (const card of before) assert.deepEqual([after.get(card.id).w, after.get(card.id).h], [card.w, card.h], 'sizes are kept');
    assert.deepEqual(json(context, 'workspace.items.filter(i => i.type === "line").map(l => [l.id, l.start.id, l.end.id])'),
        [['a-b', a.id, b.id], ['a-c', a.id, c.id], ['c-b', c.id, b.id], ['to-note', loose.id, 'pad'], ['free', loose.id, null]]);
    assert.deepEqual(json(context, '["pad", "frame"].map(id => findItem(id)).map(({ x, y, w, h }) => [x, y, w, h])'),
        [[0, 0, 200, 200], [0, 0, 4000, 4000]], 'other items stay put');
    assert.notDeepEqual(json(context, 'workspace.camera'), camera, 'Arrange still fits the canvas');
    const arranged = json(context, 'workspace.cards');
    elements.get('#arrange').onclick();
    assert.deepEqual(json(context, 'workspace.cards'), arranged, 'a second Arrange changes nothing');
    assert.equal(steps(), 1, 'and adds no undo step');
    vm.runInContext('undo()', context);
    assert.deepEqual(json(context, 'workspace.cards.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))'), before, 'one undo restores the old layout');
    vm.runInContext('redo()', context);
    assert.deepEqual(json(context, 'workspace.cards'), arranged);
});

test('deleting the other part of an outer group leaves only the inner group', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 300, 0), note('c', 600, 0));
    const { context } = await boot(workspace);
    vm.runInContext('select("a"); select("b", { additive: true }); groupSelection(); select("c", { additive: true }); groupSelection(); select("c")', context);
    const inner = json(context, 'workspace.items[0].groups[1]');
    vm.runInContext('recordHistory(); removeItems(["c"])', context);
    assert.deepEqual(json(context, 'workspace.items.map(i => i.groups)'), [[inner], [inner]], 'one ungroup is enough afterwards');
});

test('clipboard copies paste before the write lands, and a failed write drops the copy', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(note('a', 0, 0, { text: 'A' + '\u{1F600}'.repeat(6000) }));
    let fail = false;
    const { elements, context } = await boot(workspace, { respond: action => (action === 'clipboard-write' && fail ? { error: 'Clipboard busy.' } : null) });
    vm.runInContext('select("a"); copySelection()', context);
    const marker = json(context, 'boardClipboard.marker');
    assert.equal(marker.length, 9999, 'the summary is cut before a split surrogate pair');
    assert.equal(vm.runInContext('pasteFromClipboard({ files: [], getData: () => "older text" })', context), true, 'a paste before the write lands uses the items');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('pasteFromClipboard({ files: [], getData: () => "older text" })', context), false, 'after the write, other text wins');
    fail = true;
    vm.runInContext('select("a"); copySelection()', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(json(context, 'boardClipboard'), null);
    assert.match(elements.get('#toast').textContent, /Could not copy/);
    assert.equal(vm.runInContext('pasteFromClipboard({ files: [], getData: () => "anything" })', context), false, 'a failed copy never pastes stale items');
});
test('history drags move nothing below the click threshold, and a cancelled drag is put back', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), { id: 'wire', type: 'line', start: { id: 'a' }, end: { x: 600, y: 0 } });
    const { context } = await boot(workspace);
    vm.runInContext('workspace.camera.z = .35', context);
    const element = vm.runInContext('itemViews.get("a").element', context);
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 3, clientY: 0 });
    element.dispatch('pointerup', { clientX: 3, clientY: 0 });
    assert.equal(json(context, 'workspace.items[0].x'), 0, 'a jittery click moves nothing');
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 70, clientY: 0 });
    assert.equal(json(context, 'workspace.items[0].x'), 200);
    element.dispatch('pointercancel', { clientX: 70, clientY: 0 });
    assert.equal(json(context, 'workspace.items[0].x'), 0, 'a cancelled move is undone');
    assert.deepEqual(json(context, '[boardHistory.undo.length, activeDrags]'), [0, 0]);
    vm.runInContext('select("wire")', context);
    const handle = vm.runInContext('itemViews.get("wire").handles[1]', context);
    handle.dispatch('pointerdown', { clientX: 600, clientY: 0 });
    handle.dispatch('pointermove', { clientX: 700, clientY: 50 });
    handle.dispatch('pointercancel', { clientX: 700, clientY: 0 });
    assert.deepEqual(json(context, 'workspace.items[1].end'), { x: 600, y: 0 });
    assert.equal(json(context, 'boardHistory.undo.length'), 0, 'a cancelled endpoint drag leaves no step');
});
test('undoing a deletion restores stacking order, and images wait for drags and text edits', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 50, 50), note('c', 900, 0));
    const { context } = await boot(workspace);
    const z = id => Number(vm.runInContext(`itemViews.get("${id}").element.style.zIndex`, context));
    const before = [z('a'), z('b')];
    assert.ok(before[0] < before[1]);
    vm.runInContext('setSelection(["a"]); deleteSelection(); undo()', context);
    assert.deepEqual([z('a'), z('b')], before, 'the restored note stays under the other one');
    const element = vm.runInContext('itemViews.get("c").element', context);
    element.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    element.dispatch('pointermove', { clientX: 50, clientY: 0 });
    let placed = false;
    vm.runInContext('whenBoardIdle()', context).then(() => { placed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(placed, false, 'work waits while a drag is active');
    element.dispatch('pointerup', { clientX: 50, clientY: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(placed, true, 'and runs when it ends');
});
test('re-picking the current text size keeps a resized text label', async () => {
    const workspace = createWorkspace();
    workspace.items.push({ id: 't', type: 'text', x: 0, y: 0, w: 220, h: 200, text: 'Tall' });
    const { context } = await boot(workspace);
    vm.runInContext('select("t"); fitTextLabel = () => { throw new Error("refit"); }; setItemFontSize("medium")', context);
    assert.deepEqual(json(context, '[workspace.items[0].h, boardHistory.undo.length]'), [200, 0]);
});
test('history steps share the text of unchanged items', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0, { text: 'x'.repeat(5000) }), note('b', 300, 0));
    const { context } = await boot(workspace);
    vm.runInContext('select("b"); setItemColor("blue"); setItemColor("green")', context);
    assert.equal(vm.runInContext('boardHistory.undo[0].items[0] === boardHistory.undo[1].items[0]', context), true);
    assert.equal(vm.runInContext('boardHistory.undo[0].items[1] === boardHistory.undo[1].items[1]', context), false);
});

test('a cut waits for the clipboard, pastes back in place, and a failed cut removes nothing', async () => {
    const workspace = createWorkspace();
    workspace.camera = { x: 0, y: 0, z: 1 };
    workspace.items.push(note('a', 100, 100), note('b', 500, 100));
    let fail = false;
    const { elements, context } = await boot(workspace, { respond: action => (action === 'clipboard-write' && fail ? { error: 'Clipboard busy.' } : null) });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    vm.runInContext('select("a"); copySelection({ cut: true })', context);
    assert.equal(json(context, 'workspace.items.length'), 2, 'nothing is removed before the write lands');
    await settle();
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id)'), ['b']);
    vm.runInContext('pasteBoardItems()', context);
    assert.deepEqual(json(context, '[workspace.items[1].x, workspace.items[1].y]'), [100, 100], 'the first paste after a cut lands in place');
    fail = true;
    vm.runInContext('select("b"); copySelection({ cut: true })', context);
    await settle();
    assert.equal(json(context, 'workspace.items.some(i => i.id === "b")'), true);
    assert.match(elements.get('#toast').textContent, /nothing was cut/);
});
test('a drag whose release was lost ends at its last position when the next drag starts or the window blurs', async () => {
    const workspace = createWorkspace();
    workspace.items.push(note('a', 0, 0), note('b', 400, 0));
    const { context, window } = await boot(workspace);
    const a = vm.runInContext('itemViews.get("a").element', context), b = vm.runInContext('itemViews.get("b").element', context);
    a.dispatch('pointerdown', { clientX: 0, clientY: 0 });
    a.dispatch('pointermove', { clientX: 40, clientY: 0 });
    b.dispatch('pointerdown', { clientX: 400, clientY: 0, pointerId: 1 });
    assert.equal(json(context, 'activeDrags'), 1, 'the stale drag ended when the new one started');
    assert.equal(json(context, 'workspace.items[0].x'), 40, 'at its last position');
    window.dispatch('blur');
    assert.equal(json(context, 'activeDrags'), 0, 'losing window focus ends a drag');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items[0].x'), 0);
});
test('ending a text label edit with its original text keeps its original height', async () => {
    const workspace = createWorkspace();
    workspace.items.push({ id: 't', type: 'text', x: 0, y: 0, w: 220, h: 40, text: 'Short' });
    const { context } = await boot(workspace);
    vm.runInContext('startEditing("t"); workspace.items[0].h = 300; var redrawn = 0; const drawLines = renderLines; renderLines = () => { redrawn++; drawLines(); }', context);
    vm.runInContext('itemViews.get("t").editor', context).blur();
    assert.deepEqual(json(context, '[workspace.items[0].h, boardHistory.undo.length]'), [40, 0]);
    assert.equal(json(context, 'itemViews.get("t").element.style.height'), '40px');
    assert.equal(json(context, 'redrawn'), 1, 'connectors attached to the label follow its restored height');
});


function shortcut(terminal, key, values = {}) {
    const event = { type: 'keydown', key, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    return { event, allowTerminal: terminal.keyHandler(event) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const focus of [false, true]) {
    test(`terminal clipboard shortcuts copy selections and preserve interrupts in ${focus ? 'fullscreen Focus' : 'canvas'} view`, async () => {
        const workspace = createWorkspace(); workspace.cards.push(createCard());
        const clipboard = { text: 'keep me' };
        const { context, calls } = await boot(workspace, { terminals: true, clipboard });
        vm.runInContext(`sessions.get(workspace.cards[0].id).status = 'running'; ${focus ? 'setFocus(workspace.cards[0].id)' : ''}`, context);
        const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
        terminal.selection = 'selected\ntext';
        const copy = shortcut(terminal, 'c');
        // The browser and xterm must both yield; otherwise copy may also interrupt.
        assert.equal(copy.allowTerminal, false);
        assert.equal(copy.event.prevented, true);
        assert.equal(copy.event.stopped, true);
        terminal.selection = 'changed before IPC';
        await flush();
        assert.equal(clipboard.text, 'selected\ntext', 'capture selection before async work');
        for (const type of ['keypress', 'keyup']) shortcut(terminal, 'c', { type });
        await flush();
        assert.equal(calls.filter(c => c.action === 'clipboard-write').length, 1);
        terminal.selection = '';
        assert.equal(shortcut(terminal, 'c').allowTerminal, true, 'xterm must send Ctrl+C to the shell');
        assert.equal(shortcut(terminal, 'C', { shiftKey: true }).allowTerminal, false);
        await flush();
        assert.equal(clipboard.text, 'selected\ntext', 'copy without a selection leaves clipboard intact');
        for (const shiftKey of [false, true]) {
            for (const selection of ['', 'selected']) {
                terminal.selection = selection;
                clipboard.text = 'first\r\nsecond\nthird';
                const paste = shortcut(terminal, shiftKey ? 'V' : 'v', { shiftKey });
                assert.equal(paste.allowTerminal, false);
                assert.equal(paste.event.prevented, true, 'suppress native paste to avoid duplicates');
                for (const type of ['keypress', 'keyup']) shortcut(terminal, 'v', { shiftKey, type });
                await flush();
            }
        }
        assert.deepEqual(terminal.pasted, Array(4).fill('first\r\nsecond\nthird'), 'each gesture uses xterm.paste exactly once');
    });
}

test('terminal Command+C/V aliases work without taking over Alt/AltGr, IME, or workspace shortcuts', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard());
    const clipboard = { text: 'original' };
    const { context, calls } = await boot(workspace, { terminals: true, clipboard, platform: 'darwin' });
    vm.runInContext("sessions.get(workspace.cards[0].id).status = 'running'", context);
    const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
    terminal.selection = 'mac copy';
    assert.equal(shortcut(terminal, 'c', { ctrlKey: false, metaKey: true }).allowTerminal, false);
    await flush();
    assert.equal(clipboard.text, 'mac copy');
    terminal.selection = '';
    assert.equal(shortcut(terminal, 'c', { ctrlKey: false, metaKey: true }).allowTerminal, false);
    shortcut(terminal, 'v', { ctrlKey: false, metaKey: true });
    await flush();
    assert.deepEqual(terminal.pasted, ['mac copy']);
    for (const key of ['c', 'v']) {
        assert.equal(shortcut(terminal, key, { altKey: true }).allowTerminal, true);
        assert.equal(shortcut(terminal, key, { isComposing: true }).allowTerminal, true);
        assert.equal(shortcut(terminal, key, { ctrlKey: false }).allowTerminal, true);
    }
    for (const [key, shiftKey] of [['s', false], ['o', false], ['n', true], ['f', true]]) {
        const result = shortcut(terminal, key, { shiftKey });
        assert.equal(result.allowTerminal, false, 'workspace shortcuts still bubble out of xterm');
        assert.equal(result.event.stopped, false);
    }
    assert.equal(calls.filter(c => c.action === 'clipboard-write').length, 1);
});

// Cells grow with the text size, so a 600×400 terminal body fits fewer columns and rows.
class SizedFit {
    activate(terminal) { this.terminal = terminal; }
    proposeDimensions() {
        const size = this.terminal.options.fontSize;
        return { cols: Math.floor(600 / (size * .6)), rows: Math.floor(400 / (size * 1.3)) };
    }
}
const overCard = id => ({ closest: selector => selector === '.terminal-card' ? { dataset: { id } } : null });
// Boots terminals whose output is showing, like running or exited cards, and returns a wheel helper.
async function bootSizedTerminals(board, options = {}) {
    const booted = await boot(board, { terminals: true, FitAddon: { FitAddon: SizedFit }, ...options });
    booted.resizes = [];
    booted.bridge.resize = (...args) => booted.resizes.push(args);
    vm.runInContext(`for (const s of sessions.values()) {
        s.status = 'running'; s.placeholder.hidden = true; s.element.offsetWidth = 600; s.element.offsetHeight = 400;
    }`, booted.context);
    booted.wheel = values => {
        let prevented = false;
        booted.elements.get('#viewport').dispatch('wheel', { ctrlKey: true, metaKey: false, deltaY: -100, deltaMode: 0, preventDefault() { prevented = true; }, ...values });
        return prevented;
    };
    booted.size = id => json(booted.context, `[workspace.cards.find(c => c.id === ${JSON.stringify(id)}).fontSize ?? null, sessions.get(${JSON.stringify(id)}).terminal.options.fontSize]`);
    return booted;
}

// Model document/viewport capture -> native target -> viewport bubble, so a target that stops propagation
// (xterm and the minimap both can) cannot hide an incorrectly registered canvas gesture listener.
function canvasWheel({ elements, document }) {
    const viewport = elements.get('#viewport');
    let time = 0;
    return (values = {}) => {
        time = values.timeStamp ?? time + 16;
        let stopped = false;
        const event = { target: viewport, deltaX: 0, deltaY: -100, deltaMode: 0, clientX: 400, clientY: 300,
            ctrlKey: false, metaKey: false, timeStamp: time, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...values };
        document.dispatch('wheel', event);
        if (stopped) return event;
        const handlers = [...viewport.listeners.get('wheel')];
        for (const handler of handlers.filter(fn => viewport.listenerOptions.get(fn)?.capture)) {
            handler(event); if (stopped) return event;
        }
        if (event.target !== viewport) {
            for (const handler of event.target.listeners?.get('wheel') || []) {
                handler(event); if (stopped) return event;
            }
        }
        for (const handler of handlers.filter(fn => !viewport.listenerOptions.get(fn)?.capture)) {
            handler(event); if (stopped) break;
        }
        return event;
    };
}
test('wheel zoom updates only the active canvas and switching restores each camera', async () => {
    const board = twoCanvases(), h = await boot(board), wheel = canvasWheel(h);
    wheel();
    const firstCamera = json(h.context, 'workspace.camera');
    assert.ok(firstCamera.z > board.canvases[0].camera.z);
    vm.runInContext('switchCanvas("canvas-1")', h.context);
    assert.deepEqual(json(h.context, 'workspace.camera'), board.canvases[1].camera);
    wheel({ deltaY: 100, timeStamp: 300 });
    const secondCamera = json(h.context, 'workspace.camera');
    assert.ok(secondCamera.z < board.canvases[1].camera.z);
    vm.runInContext('switchCanvas("canvas-0")', h.context);
    assert.deepEqual(json(h.context, 'workspace.camera'), firstCamera);
    vm.runInContext('switchCanvas("canvas-1")', h.context);
    assert.deepEqual(json(h.context, 'workspace.camera'), secondCamera);
});

function wheelSurface(selector, root = new Element()) {
    const target = new Element();
    target.closest = selectors => selectors.split(',').some(value => value.trim() === selector) ? root : null;
    return target;
}

test('plain wheel dismisses the canvas menu before zoom while its profile list keeps native scrolling', async () => {
    const h = await boot(createWorkspace()), wheel = canvasWheel(h);
    const menu = h.elements.get('#canvas-menu');
    const before = json(h.context, 'workspace.camera');
    openMenu(h.elements);
    const profile = wheelSurface('button');
    const closest = profile.closest;
    profile.closest = selectors => selectors === '#canvas-menu' ? menu : closest(selectors);
    assert.equal(wheel({ target: profile }).defaultPrevented, false);
    assert.equal(menu.hidden, false, 'scrolling menu profiles leaves the menu open');
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
    wheel({ deltaY: -1, timeStamp: 300 });
    assert.equal(menu.hidden, true, 'document capture dismisses even below the zoom threshold');
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
    openMenu(h.elements);
    wheel({ timeStamp: 600 });
    assert.equal(menu.hidden, true);
    assert.equal(json(h.context, 'canvasMenuPoint'), null, 'zoom cannot leave a stale launch point');
    assert.ok(json(h.context, 'workspace.camera.z') > before.z);
});

test('plain wheel zooms empty canvas through the modifier path around the real pointer, with bounds', async () => {
    const plain = await boot(createWorkspace()), modified = await boot(createWorkspace());
    for (const h of [plain, modified]) {
        h.elements.get('#viewport').getBoundingClientRect = () => ({ left: 80, top: 60 });
        h.window.TerminalCanvasPointer.clientPoint = () => ({ x: 580, y: 360 });
    }
    const wheel = canvasWheel(plain), ctrlWheel = canvasWheel(modified);
    const before = json(plain.context, 'workspace.camera');
    assert.equal(wheel({ clientX: 900, clientY: 700 }).defaultPrevented, true);
    ctrlWheel({ ctrlKey: true, clientX: 900, clientY: 700 });
    const after = json(plain.context, 'workspace.camera');
    assert.deepEqual(after, json(modified.context, 'workspace.camera'));
    assert.ok(after.z > before.z);
    assert.ok(Math.abs((500 - before.x) / before.z - (500 - after.x) / after.z) < 1e-9);
    assert.ok(Math.abs((300 - before.y) / before.z - (300 - after.y) / after.z) < 1e-9);
    wheel({ deltaY: 100 });
    assert.ok(Math.abs(json(plain.context, 'workspace.camera.z') - before.z) < 1e-9, 'wheel down zooms out');
    wheel({ deltaY: -100000 });
    assert.equal(json(plain.context, 'workspace.camera.z'), 1.5);
    wheel({ deltaY: 100000 });
    assert.equal(json(plain.context, 'workspace.camera.z'), .35);
});

test('world and empty-state decorations count as empty canvas, but its launch button does not', async () => {
    const h = await boot(createWorkspace()), wheel = canvasWheel(h);
    for (const target of [h.elements.get('#world'), wheelSurface('.empty-state')]) {
        const before = json(h.context, 'workspace.camera.z');
        assert.equal(wheel({ target }).defaultPrevented, true);
        assert.ok(json(h.context, 'workspace.camera.z') > before);
    }
    const before = json(h.context, 'workspace.camera');
    assert.equal(wheel({ target: wheelSurface('button'), timeStamp: 300 }).defaultPrevented, false);
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
});

for (const surface of ['.terminal-card', '.canvas-item', '.canvas-line', '.minimap', '.canvas-toolbar', '.create-toolbar', '.style-toolbar', 'select', 'textarea', '[contenteditable="true"]', 'other scrollable UI']) {
    test(`plain wheel over ${surface} preserves native behavior without canvas zoom`, async () => {
        const h = await boot(createWorkspace()), wheel = canvasWheel(h), target = wheelSurface(surface);
        const before = json(h.context, 'workspace.camera');
        let nativeWheels = 0;
        target.addEventListener('wheel', event => { nativeWheels++; event.stopPropagation(); });
        assert.equal(wheel({ target }).defaultPrevented, false);
        assert.equal(nativeWheels, 1, 'the wheel reaches the native handler');
        assert.deepEqual(json(h.context, 'workspace.camera'), before);
    });
}

test('wheel zoom preserves live terminal appearance after the sidebar changes viewport geometry', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ color: 'purple' }));
    const h = await bootSizedTerminals(board); sidebarViewport(h);
    const { context, elements } = h;
    const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
    elements.get('#workspace-theme').value = 'paper'; elements.get('#workspace-theme').onchange();
    elements.get('#sidebar-toggle').click();
    const before = json(context, 'workspace.camera');
    const wheel = canvasWheel(h);
    wheel({ clientX: 900, clientY: 400 });
    const after = json(context, 'workspace.camera');
    assert.ok(after.z > before.z);
    assert.ok(Math.abs((900 - before.x) / before.z - (900 - after.x) / after.z) < 1e-9);
    assert.ok(Math.abs((400 - before.y) / before.z - (400 - after.y) / after.z) < 1e-9);
    assert.equal(vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context), terminal);
    assert.equal(terminal.options.theme.background, '#faf7f0');
    assert.equal(json(context, 'workspace.cards[0].color'), 'purple');
    assert.equal(json(context, 'boardHistory.undo.length'), 1, 'zoom and sidebar changes add no appearance history');
    assert.equal(wheel({ target: wheelSurface('select'), timeStamp: 300 }).defaultPrevented, false);
    assert.deepEqual(json(context, 'workspace.camera'), after, 'the theme selector keeps native scrolling');
});

test('canvas markup keeps theme and Settings controls alongside accessible wheel guidance', () => {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    assert.equal([...html.matchAll(/id="workspace-theme"/g)].length, 1);
    assert.match(html, /<label class="theme-control" for="workspace-theme">Default theme/);
    assert.match(html, /id="viewport"[^>]*aria-label="[^"]*Scroll empty space to zoom; Control or Command and scroll zooms elsewhere/);
    assert.match(html, /id="footer-hint">Drag to explore · Scroll empty space to zoom<\/span>/);
    const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
    assert.match(footer, /id="settings"[^>]*aria-controls="settings-menu"/);
    assert.equal([...html.matchAll(/id="settings"/g)].length, 1);
    assert.match(html, /id="settings-menu"[^>]*role="menu"[^>]*hidden>[\s\S]*?id="agent-setup"[^>]*role="menuitem"/);
});

test('plain wheel never zooms in Focus mode or before initialization', async () => {
    const board = createWorkspace(); board.cards.push(createCard());
    const h = await bootSizedTerminals(board), wheel = canvasWheel(h);
    vm.runInContext('setFocus(workspace.cards[0].id)', h.context);
    const before = json(h.context, 'workspace.camera');
    for (const target of [h.elements.get('#viewport'), wheelSurface('.terminal-card')]) {
        assert.equal(wheel({ target }).defaultPrevented, false);
        assert.deepEqual(json(h.context, 'workspace.camera'), before);
    }
    const loading = await boot(createWorkspace(), { initialized: false });
    assert.equal(canvasWheel(loading)().defaultPrevented, false);
});

test('tiny trackpad deltas accumulate, discard reversals and idle remainders, and ignore horizontal-only scroll', async () => {
    const h = await boot(createWorkspace()), wheel = canvasWheel(h);
    const before = json(h.context, 'workspace.camera');
    assert.equal(wheel({ deltaX: 80, deltaY: 0 }).defaultPrevented, false);
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
    for (const deltaY of [-1, 1, -1, 1, -1, -1, -1]) wheel({ deltaY });
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
    wheel({ deltaX: 2, deltaY: -1 });
    const zoomed = json(h.context, 'workspace.camera');
    assert.ok(Math.abs(zoomed.z - before.z * Math.exp(4 * .002)) < 1e-9);
    wheel({ deltaY: -3 });
    wheel({ deltaY: -1, timeStamp: 500 });
    assert.deepEqual(json(h.context, 'workspace.camera'), zoomed, 'an idle gap discards the old remainder');
    wheel({ deltaY: -3 });
    assert.ok(json(h.context, 'workspace.camera.z') > zoomed.z);
});

test('plain wheel normalizes line and page deltas before zooming', async () => {
    for (const [deltaMode, pixels] of [[1, 40], [2, 720]]) {
        const h = await boot(createWorkspace()), wheel = canvasWheel(h);
        vm.runInContext('workspace.camera.z = .5', h.context);
        wheel({ deltaY: -.1, deltaMode });
        assert.ok(Math.abs(json(h.context, 'workspace.camera.z') - .5 * Math.exp(.1 * pixels * .002)) < 1e-9);
    }
});

test('a canvas gesture consumes crossings into terminals until 200 ms without input', async () => {
    const h = await boot(createWorkspace()), wheel = canvasWheel(h), target = wheelSurface('.terminal-card');
    let nativeWheels = 0;
    target.addEventListener('wheel', () => { nativeWheels++; });
    wheel({ timeStamp: 0 });
    const zoomed = json(h.context, 'workspace.camera');
    for (const timeStamp of [100, 299, 498]) {
        assert.equal(wheel({ target, timeStamp }).defaultPrevented, true);
        assert.equal(nativeWheels, 0);
        assert.deepEqual(json(h.context, 'workspace.camera'), zoomed);
    }
    assert.equal(wheel({ target, timeStamp: 698 }).defaultPrevented, false);
    assert.equal(nativeWheels, 1);
});

for (const surface of ['.terminal-card', '.canvas-item', '.minimap']) {
    test(`a gesture starting on ${surface} cannot become canvas zoom or scroll another terminal`, async () => {
        const h = await boot(createWorkspace()), wheel = canvasWheel(h), root = new Element();
        const target = wheelSurface(surface, root), sibling = wheelSurface(surface, root), other = wheelSurface('.terminal-card');
        let nativeWheels = 0;
        for (const node of [target, sibling, other]) node.addEventListener('wheel', event => { nativeWheels++; event.stopPropagation(); });
        const before = json(h.context, 'workspace.camera');
        assert.equal(wheel({ target, timeStamp: 0 }).defaultPrevented, false);
        assert.equal(wheel({ target: sibling, timeStamp: 50 }).defaultPrevented, false, 'children share a destination');
        assert.equal(nativeWheels, 2);
        assert.equal(wheel({ timeStamp: 100 }).defaultPrevented, true);
        assert.equal(wheel({ target: other, timeStamp: 150 }).defaultPrevented, true);
        assert.equal(nativeWheels, 2);
        assert.deepEqual(json(h.context, 'workspace.camera'), before);
        assert.equal(wheel({ timeStamp: 350 }).defaultPrevented, true);
        assert.ok(json(h.context, 'workspace.camera.z') > before.z, 'the new gesture can zoom');
    });
}

test('blur and modifier wheel clear plain gesture ownership without changing Ctrl/Cmd behavior', async () => {
    const board = createWorkspace(); board.cards.push(createCard());
    const h = await bootSizedTerminals(board), wheel = canvasWheel(h);
    const card = vm.runInContext('sessions.get(workspace.cards[0].id).element', h.context);
    const target = wheelSurface('.terminal-card', card);
    vm.runInContext('select(workspace.cards[0].id)', h.context);
    wheel();
    assert.equal(wheel({ target }).defaultPrevented, true);
    h.window.dispatch('blur');
    assert.equal(wheel({ target }).defaultPrevented, false);
    assert.equal(wheel().defaultPrevented, true, 'native gesture is still locked');
    const before = json(h.context, 'workspace.camera');
    wheel({ target, ctrlKey: true });
    assert.equal(h.size(board.cards[0].id)[0], 13, 'Ctrl still scales selected terminal text');
    assert.deepEqual(json(h.context, 'workspace.camera'), before);
    wheel({ metaKey: true });
    assert.ok(json(h.context, 'workspace.camera.z') > before.z, 'Cmd still zooms elsewhere');
    assert.equal(wheel({ target }).defaultPrevented, false, 'plain input starts a new gesture after modifiers');
});

test('Ctrl/Cmd + wheel over the selected terminal scales its text one pixel per notch and resizes its PTY', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    const [first, second] = board.cards.map(card => card.id);
    const { context, wheel, size, resizes } = await bootSizedTerminals(board);
    vm.runInContext(`select(${JSON.stringify(first)})`, context);
    const camera = () => json(context, 'workspace.camera');
    const before = camera();
    assert.deepEqual(size(first), [null, 12]);
    assert.equal(wheel({ target: overCard(first) }), true);
    assert.deepEqual(size(first), [13, 13]);
    assert.deepEqual(resizes.at(-1), [first, Math.floor(600 / (13 * .6)), Math.floor(400 / (13 * 1.3))], 'the PTY gets the refitted grid');
    assert.deepEqual(camera(), before, 'scaling text leaves the canvas camera alone');
    wheel({ target: overCard(first), metaKey: true, ctrlKey: false, deltaY: 300 });
    assert.deepEqual(size(first), [10, 10], 'Cmd + wheel works too, and scrolling down shrinks the text');
    // Trackpad pinches send small deltas; they add up to a step, and a change of direction drops the remainder.
    for (const deltaY of [-40, -40]) wheel({ target: overCard(first), deltaY });
    assert.deepEqual(size(first), [10, 10]);
    wheel({ target: overCard(first), deltaY: -40 });
    assert.deepEqual(size(first), [11, 11]);
    wheel({ target: overCard(first), deltaY: 90 });
    assert.deepEqual(size(first), [11, 11], 'the -20 carried over is dropped, not added to 90');
    wheel({ target: overCard(first), deltaY: -1, deltaMode: 1 });
    assert.deepEqual(size(first), [11, 11]);
    wheel({ target: overCard(first), deltaY: -3, deltaMode: 1 });
    assert.deepEqual(size(first), [null, 12], 'line-mode deltas count as pixels');
    assert.equal(json(context, `'fontSize' in workspace.cards[0]`), false, 'the default size is left out of the card');
    wheel({ target: overCard(first), deltaY: -5000 });
    assert.deepEqual(size(first), [32, 32]);
    wheel({ target: overCard(first), deltaY: 9000 });
    assert.deepEqual(size(first), [8, 8]);
    assert.deepEqual(size(second), [null, 12], 'other terminals keep their size');
    assert.deepEqual(camera(), before);
    // Over an unselected terminal, or without Ctrl/Cmd, the wheel keeps its canvas and scrolling behavior.
    assert.equal(wheel({ target: overCard(second) }), true);
    assert.deepEqual(size(second), [null, 12]);
    assert.ok(camera().z > before.z, 'Ctrl + wheel over an unselected terminal zooms the canvas');
    const zoomed = camera();
    assert.equal(wheel({ target: overCard(first), ctrlKey: false }), false);
    assert.deepEqual([size(first), camera()], [[8, 8], zoomed]);
});

test('Ctrl/Cmd + wheel scales the focused terminal anywhere in Focus mode, but never a terminal that is not showing output', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    const [first, second] = board.cards.map(card => card.id);
    const { context, wheel, size } = await bootSizedTerminals(board);
    vm.runInContext(`setFocus(${JSON.stringify(first)})`, context);
    const before = json(context, 'workspace.camera');
    assert.equal(wheel({ target: { closest: () => null } }), true, 'the margin around the focused card counts too');
    assert.deepEqual(size(first), [13, 13]);
    wheel({ target: overCard(second) });
    assert.deepEqual([size(first), size(second)], [[14, 14], [null, 12]]);
    assert.deepEqual(json(context, 'workspace.camera'), before);
    // A card still showing its Start placeholder has nothing to scale: the canvas zooms instead.
    vm.runInContext(`setFocus(null); select(${JSON.stringify(second)}); sessions.get(${JSON.stringify(second)}).placeholder.hidden = false`, context);
    wheel({ target: overCard(second) });
    assert.deepEqual(size(second), [null, 12]);
    assert.ok(json(context, 'workspace.camera.z') > before.z);
    vm.runInContext(`setFocus(${JSON.stringify(second)})`, context);
    const focusedCamera = json(context, 'workspace.camera');
    wheel({ target: overCard(second) });
    assert.deepEqual([size(second), json(context, 'workspace.camera')], [[null, 12], focusedCamera]);
});

test('Ctrl/Cmd+0 resets terminal text size while Ctrl+- and Ctrl+= still reach the shell', async () => {
    const board = createWorkspace(); board.cards.push({ ...createCard(), fontSize: 18 }, createCard());
    const { context, size, resizes } = await bootSizedTerminals(board);
    const [first, second] = board.cards.map(card => card.id);
    assert.deepEqual([size(first), size(second)], [[18, 18], [null, 12]], 'a saved size is restored when the card mounts');
    const terminal = vm.runInContext(`sessions.get(${JSON.stringify(first)}).terminal`, context);
    for (const key of ['-', '=', '_', '+']) assert.equal(shortcut(terminal, key).allowTerminal, true, `Ctrl+${key} goes to the shell`);
    assert.equal(shortcut(terminal, ')', { shiftKey: true, code: 'Digit0' }).allowTerminal, true);
    assert.equal(shortcut(terminal, '0', { altKey: true }).allowTerminal, true);
    assert.deepEqual(size(first), [18, 18]);
    const reset = shortcut(terminal, '0');
    assert.deepEqual([reset.allowTerminal, reset.event.prevented, reset.event.stopped], [false, true, true]);
    assert.deepEqual(size(first), [null, 12]);
    assert.deepEqual(resizes.at(-1), [first, 83, 25]);
    for (const type of ['keypress', 'keyup']) assert.equal(shortcut(terminal, '0', { type }).allowTerminal, false);
    vm.runInContext(`setTerminalFontSize(workspace.cards[0], 20)`, context);
    assert.equal(shortcut(terminal, 'à', { code: 'Digit0' }).allowTerminal, false, 'layouts without a plain 0 key use its position');
    vm.runInContext(`setTerminalFontSize(workspace.cards[0], 20)`, context);
    // Without NumLock the Numpad0 key is Insert, and Ctrl+Insert is a terminal shortcut of its own.
    assert.equal(shortcut(terminal, 'Insert', { code: 'Numpad0' }).allowTerminal, true, 'Ctrl+Insert goes to the shell');
    assert.deepEqual(size(first), [20, 20]);
    assert.equal(shortcut(terminal, '0', { ctrlKey: false, metaKey: true, code: 'Numpad0' }).allowTerminal, false);
    assert.deepEqual(size(first), [null, 12]);
});

test('Duplicate keeps appearance and automatic titles through folder review, then resets launch defaults', async () => {
    const board = createWorkspace(); board.cards.push({ ...createCard(), fontSize: 20, color: 'red', theme: 'paper' }, createCard());
    const { context, bridge, calls, elements } = await boot(board);
    vm.runInContext('start = async card => invoke("start", { card })', context);
    let review = false;
    bridge.invoke = async (action, payload) => {
        calls.push({ action, payload });
        if (action === 'duplicate-directory') return review ? { cwd: 'D:\\review', warning: 'Review folder.' } : { cwd: 'D:\\current' };
        if (action === 'create-card') return { card: createCard(payload) };
        return { ok: true };
    };
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    await vm.runInContext('duplicateTerminal(workspace.cards[1])', context);
    assert.deepEqual(json(context, 'workspace.cards.map(card => card.fontSize ?? null)'), [20, null, 20, null]);
    assert.deepEqual(json(context, 'workspace.cards.map(card => [card.color ?? null, card.theme ?? null])'), [['red', 'paper'], [null, null], ['red', 'paper'], [null, null]]);
    assert.deepEqual(calls.filter(c => c.action === 'create-card').map(c => c.payload.titleMode), ['automatic', 'automatic']);
    assert.equal(calls.filter(c => c.action === 'start')[0].payload.card.fontSize, 20, 'the host receives the size with the card');
    review = true;
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(elements.get('#launch-dialog').open, true);
    elements.get('#terminal-title').value = 'Review this task'; elements.get('#terminal-title').oninput();
    elements.get('#profile').onchange();
    assert.equal(elements.get('#terminal-title').value, 'Review this task', 'profile changes preserve a typed name');
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush(); await flush();
    assert.deepEqual(json(context, 'workspace.cards.map(card => card.fontSize ?? null)'), [20, null, 20, null, 20]);
    assert.deepEqual(json(context, '[workspace.cards.at(-1).color, workspace.cards.at(-1).theme]'), ['red', 'paper']);
    assert.deepEqual(json(context, '[workspace.cards.at(-1).title, workspace.cards.at(-1).titleMode]'), ['Review this task', 'manual']);
    // An ordinary New terminal dialog afterwards starts at the default.
    vm.runInContext('openLaunch()', context);
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush(); await flush();
    assert.equal(json(context, 'workspace.cards.at(-1).fontSize ?? null'), null);
    assert.deepEqual(json(context, '[workspace.cards.at(-1).color ?? null, workspace.cards.at(-1).theme ?? null]'), [null, null]);
    assert.equal(json(context, 'workspace.cards.at(-1).titleMode'), 'automatic');
});

test('pending paste cannot write to a stopped or disposed terminal and clipboard errors are shown', async () => {
    for (const state of ['exited', 'disposed', 'running']) {
        const workspace = createWorkspace(); workspace.cards.push(createCard());
        let complete;
        const { context, elements } = await boot(workspace, { terminals: true,
            readClipboard: () => new Promise(resolve => { complete = resolve; }) });
        vm.runInContext("sessions.get(workspace.cards[0].id).status = 'running'", context);
        const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
        shortcut(terminal, 'v');
        await flush();
        if (state === 'disposed') vm.runInContext('dispose(workspace.cards[0].id)', context);
        else vm.runInContext(`sessions.get(workspace.cards[0].id).status = '${state}'`, context);
        complete(state === 'running' ? { error: 'Paste exceeds 1 MB.' } : { text: 'too late' });
        await flush();
        assert.deepEqual(terminal.pasted, []);
        if (state === 'running') assert.equal(elements.get('#toast').textContent, 'Paste exceeds 1 MB.');
        else assert.equal(elements.get('#toast').hidden, true);
    }
});

test('clipboard shortcuts outside terminals leave native text editing and canvas handling alone', async () => {
    const { document, elements, calls } = await boot(createWorkspace(), { terminals: true });
    for (const target of [elements.get('#search'), elements.get('#workspace-name'), elements.get('#viewport'), new Element()]) {
        for (const key of ['c', 'v']) {
            for (const shiftKey of [false, true]) {
                let prevented = false;
                document.dispatch('keydown', { target, key, ctrlKey: true, shiftKey, preventDefault() { prevented = true; } });
                assert.equal(prevented, false);
            }
        }
    }
    await flush();
    assert.equal(calls.some(c => c.action.startsWith('clipboard-')), false);
});

test('live directory events update only the corresponding display and preserve launch folders', async () => {
    const board = createWorkspace();
    board.cards.push(createCard({ cwd: 'C:\\Launch one' }), createCard({ cwd: 'C:\\Launch two' }));
    const { elements, context, bridge } = await boot(board);
    const [first, second] = elements.get('#world').children;
    bridge.event({ type: 'cwd', id: board.cards[1].id, cwd: 'D:\\New folder\\子' });
    assert.equal(second.querySelector('.card-directory span').textContent, 'D:\\New folder\\子');
    assert.equal(second.querySelector('.card-directory').title, 'D:\\New folder\\子');
    assert.equal(first.querySelector('.card-directory span').textContent, board.cards[0].cwd);
    assert.equal(vm.runInContext('workspace.cards[1].cwd', context), board.cards[1].cwd);
    bridge.event({ type: 'cwd', id: board.cards[1].id, cwd: null });
    assert.equal(second.querySelector('.card-directory span').textContent, 'Current directory unavailable');
    bridge.event({ type: 'cwd', id: 'removed', cwd: '/ignored' });
});

test('restarting clears the previous live directory and still sends the configured launch folder', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ cwd: 'C:\\Launch folder' }));
    const { context, bridge, elements, calls } = await boot(board);
    bridge.event({ type: 'cwd', id: board.cards[0].id, cwd: 'D:\\Previous live folder' });
    vm.runInContext(`const s = sessions.get(workspace.cards[0].id);
        s.status = 'exited'; s.terminal = { reset() {}, focus() {}, cols: 80, rows: 24 };`, context);
    await vm.runInContext('start(workspace.cards[0])', context);
    assert.equal(calls.find(c => c.action === 'start').payload.card.cwd, board.cards[0].cwd);
    assert.equal(elements.get('#world').children[0].querySelector('.card-directory span').textContent, 'Current directory unavailable');
    bridge.event({ type: 'cwd', id: board.cards[0].id, cwd: board.cards[0].cwd });
    assert.equal(elements.get('#world').children[0].querySelector('.card-directory span').textContent, board.cards[0].cwd);
});

test('startup cursor replies reach the PTY before the start response without accepting early typing', async () => {
    const board = createWorkspace(), card = createCard(); board.cards.push(card);
    let finishStart;
    const pendingStart = new Promise(resolve => { finishStart = resolve; });
    const { context, bridge } = await boot(board, { terminals: true,
        respond: action => action === 'start' ? pendingStart : undefined });
    const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
    terminal.cols = 80; terminal.rows = 24; terminal.write = (_data, done) => done();
    const sent = []; bridge.input = (id, data) => sent.push({ id, data });
    const starting = vm.runInContext('start(workspace.cards[0])', context); await flush();
    terminal.dataHandler('early typing\r');
    terminal.dataHandler('\x1b[1;1R'); // No query has arrived yet.
    bridge.event({ type: 'data', id: card.id, data: '\x1b[6' });
    bridge.event({ type: 'data', id: card.id, data: 'n' });
    terminal.dataHandler('still early\r');
    terminal.dataHandler('\x1b[1;1R');
    terminal.dataHandler('\x1b[1;1R'); // The one query must not authorize another reply.
    assert.deepEqual(sent, [{ id: card.id, data: '\x1b[1;1R' }]);
    finishStart({ cwd: card.cwd }); await starting;
    terminal.dataHandler('ready typing\r');
    assert.deepEqual(sent.at(-1), { id: card.id, data: 'ready typing\r' });
});

test('kept terminals hear focus out only while the app itself still has focus', async () => {
    const board = createWorkspace(), kept = createCard(), plain = createCard(); board.cards.push(kept, plain);
    const { context, bridge, document } = await boot(board, { terminals: true,
        respond: (action, payload) => action === 'start' ? { cwd: payload.card.cwd, kept: payload.card.id === kept.id } : undefined });
    const timers = [];
    context.setTimeout = callback => timers.push(callback);
    let appFocused = true; document.hasFocus = () => appFocused;
    const terminal = id => vm.runInContext(`sessions.get(${JSON.stringify(id)}).terminal`, context);
    for (const card of [kept, plain]) { terminal(card.id).write = (_data, done) => done(); context.card = card; await vm.runInContext('start(anyCard(card.id))', context); }
    const sent = []; bridge.input = (id, data) => sent.push({ id, data });
    const runTimers = () => { while (timers.length) timers.shift()(); };

    appFocused = false; // Another app took focus; the browser blurs the terminal and reports focus out.
    terminal(kept.id).dataHandler('\x1b[O');
    terminal(plain.id).dataHandler('\x1b[O');
    runTimers();
    assert.deepEqual(sent, [{ id: plain.id, data: '\x1b[O' }], 'only the plain terminal is told the app lost focus');

    appFocused = true; sent.length = 0; // Back in the app; focus moved to another card.
    terminal(kept.id).dataHandler('\x1b[I');
    terminal(kept.id).dataHandler('\x1b[O');
    assert.deepEqual(sent, [{ id: kept.id, data: '\x1b[I' }], 'focus out waits a task for the window to settle');
    runTimers();
    assert.deepEqual(sent.at(-1), { id: kept.id, data: '\x1b[O' }, 'moving within the app still reports focus out');

    sent.length = 0;
    terminal(kept.id).dataHandler('\x1b[O');
    vm.runInContext(`setStatus(anyCard(${JSON.stringify(kept.id)}), 'exited')`, context);
    runTimers();
    assert.deepEqual(sent, [], 'a deferred report never reaches a terminal that has ended');
});

test('terminal hyperlinks open only on a trusted primary click, without confirmation', async () => {
    let options;
    const terminal = {
        loadAddon() {}, open() {}, onData() {}, onResize() {}, attachCustomKeyEventHandler() {}
    };
    const workspace = createWorkspace();
    workspace.cards.push(createCard());
    const { calls, elements } = await boot(workspace, {
        Terminal: function (value) { options = value; return terminal; },
        FitAddon: { FitAddon: class {} },
        confirm() { assert.fail('Hyperlinks must not ask for confirmation.'); },
        open() { assert.fail('Hyperlinks must use the validated desktop bridge.'); }
    });
    assert.equal(elements.get('#toast').hidden, true, elements.get('#toast').textContent);
    assert.ok(options.linkHandler);
    assert.equal(options.linkHandler.allowNonHttpProtocols, false);
    const opened = () => calls.filter(call => call.action === 'open-link');
    assert.equal(opened().length, 0, 'restoring and rendering a terminal never opens a link');
    const uri = 'https://github.com/yutigi/TerminalCanvas';
    const click = { isTrusted: true, button: 0, preventDefault() {} };
    options.linkHandler.activate({ ...click, isTrusted: false }, uri);
    options.linkHandler.activate({ ...click, button: 1 }, uri);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opened().length, 0, 'synthetic and non-primary clicks never open a link');
    let prevented = false;
    options.linkHandler.activate({ ...click, preventDefault() { prevented = true; } }, uri);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.deepEqual(opened(), [{ action: 'open-link', payload: uri }]);
});


test('Browse forwards the field including nested spaces and preserves input on cancellation or errors', async () => {
    const { elements, bridge, calls } = await boot(createWorkspace());
    const field = elements.get('#cwd'); field.value = 'D:\\nested folder\\project';
    bridge.invoke = async (action, payload) => { calls.push({ action, payload }); return { path: null }; };
    elements.get('#browse-folder').onclick(); await flush();
    assert.equal(calls.at(-1).action, 'pick-folder');
    assert.equal(calls.at(-1).payload.cwd, field.value);
    assert.equal(field.value, 'D:\\nested folder\\project');
    field.value = 'invalid directory';
    elements.get('#browse-folder').onclick(); await flush();
    assert.equal(field.value, 'invalid directory');
    bridge.invoke = async () => ({ error: 'Unavailable picker' });
    elements.get('#browse-folder').onclick(); await flush();
    assert.equal(field.value, 'invalid directory');
    bridge.invoke = async () => ({ path: 'D:\\chosen space' });
    elements.get('#browse-folder').onclick(); await flush();
    assert.equal(field.value, 'D:\\chosen space');
});

test('Duplicate creates and starts only a fresh shell, selects it, and retains focus mode', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ profile: 'codex' }), createCard());
    const { context, bridge, calls } = await boot(board);
    // Desktop emulation stays outside this renderer state test.
    vm.runInContext('start = async card => invoke("start", { card }); setFocus(workspace.cards[0].id)', context);
    const fresh = createCard({ cwd: 'D:\\nested space\\current' });
    bridge.invoke = async (action, payload) => {
        calls.push({ action, payload });
        if (action === 'duplicate-directory') return { cwd: fresh.cwd };
        if (action === 'create-card') return { card: fresh };
        return { ok: true };
    };
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    const creation = calls.find(c => c.action === 'create-card').payload;
    assert.deepEqual({ profile: creation.profile, command: creation.command, cwd: creation.cwd }, { profile: 'shell', command: '', cwd: fresh.cwd });
    assert.equal(json(context, 'workspace.cards.length'), 3);
    assert.equal(json(context, 'selected'), fresh.id);
    assert.equal(json(context, 'focused'), fresh.id);
    assert.equal(calls.filter(c => c.action === 'start').length, 1);
    assert.equal(calls.find(c => c.action === 'start').payload.card.id, fresh.id);
    assert.equal(json(context, 'workspace.cards[0].command'), 'codex');
});

test('Duplicate fallback opens a plain-shell dialog for review and does not launch or create anything', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ profile: 'codex' }));
    const { context, bridge, calls, elements } = await boot(board);
    bridge.invoke = async (action, payload) => { calls.push({ action, payload }); return { cwd: 'D:\\launch folder', warning: 'Current directory unavailable. Review folder.' }; };
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(elements.get('#launch-dialog').open, true);
    assert.equal(elements.get('#cwd').value, 'D:\\launch folder');
    assert.equal(elements.get('#profile').value, 'shell');
    assert.equal(elements.get('#command').value, '');
    assert.equal(elements.get('#launch-error').hidden, false);
    assert.match(elements.get('#launch-error').textContent, /unavailable/);
    assert.deepEqual(calls.map(c => c.action), ['initialize', 'duplicate-directory']);
});

test('a terminal keeps the Claude account chosen for it and starts with it', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ profile: 'claude' }));
    const respond = (action, payload) => action !== 'claude-accounts' ? null
        : payload.create ? { accounts: ['Personal', 'Work'], created: 'Work' } : { accounts: ['Personal'] };
    const { context, calls, elements } = await boot(board, { respond, terminals: true });
    const control = () => vm.runInContext('[...sessions.values()][0].element.querySelector(".card-account")', context);
    assert.equal(control().textContent, 'Claude · Default');
    await vm.runInContext('openAccountDialog(workspace.cards[0])', context);
    assert.equal(elements.get('#account-dialog').open, true);
    assert.equal(elements.get('#account-select').value, '');
    assert.deepEqual(elements.get('#account-select').children.map(option => option.value), ['', 'Personal']);
    elements.get('#account-name').value = ' Work ';
    elements.get('#account-add').onclick(); await flush();
    assert.deepEqual(structuredClone(calls.filter(c => c.action === 'claude-accounts').map(c => c.payload)), [{}, { create: 'Work' }]);
    assert.equal(elements.get('#account-select').value, 'Work');
    assert.equal(elements.get('#account-name').value, '');
    elements.get('#account-form').onsubmit({ preventDefault() {} });
    assert.equal(elements.get('#account-dialog').open, false);
    assert.equal(json(context, 'workspace.cards[0].claudeAccount'), 'Work');
    assert.equal(control().textContent, 'Claude · Work');
    assert.equal(control().classList.contains('set'), true);
    const headerIcon = vm.runInContext('[...sessions.values()][0].element', context);
    assert.match(headerIcon.innerHTML, /<div class="card-actions"><button class="card-account-icon" data-action="account"/, 'the account icon leads the card actions');
    assert.equal(headerIcon.querySelector('.card-account-icon').title, 'Claude account: Work');
    await vm.runInContext('start(workspace.cards[0])', context);
    assert.equal(calls.find(c => c.action === 'start').payload.card.claudeAccount, 'Work');
    // A running terminal keeps its account until it starts again; the default removes the field.
    elements.get('#toast').hidden = true;
    await vm.runInContext('openAccountDialog(workspace.cards[0])', context);
    assert.equal(elements.get('#account-select').value, 'Work');
    elements.get('#account-select').value = '';
    elements.get('#account-form').onsubmit({ preventDefault() {} });
    assert.equal(json(context, '"claudeAccount" in workspace.cards[0]'), false);
    assert.equal(control().textContent, 'Claude · Default');
    assert.equal(elements.get('#toast').hidden, false);
    assert.match(elements.get('#toast').textContent, /default Claude sign-in the next time it starts/);
});

test('an account shows who it is signed in as and signs in with the browser in its own terminal', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ profile: 'claude', title: 'Backend' }));
    const respond = (action, payload) => action === 'claude-accounts' ? { accounts: ['Personal', 'Work'], signedIn: { Work: 'work@example.com' } }
        : action === 'create-card' ? { card: createCard(payload) } : null;
    const { context, calls, elements } = await boot(board, { respond, terminals: true });
    await vm.runInContext('openAccountDialog(workspace.cards[0])', context);
    assert.match(elements.get('#account-status').textContent, /usual|already has/);
    assert.equal(elements.get('#account-signin').disabled, true, 'the default uses the shell sign-in');
    elements.get('#account-select').value = 'Work'; elements.get('#account-select').onchange();
    assert.equal(elements.get('#account-status').textContent, 'Signed in as work@example.com.');
    assert.match(elements.get('#account-signin').innerHTML, /Sign in again/);
    elements.get('#account-select').value = 'Personal'; elements.get('#account-select').onchange();
    assert.match(elements.get('#account-status').textContent, /Not signed in yet/);
    assert.equal(elements.get('#account-signin').disabled, false);
    elements.get('#account-signin').onclick(); await flush();
    assert.equal(elements.get('#account-dialog').open, false);
    assert.equal(json(context, 'workspace.cards[0].claudeAccount'), 'Personal', 'signing in also chooses the account');
    const login = json(context, 'workspace.cards[1]');
    assert.deepEqual([login.title, login.command, login.profile, login.claudeAccount], ['Sign in · Personal', 'claude auth login', 'shell', 'Personal']);
    assert.equal(calls.filter(c => c.action === 'start').at(-1).payload.card.id, login.id);
    assert.match(elements.get('#toast').textContent, /browser/);
});

test('duplicated, reviewed, and requested terminals carry a Claude account; new ones use the default', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ claudeAccount: 'Work' }));
    let warning = null;
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) }
        : action === 'duplicate-directory' ? { cwd: '/repo', ...(warning ? { warning } : {}) } : null;
    const { context, calls, elements } = await boot(board, { respond, terminals: true });
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(json(context, 'workspace.cards[1].claudeAccount'), 'Work');
    // A duplicate whose folder needs review keeps the account through the dialog.
    warning = 'Review folder.';
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(elements.get('#launch-dialog').open, true);
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(json(context, 'workspace.cards[2].claudeAccount'), 'Work');
    vm.runInContext('openLaunch("shell")', context);
    elements.get('#launch-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(json(context, '"claudeAccount" in workspace.cards[3]'), false);
    await vm.runInContext('openRequestedTerminal({ id: workspace.cards[0].id, profile: "shell", title: "Child", cwd: "/repo", command: "" })', context);
    assert.equal(json(context, 'workspace.cards[4].claudeAccount'), 'Work');
    assert.deepEqual(calls.filter(c => c.action === 'start').map(c => c.payload.card.claudeAccount ?? null), ['Work', 'Work', null, 'Work']);
});

test('Duplicate shortcut targets the focused terminal, preserves Ctrl+D, and ignores text fields and repeats', async () => {
    let terminalHandler;
    const terminal = { loadAddon() {}, open() {}, onData() {}, onResize() {}, attachCustomKeyEventHandler(fn) { terminalHandler = fn; } };
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    const { context, documentListeners } = await boot(board, { Terminal: function () { return terminal; }, FitAddon: { FitAddon: class {} } });
    vm.runInContext('globalThis.duplicated = []; duplicateTerminal = async card => duplicated.push(card.id); selected = workspace.cards[0].id;', context);
    const keydown = documentListeners.get('keydown');
    const sourceTarget = { closest(selector) { return selector === '.terminal-card' ? { dataset: { id: board.cards[1].id } } : null; } };
    const event = { key: 'd', ctrlKey: true, shiftKey: true, target: sourceTarget, preventDefault() {} };
    assert.equal(terminalHandler({ ...event, shiftKey: false }), true, 'Ctrl+D must reach the shell');
    assert.equal(terminalHandler(event), false, 'Ctrl+Shift+D must bypass xterm');
    keydown({ ...event, shiftKey: false }); keydown({ ...event, repeat: true });
    keydown({ ...event, target: { closest: () => ({}) } });
    assert.deepEqual(json(context, 'duplicated'), []);
    keydown(event); await flush();
    assert.deepEqual(json(context, 'duplicated'), [board.cards[1].id]);
});

test('launching and duplicating terminals can exceed 24 cards', async () => {
    const board = createWorkspace(); board.cards = Array.from({ length: 24 }, () => createCard());
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) }
        : action === 'duplicate-directory' ? { cwd: '/repo' } : null;
    const { context, calls, elements } = await boot(board, { respond, terminals: true });
    vm.runInContext('openLaunch("shell")', context);
    assert.equal(elements.get('#launch-dialog').open, true);
    elements.get('#cwd').value = '/repo';
    elements.get('#launch-form').onsubmit({ preventDefault() {} });
    await flush();
    assert.equal(json(context, 'workspace.cards.length'), 25);
    assert.equal(elements.get('#launch-dialog').open, false);
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(json(context, 'workspace.cards.length'), 26);
    assert.deepEqual(calls.filter(c => c.action === 'start').map(c => c.payload.card.id), json(context, 'workspace.cards.slice(24).map(c => c.id)'));
});

test('Duplicate ignores repeats or sources removed during lookup', async () => {
    const board = createWorkspace(); board.cards.push(createCard());
    const { context, bridge, calls } = await boot(board);
    let complete;
    bridge.invoke = (action, payload) => { calls.push({ action, payload }); return new Promise(resolve => { complete = resolve; }); };
    const first = vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
    assert.equal(calls.filter(c => c.action === 'duplicate-directory').length, 1);
    vm.runInContext('workspace.cards = []', context);
    complete({ cwd: 'D:\\current' }); await first;
    assert.equal(calls.filter(c => c.action === 'create-card').length, 0);
    assert.equal(vm.runInContext('duplicateBusy', context), false);
});

test('Duplicate clamps both axes at valid canvas boundaries before host validation', async () => {
    for (const coordinate of [100000, 99980, -100000]) {
        const board = createWorkspace(); board.cards.push(createCard({ x: coordinate, y: coordinate }));
        const { context, bridge } = await boot(board);
        vm.runInContext('start = async () => {}', context);
        bridge.invoke = async (action, payload) => {
            if (action === 'duplicate-directory') return { cwd: process.cwd() };
            if (action === 'create-card') return { card: createCard(payload) };
            return { ok: true };
        };
        await vm.runInContext('duplicateTerminal(workspace.cards[0])', context);
        assert.equal(json(context, 'workspace.cards.length'), 2);
        const duplicate = json(context, 'workspace.cards[1]');
        assert.equal(duplicate.x, Math.min(100000, coordinate + 40));
        assert.equal(duplicate.y, Math.min(100000, coordinate + 40));
    }
});


for (const focus of [false, true]) {
    test(`pending paste cannot cross a process restart in ${focus ? 'Focus' : 'canvas'} view`, async () => {
        for (const readPending of [false, true]) {
            const workspace = createWorkspace(); workspace.cards.push(createCard());
            let finishRead;
            const { context, bridge } = await boot(workspace, { terminals: true,
                readClipboard: () => new Promise(resolve => { finishRead = resolve; }) });
            await vm.runInContext('start(workspace.cards[0])', context);
            if (focus) vm.runInContext('setFocus(workspace.cards[0].id)', context);
            const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
            shortcut(terminal, 'v');
            if (readPending) await flush();
            bridge.event({ type: 'exit', id: workspace.cards[0].id, exitCode: 0 });
            await vm.runInContext('start(workspace.cards[0])', context);
            await flush();
            finishRead({ text: 'old process command\r' });
            await flush();
            assert.deepEqual(terminal.pasted, [], `discard stale text even when restart ${readPending ? 'follows' : 'precedes'} the clipboard read`);
            shortcut(terminal, 'v');
            await flush();
            finishRead({ text: 'new process text' });
            await flush();
            assert.deepEqual(terminal.pasted, ['new process text'], 'the replacement process still accepts its own paste');
        }
    });
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const offer = (update = {}) => ({ type: 'update', current: '0.1.0', update: { version: '0.2.0', notes: 'Fixes', url: 'https://github.com/yutigi/TerminalCanvas/releases/tag/v0.2.0', installable: true, ...update } });

test('the host version replaces the static label, and no update keeps the button hidden', async () => {
    const { elements, event, calls } = await boot(createWorkspace());
    event(offer());
    event({ type: 'update', current: '0.3.1', update: null });
    assert.equal(elements.get('#app-version').textContent, 'v0.3.1');
    assert.equal(elements.get('#update').hidden, true);
    assert.deepEqual(calls.map(c => c.action), ['initialize']);
});

test('a downloaded update restarts through the normal save-and-close handshake', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard());
    const { elements, event, calls } = await boot(workspace);
    event(offer());
    const button = elements.get('#update');
    assert.equal(button.hidden, false);
    assert.match(button.innerHTML, /Restart to update/);
    assert.match(button.title, /0\.2\.0 is ready[\s\S]*Fixes/);
    button.onclick();
    await settle();
    assert.deepEqual(calls.map(c => c.action), ['initialize', 'update-install', 'close']);
    assert.equal(calls.at(-1).payload.cards[0].id, workspace.cards[0].id, 'the current layout is saved on close');
    assert.equal(button.disabled, true);
});

test('restarting for an update asks first when terminals are running', async () => {
    const workspace = createWorkspace(); workspace.cards.push(createCard());
    const { elements, event, calls, context } = await boot(workspace);
    vm.runInContext('sessions.get(workspace.cards[0].id).status = "running"', context);
    event(offer());
    elements.get('#update').onclick();
    await settle();
    assert.equal(elements.get('#confirm-dialog').open, true);
    assert.match(elements.get('#confirm-description').textContent, /1 running terminal will stop/);
    elements.get('#confirm-cancel').onclick();
    await settle();
    assert.deepEqual(calls.map(c => c.action), ['initialize'], 'cancelling keeps the app and its terminals running');
    elements.get('#update').onclick();
    await settle();
    elements.get('#confirm-ok').onclick();
    await settle();
    assert.deepEqual(calls.map(c => c.action), ['initialize', 'update-install', 'close']);
});

test('a failed install is reported and the app stays open', async () => {
    const respond = action => action === 'update-install' ? { error: 'Could not install the update: read-only volume' } : undefined;
    const { elements, event, calls } = await boot(createWorkspace(), { respond });
    event(offer());
    elements.get('#update').onclick();
    await settle();
    assert.deepEqual(calls.map(c => c.action), ['initialize', 'update-install']);
    assert.equal(elements.get('#toast').textContent, 'Could not install the update: read-only volume');
    assert.equal(elements.get('#update').disabled, false);
});

test('a copy that cannot update itself links to the release instead of closing', async () => {
    const { elements, event, calls } = await boot(createWorkspace());
    event(offer({ installable: false }));
    assert.match(elements.get('#update').innerHTML, /Update available/);
    elements.get('#update').onclick();
    await settle();
    assert.deepEqual(calls.map(c => [c.action, c.payload]), [['initialize', undefined], ['open-link', 'https://github.com/yutigi/TerminalCanvas/releases/tag/v0.2.0']]);
});

test('a terminal request opens a started card beside its parent, joined by an undoable arrow', async () => {
    const workspace = createWorkspace();
    const parent = createCard({ title: 'Planner', x: 100, y: 50 });
    workspace.cards.push(parent);
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) } : action === 'start' ? { cwd: payload.card.cwd } : null;
    const { context, calls, elements, bridge } = await boot(workspace, { respond, terminals: true });
    const flush = () => vm.runInContext('terminalRequests', context);
    bridge.event({ type: 'launch', id: parent.id, profile: 'claude', title: 'Handover', cwd: '/repo', command: 'claude "Read the handover"' });
    await flush();
    const created = structuredClone(calls.find(c => c.action === 'create-card').payload);
    assert.deepEqual(created, { profile: 'claude', title: 'Handover', cwd: '/repo', command: 'claude "Read the handover"', x: 840, y: 50 });
    const cards = json(context, 'workspace.cards');
    assert.equal(cards.length, 2);
    const child = cards[1];
    assert.equal(child.title, 'Handover');
    const arrow = json(context, 'workspace.items[0]');
    assert.deepEqual({ ...arrow, id: undefined }, { id: undefined, type: 'line', start: { id: parent.id }, end: { id: child.id }, arrow: true });
    assert.equal(elements.get('#line-layer').childElementCount, 1);
    assert.equal(calls.filter(c => c.action === 'start').at(-1).payload.card.id, child.id, 'the new terminal starts');
    assert.equal(vm.runInContext('selected', context), child.id);
    assert.match(elements.get('#toast').textContent, /Planner opened a new terminal: Handover/);
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items').length, 0, 'undo removes the arrow');
    assert.equal(json(context, 'workspace.cards').length, 2, 'but never closes the terminal');

    bridge.event({ type: 'launch', id: 'closed-terminal', profile: 'shell', title: 'Ignored', cwd: '/repo', command: '' });
    await flush();
    assert.equal(calls.filter(c => c.action === 'create-card').length, 1, 'requests from closed terminals are dropped');
});

test('internal and external terminal requests can exceed 24 cards', async () => {
    const workspace = createWorkspace();
    for (let index = 0; index < 24; index++) workspace.cards.push(createCard({ x: index * 700, y: 0 }));
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) } : null;
    const { context, calls, bridge } = await boot(workspace, { respond, terminals: true });
    for (const external of [false, true]) {
        const request = external ? 'req-external' : 'req-internal';
        bridge.event({ type: 'launch', id: workspace.cards[0].id, parent: workspace.cards[0].id, external, request, profile: 'shell', title: 'Worker', cwd: '/repo', command: '' });
        await vm.runInContext('terminalRequests', context);
        const child = json(context, 'workspace.cards').at(-1);
        assert.deepEqual(structuredClone(calls.filter(c => c.action === 'launch-result').at(-1).payload), { request, card: child.id, parent: workspace.cards[0].id });
        assert.equal(calls.filter(c => c.action === 'start').at(-1).payload.card.id, child.id);
    }
    assert.equal(json(context, 'workspace.cards.length'), 26);
    assert.equal(calls.filter(c => c.action === 'create-card').length, 2);
});

test('programs outside the canvas open terminals in view, beside a named parent when it exists', async () => {
    const workspace = createWorkspace();
    const parent = createCard({ title: 'Lead', x: 100, y: 50 });
    workspace.cards.push(parent);
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) } : action === 'start' ? { cwd: payload.card.cwd } : null;
    const { context, calls, elements, bridge } = await boot(workspace, { respond, terminals: true });
    const flush = () => vm.runInContext('terminalRequests', context);
    const request = extra => ({ type: 'launch', external: true, profile: 'codex', title: 'Worker', cwd: '/repo', command: 'codex', ...extra });
    const lastResult = () => structuredClone(calls.filter(c => c.action === 'launch-result').at(-1).payload);

    bridge.event(request({ request: 'req-alone' }));
    await flush();
    assert.deepEqual(Object.keys(lastResult()), ['request', 'card'], 'no parent is reported without one');
    const standalone = structuredClone(calls.filter(c => c.action === 'create-card').at(-1).payload);
    const center = json(context, 'viewportCenterWorld()');
    assert.deepEqual({ x: standalone.x, y: standalone.y }, json(context, `Geometry.placeNear(${JSON.stringify(center)}, { w: 660, h: 430 }, [${JSON.stringify(parent)}].map(boundsOf))`));
    assert.equal(json(context, 'workspace.items').length, 0, 'no parent, no arrow');
    assert.match(elements.get('#toast').textContent, /A program opened a new terminal: Worker/);

    bridge.event(request({ request: 'req-child', parent: parent.id, title: 'Child' }));
    await flush();
    const child = json(context, 'workspace.cards').at(-1);
    assert.deepEqual(lastResult(), { request: 'req-child', card: child.id, parent: parent.id });
    assert.equal(child.title, 'Child');
    assert.deepEqual(json(context, 'workspace.items').map(({ start, end }) => ({ start, end })), [{ start: { id: parent.id }, end: { id: child.id } }]);
    assert.match(elements.get('#toast').textContent, /Lead opened a new terminal: Child/);

    bridge.event(request({ request: 'req-orphan', parent: 'closed-card', title: 'Orphan' }));
    await flush();
    assert.equal(lastResult().parent, undefined, 'an unknown parent is not reported as the one used');
    assert.equal(json(context, 'workspace.cards').at(-1).title, 'Orphan', 'an unknown parent still opens the terminal');
    assert.equal(json(context, 'workspace.items').length, 1, 'but without an arrow');
    assert.equal(calls.filter(c => c.action === 'start').length, 3);
});

test('terminal requests that arrive before the workspace loads wait for it', async () => {
    const workspace = createWorkspace();
    let finishInitialize;
    const respond = (action, payload) => action === 'initialize' ? new Promise(resolve => { finishInitialize = resolve; })
        : action === 'create-card' ? { card: createCard(payload) } : null;
    const { context, calls, bridge } = await boot(workspace, { respond });
    bridge.event({ type: 'launch', external: true, profile: 'shell', title: 'Early', cwd: '/repo', command: '' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(c => c.action === 'create-card'), false);
    finishInitialize({ workspace: structuredClone(workspace), profiles: PROFILES, home: '', platform: 'win32' });
    await new Promise(resolve => setImmediate(resolve));
    await vm.runInContext('terminalRequests', context).catch(() => {});
    assert.equal(calls.filter(c => c.action === 'create-card').length, 1);
});

test('every terminal request reports its card or why nothing opened, and starts with its request ID', async () => {
    const workspace = createWorkspace();
    const parent = createCard({ title: 'Agent', x: 0, y: 0 });
    workspace.cards.push(parent);
    let failStart = false;
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) }
        : action === 'start' ? (failStart ? { error: 'Working directory is unavailable.' } : { cwd: payload.card.cwd }) : null;
    const { context, calls, bridge } = await boot(workspace, { respond, terminals: true });
    const flush = () => vm.runInContext('terminalRequests', context);
    const results = () => structuredClone(calls.filter(c => c.action === 'launch-result').map(c => c.payload));
    const launch = extra => ({ type: 'launch', id: parent.id, profile: 'shell', title: 'Worker', cwd: '/repo', command: 'ls', ...extra });

    bridge.event(launch({ request: 'req-opened' }));
    await flush();
    const child = json(context, 'workspace.cards').at(-1);
    assert.equal(structuredClone(calls.find(c => c.action === 'start' && c.payload.card.id === child.id).payload).launch, 'req-opened');
    assert.deepEqual(results(), [{ request: 'req-opened', card: child.id, parent: parent.id }]);

    failStart = true;
    bridge.event(launch({ request: 'req-start-failed' }));
    await flush();
    assert.deepEqual(results().at(-1), { request: 'req-start-failed', error: 'Working directory is unavailable.' });

    bridge.event(launch({ request: 'req-closed', id: 'closed-card' }));
    await flush();
    assert.deepEqual(results().at(-1), { request: 'req-closed', error: 'The terminal that asked for a new terminal has closed.' });

    for (let index = workspace.cards.length; vm.runInContext('workspace.cards.length', context) < 24; index++) {
        vm.runInContext(`{ const card = ${JSON.stringify(createCard({ x: 5000 + index * 700 }))}; workspace.cards.push(card); mount(card); }`, context);
    }
    failStart = false;
    bridge.event(launch({ request: 'req-beyond-24' }));
    await flush();
    const beyond = json(context, 'workspace.cards').at(-1);
    assert.deepEqual(results().at(-1), { request: 'req-beyond-24', card: beyond.id, parent: parent.id });
    assert.equal(json(context, 'workspace.cards.length'), 25);
    assert.equal(results().length, 4, 'one report per request');
});

// Directional keyboard navigation between terminals (#26).
function navigationKey(context, key, values = {}) {
    const event = { type: 'keydown', key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false,
        target: context.viewport, prevented: false, preventDefault() { this.prevented = true; }, ...values };
    for (const handler of vm.runInContext('document', context).listeners.get('keydown')) handler(event);
    return event;
}
const insideTerminal = id => ({ closest: selector => (selector.includes('.terminal-card') ? { dataset: { id } } : selector.includes('.xterm') ? {} : null) });

function sidebarStorage(initial) {
    const values = new Map(initial === undefined ? [] : [['terminal-canvas.sidebar.v1', initial]]);
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function sidebarViewport({ elements }) {
    Object.defineProperty(elements.get('#viewport'), 'clientWidth', {
        get: () => elements.get('#sidebar').hidden ? 1350 : 1100
    });
}
test('switching canvases restores Focus sidebar visibility without camera drift or losing a temporary reveal', async () => {
    const board = twoCanvases();
    const app = await boot(board, { terminals: true }); sidebarViewport(app);
    const { context, elements, document } = app;
    vm.runInContext('setFocus(workspace.cards[0].id)', context);
    const focusedCamera = json(context, 'workspace.camera');
    assert.equal(elements.get('#sidebar').hidden, true);
    for (let trip = 0; trip < 3; trip++) {
        vm.runInContext("switchCanvas('canvas-1')", context);
        assert.equal(elements.get('#sidebar').hidden, false);
        assert.deepEqual(json(context, 'workspace.camera'), board.canvases[1].camera);
        vm.runInContext("switchCanvas('canvas-0')", context);
        assert.equal(elements.get('#sidebar').hidden, true);
        assert.deepEqual(json(context, 'workspace.camera'), focusedCamera);
    }
    elements.get('#sidebar-toggle').click();
    const revealedCamera = json(context, 'workspace.camera');
    vm.runInContext("switchCanvas('canvas-1'); switchCanvas('canvas-0')", context);
    assert.equal(elements.get('#sidebar').hidden, false, 'The Focus visit keeps its temporary reveal');
    assert.deepEqual(json(context, 'workspace.camera'), revealedCamera);
    assert.equal(json(context, 'focused'), board.cards[0].id);
    vm.runInContext(`
        const typingSession = sessions.get(selected);
        typingSession.status = 'running';
        typingSession.terminal.focus = () => {
            globalThis.typingRestored = true;
            document.activeElement = { closest: selector => selector === '.xterm' ? {} : null };
        };
        setFocus(null); setFocus(workspace.cards[0].id);
        globalThis.typingRestored = false;
        switchCanvas('canvas-1');
    `, context);
    const selector = elements.get('#canvas-list'), toggle = elements.get('#sidebar-toggle');
    elements.get('#sidebar').append(selector);
    selector.closest = query => query === '.canvas-manager' ? {} : null;
    selector.focus();
    const focusToggle = toggle.focus.bind(toggle);
    toggle.focus = () => { focusToggle(); document.dispatch('focusin', { target: toggle }); };
    vm.runInContext("switchCanvas('canvas-0')", context);
    assert.equal(json(context, 'globalThis.typingRestored'), true, 'Hiding the selector restores keyboard focus to the running terminal');
});
test('sidebar toggling preserves the world center, refreshes minimap and dimensions, and refits running PTYs', async () => {
    const board = createWorkspace(); board.cards.push(createCard()); board.camera = { x: 30, y: 50, z: .65 };
    const app = await boot(board, { terminals: true }); sidebarViewport(app);
    const { context, elements, frames, calls } = app;
    vm.runInContext(`
        globalThis.resizes = []; globalThis.proposals = 0;
        const session = sessions.get(workspace.cards[0].id);
        session.status = 'running'; session.element.offsetWidth = 660; session.element.offsetHeight = 430;
        session.fit = { proposeDimensions() { proposals++; return { cols: viewport.clientWidth > 1100 ? 100 : 80, rows: 24 }; } };
        bridge.resize = (id, cols, rows) => resizes.push({ id, cols, rows });
    `, context);
    const center = () => json(context, '({ x: (viewport.clientWidth / 2 - workspace.camera.x) / workspace.camera.z, y: (viewport.clientHeight / 2 - workspace.camera.y) / workspace.camera.z })');
    const before = center(), miniBefore = json(context, 'minimapLayout.viewport.w');
    elements.get('#sidebar-toggle').click();
    assert.equal(elements.get('#sidebar').hidden, true);
    assert.equal(elements.get('#sidebar-toggle').attributes.get('aria-expanded'), 'false');
    assert.equal(elements.get('#sidebar-toggle').attributes.get('aria-label'), 'Show sidebar');
    assert.deepEqual(center(), before);
    assert.ok(json(context, 'minimapLayout.viewport.w') > miniBefore);
    for (const callback of frames.splice(0)) callback();
    assert.equal(json(context, 'resizes.at(-1).cols'), 100);
    elements.get('#sidebar-toggle').click();
    for (const callback of frames.splice(0)) callback();
    assert.deepEqual(center(), before);
    assert.equal(json(context, 'resizes.at(-1).cols'), 80);
    assert.equal(json(context, 'workspace.camera.z'), .65);
    assert.deepEqual(calls.map(call => call.action), ['initialize'], 'UI toggles do not autosave or call the host');
});

test('section disclosures recover hidden focus, keep counts visible, and persist across workspaces and restarts', async () => {
    const storage = sidebarStorage(), board = createWorkspace(); board.cards.push(createCard());
    const app = await boot(board, { localStorage: storage });
    const { elements, document, context } = app;
    elements.get('#sidebar').append(elements.get('#workspace-toggle'), elements.get('#workspace-section'), elements.get('#outline-toggle'), elements.get('#outline-section'));
    elements.get('#outline-section').append(elements.get('#search'), elements.get('#outline'));
    elements.get('#workspace-section').append(elements.get('#canvas-nav'));
    elements.get('#canvas-nav').focus();
    elements.get('#workspace-toggle').click();
    assert.equal(document.activeElement, elements.get('#workspace-toggle'));
    assert.equal(elements.get('#card-count').parentElement, elements.get('#workspace-toggle'));
    assert.equal(elements.get('#card-count').textContent, 1);
    elements.get('#search').focus(); elements.get('#outline-toggle').click();
    assert.equal(document.activeElement, elements.get('#outline-toggle'));
    assert.equal(elements.get('#outline-section').hidden, true);
    assert.equal(elements.get('#outline-count').textContent, '01');
    elements.get('#profiles-toggle').click(); elements.get('#sidebar-toggle').click();
    assert.equal(document.activeElement, elements.get('#sidebar-toggle'));
    assert.deepEqual(JSON.parse(storage.getItem('terminal-canvas.sidebar.v1')), { collapsed: true, workspace: true, profiles: true, outline: true });
    vm.runInContext('loadWorkspace(JSON.parse(JSON.stringify(workspace)))', context);
    assert.equal(elements.get('#sidebar').hidden, true);
    const restarted = await boot(createWorkspace(), { localStorage: storage });
    for (const selector of ['#sidebar', '#workspace-section', '#profile-list', '#outline-section']) assert.equal(restarted.elements.get(selector).hidden, true);
    for (const selector of ['#workspace-toggle', '#profiles-toggle', '#outline-toggle']) assert.equal(restarted.elements.get(selector).attributes.get('aria-expanded'), 'false');
    assert.deepEqual(Object.keys(json(context, 'workspace')).sort(), Object.keys(board).sort());
    elements.get('#workspace-toggle').click();
    assert.equal(elements.get('#card-count').parentElement, elements.get('#canvas-nav'));
});

test('slash reveals only the sidebar and outline before focusing search, including in Focus mode', async () => {
    const board = createWorkspace(); board.cards.push(createCard());
    const app = await boot(board, { localStorage: sidebarStorage() });
    const { context, elements, document } = app;
    context.viewport = elements.get('#viewport');
    for (const selector of ['#workspace-toggle', '#profiles-toggle', '#outline-toggle', '#sidebar-toggle']) elements.get(selector).click();
    const search = elements.get('#search'), originalFocus = search.focus.bind(search);
    search.focus = () => {
        assert.equal(elements.get('#sidebar').hidden, false);
        assert.equal(elements.get('#outline-section').hidden, false);
        originalFocus();
    };
    assert.equal(navigationKey(context, '/').prevented, true);
    assert.equal(document.activeElement, search);
    assert.equal(elements.get('#workspace-section').hidden, true);
    assert.equal(elements.get('#profile-list').hidden, true);
    vm.runInContext('setFocus(workspace.cards[0].id)', context);
    assert.equal(elements.get('#sidebar').hidden, true);
    navigationKey(context, '/');
    assert.equal(elements.get('#sidebar').hidden, false);
    assert.equal(json(context, '!!focused'), true, 'search leaves the terminal in Focus mode');
    const count = search.focusCount;
    for (const selector of ['input', 'textarea', '.xterm', '[contenteditable="true"]']) {
        navigationKey(context, '/', { target: { closest: query => query.includes(selector) ? {} : null } });
    }
    assert.equal(search.focusCount, count, 'slash in editors and terminals stays there');
});

test('Focus hides the sidebar temporarily, restores manual state, and keeps its toggle available', async () => {
    const storage = sidebarStorage(), board = createWorkspace(); board.cards.push(createCard(), createCard());
    const app = await boot(board, { localStorage: storage }); sidebarViewport(app);
    const { context, elements } = app;
    const original = json(context, 'workspace.camera');
    vm.runInContext('setFocus(workspace.cards[0].id); setFocus(workspace.cards[1].id)', context);
    assert.equal(elements.get('#sidebar').hidden, true);
    assert.equal(storage.getItem('terminal-canvas.sidebar.v1'), null, 'automatic hiding never persists');
    vm.runInContext('setFocus(null)', context);
    assert.equal(elements.get('#sidebar').hidden, false);
    assert.deepEqual(json(context, 'workspace.camera'), original);
    elements.get('#sidebar-toggle').click();
    vm.runInContext('setFocus(workspace.cards[0].id); setFocus(null)', context);
    assert.equal(elements.get('#sidebar').hidden, true, 'manual hiding survives Focus');
    vm.runInContext('setFocus(workspace.cards[0].id)', context);
    elements.get('#sidebar-toggle').click();
    assert.equal(elements.get('#sidebar').hidden, false, 'the toggle reveals the sidebar during Focus');
    vm.runInContext('setFocus(workspace.cards[1].id)', context);
    assert.equal(elements.get('#sidebar').hidden, false, 'switching focused terminals preserves the override');
    vm.runInContext('setFocus(null); setFocus(workspace.cards[0].id)', context);
    assert.equal(elements.get('#sidebar').hidden, true, 'a new Focus visit hides it again');
});

test('Ctrl/Cmd Shift B bypasses xterm and toggles once, while composing, Alt, and dialogs stay untouched', async () => {
    const board = createWorkspace(); board.cards.push(createCard());
    const { context, elements } = await boot(board, { terminals: true });
    context.viewport = elements.get('#viewport');
    const terminal = vm.runInContext('sessions.get(workspace.cards[0].id).terminal', context);
    for (const modifier of ['ctrlKey', 'metaKey']) {
        const key = { type: 'keydown', key: 'B', shiftKey: true, [modifier]: true, target: insideTerminal(board.cards[0].id) };
        assert.equal(terminal.keyHandler(key), false);
        const before = elements.get('#sidebar').hidden;
        assert.equal(navigationKey(context, 'B', key).prevented, true);
        assert.equal(elements.get('#sidebar').hidden, !before);
        navigationKey(context, 'B', { ...key, repeat: true });
        assert.equal(elements.get('#sidebar').hidden, !before);
        for (const extra of [{ isComposing: true }, { altKey: true }]) {
            assert.equal(terminal.keyHandler({ ...key, ...extra }), true);
            navigationKey(context, 'B', { ...key, ...extra });
            assert.equal(elements.get('#sidebar').hidden, !before);
        }
        elements.get('#info-dialog').showModal(); navigationKey(context, 'B', key);
        assert.equal(elements.get('#sidebar').hidden, !before);
        elements.get('#info-dialog').close();
    }
});

test('sidebar preferences tolerate invalid or blocked storage and camera compensation stays host-valid', async () => {
    for (const value of ['not JSON', 'null', '[]', '{"collapsed":"true","outline":1,"extra":true}']) {
        const { elements } = await boot(createWorkspace(), { localStorage: sidebarStorage(value) });
        assert.equal(elements.get('#sidebar').hidden, false);
        assert.equal(elements.get('#outline-section').hidden, false);
    }
    const app = await boot(createWorkspace(), { localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } } });
    sidebarViewport(app);
    vm.runInContext('workspace.camera.x = 100000', app.context);
    assert.doesNotThrow(() => app.elements.get('#sidebar-toggle').click());
    assert.equal(app.elements.get('#sidebar').hidden, true);
    assert.equal(json(app.context, 'workspace.camera.x'), 100000);
});
async function navigationBoard({ cards, items = [], camera = { x: 48, y: 48, z: 1 }, running = true } = {}) {
    const workspace = createWorkspace(); workspace.camera = camera;
    workspace.cards.push(...cards.map(([title, x, y, extra = {}]) => createCard({ title, x, y, w: 660, h: 430, ...extra })));
    workspace.items.push(...items);
    const booted = await boot(workspace, { terminals: true });
    const { context } = booted;
    context.viewport = booted.elements.get('#viewport');
    // The overlays over a 1100 x 720 view, laid out as the stylesheet places them.
    const place = (selector, left, top, width, height) => {
        if (!booted.elements.has(selector)) booted.elements.set(selector, new Element());
        booted.elements.get(selector).getBoundingClientRect = () => ({ left, top, width, height });
    };
    place('.create-toolbar', 16, 250, 45, 220);
    place('.canvas-toolbar', 400, 650, 300, 45);
    place('#style-toolbar', 450, 16, 200, 40);
    place('#minimap', 840, 525, 240, 170);
    vm.runInContext(`for (const s of sessions.values()) { s.status = ${running ? '"running"' : '"exited"'}; s.typed = 0; s.terminal.focus = () => { s.typed++; }; }`, context);
    const id = title => json(context, `workspace.cards.find(card => card.title === ${JSON.stringify(title)}).id`);
    const state = () => json(context, `({ selected, selection: [...selection], camera: workspace.camera, current: keyboardCurrent,
        highlighted: [...sessions].filter(([, s]) => s.element.classList.contains('keyboard-current')).map(([key]) => key),
        typed: Object.fromEntries([...sessions].map(([key, s]) => [key, s.typed])), focusedTerminal: focused })`);
    return { ...booted, id, state };
}

test('Alt+arrow keys select the nearest terminal without typing in it, highlight it, and pan to it at the same zoom', async () => {
    const { context, elements, id, state } = await navigationBoard({
        cards: [['A', 0, 0], ['B', 2000, 0], ['C', 0, 470], ['D', 2000, 470]], camera: { x: 100, y: 48, z: .8 }
    });
    const viewport = elements.get('#viewport');
    // Nothing selected: any arrow starts at the terminal in the middle of the view.
    const first = navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(first.prevented, true);
    let now = state();
    assert.equal(now.selected, id('A'));
    assert.deepEqual(now.highlighted, [id('A')]);
    assert.deepEqual(now.camera, { x: 100, y: 72, z: .8 }, 'selection reveals the terminal below its newly visible style toolbar');
    assert.ok(viewport.focusCount >= 1, 'the keyboard stays on the board');
    // B is far to the right, beyond the view: the canvas pans just enough, keeping zoom.
    navigationKey(context, 'ArrowRight', { altKey: true });
    now = state();
    assert.equal(now.selected, id('B'));
    assert.deepEqual(now.highlighted, [id('B')]);
    assert.equal(now.camera.z, .8);
    assert.equal(now.camera.y, 72);
    assert.equal(now.camera.x + (2000 + 660) * .8, 1100 - 24, 'the right edge lands just inside the view');
    // No terminal further right: the selection stays where it is.
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().selected, id('B'));
    // Back along the row: A, not C, which is as far across and also lower.
    navigationKey(context, 'ArrowLeft', { altKey: true });
    assert.equal(state().selected, id('A'));
    navigationKey(context, 'ArrowDown', { altKey: true });
    assert.equal(state().selected, id('C'));
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().selected, id('D'));
    navigationKey(context, 'ArrowUp', { altKey: true });
    now = state();
    assert.equal(now.selected, id('B'), 'up from D reaches B, straight above it');
    assert.deepEqual(Object.values(now.typed), [0, 0, 0, 0], 'navigation never moves typing into a terminal');
    // Plain arrows and Shift+Alt+arrows are left alone.
    assert.equal(navigationKey(context, 'ArrowRight').prevented, false);
    assert.equal(navigationKey(context, 'ArrowRight', { altKey: true, shiftKey: true }).prevented, false);
    assert.equal(state().selected, id('B'));
});

test('Alt+arrow keys inside a terminal or text field reach it, and the minimap keeps its own arrow keys', async () => {
    const { context, elements, id, state } = await navigationBoard({ cards: [['A', 0, 0], ['B', 700, 0]] });
    vm.runInContext(`select(${JSON.stringify(id('A'))})`, context);
    const terminal = vm.runInContext(`sessions.get(${JSON.stringify(id('A'))}).terminal`, context);
    const alt = { type: 'keydown', key: 'ArrowRight', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault() {}, stopPropagation() {} };
    assert.equal(terminal.keyHandler(alt), true, 'xterm sends Alt+arrow keys to the program');
    const inTerminal = navigationKey(context, 'ArrowRight', { altKey: true, target: insideTerminal(id('A')) });
    assert.equal(inTerminal.prevented, false);
    const inField = navigationKey(context, 'ArrowRight', { altKey: true, target: { closest: selector => (selector.includes('input') ? {} : null) } });
    assert.equal(inField.prevented, false);
    assert.equal(state().selected, id('A'));
    const camera = state().camera;
    elements.get('#minimap-map').dispatch('keydown', { key: 'ArrowLeft', altKey: true });
    assert.notDeepEqual(state().camera, camera, 'the focused minimap pans');
    assert.equal(state().selected, id('A'));
});

test('Enter types in the selected terminal, Ctrl+Shift+E leaves it, and clicking still types on the first click', async () => {
    const { context, elements, id, state } = await navigationBoard({ cards: [['A', 0, 0], ['B', 700, 0]] });
    navigationKey(context, 'ArrowRight', { altKey: true });
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().selected, id('B'));
    const enter = navigationKey(context, 'Enter');
    assert.equal(enter.prevented, true);
    assert.equal(state().typed[id('B')], 1);
    // Enter on a focused button belongs to that button.
    assert.equal(navigationKey(context, 'Enter', { target: { closest: selector => (selector.includes('button') ? {} : null) } }).prevented, false);
    assert.equal(state().typed[id('B')], 1);
    // Ctrl+Shift+E inside the terminal does not reach the shell and returns the keyboard to the board.
    const terminal = vm.runInContext(`sessions.get(${JSON.stringify(id('B'))}).terminal`, context);
    const leave = { type: 'keydown', key: 'E', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} };
    assert.equal(terminal.keyHandler(leave), false);
    assert.equal(terminal.keyHandler({ ...leave, ctrlKey: false, metaKey: true }), false, 'Command+Shift+E on macOS');
    assert.equal(terminal.keyHandler({ ...leave, altKey: true }), true, 'AltGr combinations still type');
    // The terminal the keyboard is in wins over the selection.
    vm.runInContext(`select(${JSON.stringify(id('A'))}, { type: false })`, context);
    const focusBefore = elements.get('#viewport').focusCount || 0;
    const event = navigationKey(context, 'E', { ctrlKey: true, shiftKey: true, target: insideTerminal(id('B')) });
    assert.equal(event.prevented, true);
    let now = state();
    assert.equal(now.selected, id('B'));
    assert.deepEqual(now.highlighted, [id('B')]);
    assert.equal(now.typed[id('B')], 1, 'leaving does not type');
    assert.ok(elements.get('#viewport').focusCount > focusBefore);
    // A click clears the keyboard highlight and still types on the first click (#2).
    vm.runInContext('document', context).listeners.get('pointerdown').forEach(handler => handler({ target: {} }));
    const cardA = vm.runInContext(`sessions.get(${JSON.stringify(id('A'))}).element`, context);
    cardA.dispatch('pointerdown');
    now = state();
    assert.deepEqual(now.highlighted, []);
    assert.equal(now.current, null);
    assert.equal(now.selected, id('A'));
    assert.equal(now.typed[id('A')], 1);
});

test('Enter on a stopped terminal moves to its Start button instead of starting it', async () => {
    const { context, calls, id, state } = await navigationBoard({ cards: [['A', 0, 0]], running: false });
    navigationKey(context, 'ArrowUp', { altKey: true });
    assert.equal(state().selected, id('A'));
    navigationKey(context, 'Enter');
    const toggle = vm.runInContext(`sessions.get(${JSON.stringify(id('A'))}).element.querySelector('[data-action="toggle"]')`, context);
    assert.equal(toggle.focusCount, 1);
    assert.equal(state().typed[id('A')], 0);
    assert.equal(calls.some(call => call.action === 'start'), false);
    // Holding Enter does not go on to press the Start button the first press moved to.
    const onToggle = { closest: selector => (selector.includes('button') ? {} : null) };
    assert.equal(navigationKey(context, 'Enter', { repeat: true, target: onToggle }).prevented, true);
    assert.equal(navigationKey(context, 'Enter', { target: onToggle }).prevented, false, 'a separate press reaches the button');
    assert.equal(calls.some(call => call.action === 'start'), false);
    // Enter with nothing selected does nothing.
    vm.runInContext('setSelection([])', context);
    assert.equal(navigationKey(context, 'Enter').prevented, false);
});

test('navigation on an empty canvas explains itself, and items and groups are valid starting points', async () => {
    const empty = await navigationBoard({ cards: [] });
    navigationKey(empty.context, 'ArrowRight', { altKey: true });
    assert.match(empty.elements.get('#toast').textContent, /no terminals/i);
    assert.equal(empty.state().selected, null);

    const { context, id, state } = await navigationBoard({
        cards: [['Left', 0, 0, { groups: ['pair'] }], ['Right', 1400, 0], ['Below', 1400, 600, { groups: ['pair'] }]],
        items: [note('n', 800, 100)]
    });
    // From a selected note, the nearest terminal to its right.
    vm.runInContext('select("n")', context);
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().selected, id('Right'));
    // From a note with nothing above it, the selection stays on the note.
    vm.runInContext('select("n")', context);
    navigationKey(context, 'ArrowUp', { altKey: true });
    assert.equal(state().selected, 'n');
    assert.deepEqual(state().highlighted, []);
    // Reaching a grouped terminal selects its group, with that terminal highlighted and primary.
    vm.runInContext(`select(${JSON.stringify(id('Right'))})`, context);
    navigationKey(context, 'ArrowLeft', { altKey: true });
    let now = state();
    assert.equal(now.selected, id('Left'));
    assert.deepEqual(now.selection.sort(), [id('Left'), id('Below')].sort());
    assert.deepEqual(now.highlighted, [id('Left')]);
    // A group moves from its primary terminal, not from the whole group's bounds.
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().selected, id('Right'));
});

test('in Focus mode Alt+arrow keys switch the focused terminal without typing, and Enter types in it', async () => {
    const { context, elements, id, state } = await navigationBoard({ cards: [['A', 0, 0], ['B', 3000, 0]] });
    vm.runInContext(`setFocus(${JSON.stringify(id('A'))})`, context);
    assert.equal(state().typed[id('A')], 1, 'opening Focus with the button still types');
    navigationKey(context, 'ArrowRight', { altKey: true });
    let now = state();
    assert.equal(now.focusedTerminal, id('B'));
    assert.equal(now.selected, id('B'));
    assert.deepEqual(now.highlighted, [id('B')]);
    assert.equal(now.typed[id('B')], 0);
    assert.deepEqual(now.camera, { x: 48, y: 48, z: 1 }, 'the canvas waits for its toolbars before panning');
    assert.equal(elements.get('#exit-focus').hidden, false);
    navigationKey(context, 'ArrowRight', { altKey: true });
    assert.equal(state().focusedTerminal, id('B'), 'no terminal further right');
    navigationKey(context, 'Enter');
    assert.equal(state().typed[id('B')], 1);
    // Back on the canvas, the terminal chosen in Focus mode is in view.
    elements.get('#exit-focus').onclick();
    now = state();
    assert.equal(now.focusedTerminal, null);
    assert.ok(now.camera.x + 3000 * now.camera.z >= 72 && now.camera.x + 3660 * now.camera.z <= 1100 - 24, JSON.stringify(now.camera));
    // Leaving Focus without having moved from the keyboard does not pan.
    const camera = now.camera;
    vm.runInContext(`setFocus(${JSON.stringify(id('A'))}); setFocus(null)`, context);
    assert.deepEqual(state().camera, camera);
});

test('a terminal revealed from the keyboard clears the minimap and toolbars', async () => {
    // B lies below A and to the right, so a plain reveal would bring it to the lower-right corner.
    const { context, id, state } = await navigationBoard({ cards: [['A', 0, 0], ['B', 500, 900]] });
    vm.runInContext(`select(${JSON.stringify(id('A'))}, { type: false })`, context);
    navigationKey(context, 'ArrowDown', { altKey: true });
    const { selected, camera } = state();
    assert.equal(selected, id('B'));
    assert.equal(camera.z, 1);
    const shown = { x: camera.x + 500, y: camera.y + 900, w: 660, h: 430 };
    const overlays = json(context, 'canvasOverlays()');
    assert.equal(overlays.length, 4, 'terminal selection now shows the style toolbar too');
    for (const box of overlays) assert.equal(vm.runInContext('Geometry', context).intersects(shown, box), false, JSON.stringify({ shown, box }));
    assert.ok(shown.x >= 24 && shown.y >= 24 && shown.x + shown.w <= 1100 - 24 && shown.y + shown.h <= 720 - 24, JSON.stringify(shown));
});

test('hook pointers configure and disarm through host validation, display status and strip automation from copied arrows', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ title: 'Planner' }), createCard({ title: 'Reviewer' }));
    board.items.push({ id: 'hook', type: 'line', arrow: true, start: { id: board.cards[0].id }, end: { id: board.cards[1].id } });
    const { context, elements, calls, onEvent } = await boot(board);
    vm.runInContext('select("hook")', context);
    assert.equal(elements.get('#pointer-configure').hidden, false);
    assert.equal(elements.get('#pointer-configure-label').textContent, 'Add automation');
    elements.get('#pointer-configure').onclick();
    assert.equal(elements.get('#pointer-dialog').open, true);
    assert.equal(elements.get('#pointer-description').textContent, 'Planner → Reviewer');
    elements.get('#pointer-text').value = 'Review the implementation';
    elements.get('#pointer-form').dispatch('submit', { submitter: elements.get('#pointer-save-disabled') });
    await flush();
    assert.equal(json(context, 'workspace.items[0].hook.armed'), false);
    assert.equal(elements.get('#pointer-status').textContent, 'Disabled');
    assert.equal(elements.get('#pointer-configure-label').textContent, 'Edit automation');
    elements.get('#pointer-configure').onclick();
    assert.equal(elements.get('#pointer-text').value, 'Review the implementation');
    elements.get('#pointer-form').dispatch('submit', { submitter: elements.get('#pointer-submit') });
    await new Promise(resolve => setImmediate(resolve));
    const configured = calls.findLast(call => call.action === 'pointer-configure');
    assert.equal(configured.payload.id, 'hook'); assert.equal(configured.payload.hook.armed, true);
    assert.equal(json(context, 'workspace.items[0].hook.text'), 'Review the implementation');
    assert.equal(elements.get('#pointers-pause').hidden, false);
    assert.equal(elements.get('#pointer-status').textContent, 'Waiting for Planner');
    onEvent({ type: 'pointer', id: 'hook', state: 'queued', message: 'Waiting for Stop.' });
    assert.equal(elements.get('#pointer-status').textContent, 'Queued until Reviewer finishes (up to 60 seconds)');
    onEvent({ type: 'pointer', id: 'hook', state: 'firing', message: 'Delivered.' });
    assert.equal(json(context, 'itemViews.get("hook").element.dataset.pointerState'), 'firing');
    assert.match(elements.get('#pointer-status').textContent, /Delivered/);
    assert.equal(vm.runInContext('itemViews.get("hook").element.classList.contains("pointer-flash")', context), true);
    assert.equal(vm.runInContext('clipboardItems()[0].hook', context), undefined);
    elements.get('#pointer-toggle').onclick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(json(context, 'workspace.items[0].hook.armed'), false);
    elements.get('#pointers-pause').onclick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(json(context, 'workspace.hooksPaused'), true);
    assert.equal(elements.get('#pointers-pause').textContent, 'Resume automations');
    assert.equal(elements.get('#pointer-status').textContent, 'Disabled');
});

test('automation editor reveals relevant options, copies a named trigger, and checks setup without saving', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ title: 'Planner' }), createCard({ title: 'Build' }));
    board.items.push({ id: 'hook', type: 'line', arrow: true, start: { id: board.cards[0].id }, end: { id: board.cards[1].id } });
    const { context, elements, calls } = await boot(board, { respond: action => action === 'pointer-check' ? {
        source: 'The terminal can accept manual triggers.', target: 'The shell is idle and can run a command.'
    } : null });
    vm.runInContext('select("hook")', context);
    elements.get('#pointer-configure').onclick();
    const event = elements.get('#pointer-event'), action = elements.get('#pointer-action');
    assert.equal(elements.get('#pointer-filter-field').hidden, true);
    assert.equal(elements.get('#pointer-name-field').hidden, true);
    assert.equal(elements.get('#pointer-context-field').hidden, false);
    event.value = 'exit'; event.onchange();
    assert.equal(elements.get('#pointer-filter-field').hidden, false);
    elements.get('#pointer-filter').value = 'failure';
    event.value = 'trigger'; event.onchange();
    assert.equal(elements.get('#pointer-filter-field').hidden, true);
    assert.equal(elements.get('#pointer-name-field').hidden, false);
    const name = elements.get('#pointer-name');
    name.value = 'reviewed;'; name.oninput(); name.onblur();
    assert.equal(elements.get('#pointer-copy').disabled, true);
    assert.equal(name.attributes.get('aria-invalid'), 'true');
    name.value = 'reviewed'; name.oninput();
    assert.equal(name.attributes.has('aria-invalid'), false);
    assert.equal(elements.get('#pointer-command').textContent, '& $env:TC_HOOK trigger reviewed');
    const shell = elements.get('#pointer-shell');
    shell.value = 'bash'; shell.onchange();
    await elements.get('#pointer-copy').onclick();
    assert.equal(calls.find(call => call.action === 'clipboard-write').payload, '"$TC_HOOK" trigger reviewed');
    action.value = 'shell'; action.onchange();
    assert.equal(elements.get('#pointer-text-label').textContent, 'Command');
    assert.equal(elements.get('#pointer-context-field').hidden, true);
    await elements.get('#pointer-check-setup').onclick();
    const check = calls.find(call => call.action === 'pointer-check');
    assert.deepEqual(JSON.parse(JSON.stringify(check.payload)), {
        source: board.cards[0].id, target: board.cards[1].id, event: 'trigger', action: 'shell'
    });
    assert.match(elements.get('#pointer-setup-status').children[1].textContent, /Build · The shell is idle/);
    const text = elements.get('#pointer-text');
    text.value = 'echo first\necho second';
    elements.get('#pointer-form').dispatch('submit', { submitter: elements.get('#pointer-save-disabled') });
    assert.equal(text.attributes.get('aria-invalid'), 'true');
    assert.match(elements.get('#pointer-text-error').textContent, /single-line command/);
    assert.equal(calls.some(call => call.action === 'pointer-configure'), false);
    action.value = 'new-terminal'; action.onchange();
    assert.equal(elements.get('#pointer-setup-status').hidden, true);
    text.value = 'echo okay'; text.oninput();
    elements.get('#pointer-form').dispatch('submit', { submitter: elements.get('#pointer-save-disabled') });
    await flush();
    assert.deepEqual(json(context, 'workspace.items[0].hook'), {
        event: 'trigger', action: 'new-terminal', text: 'echo okay', armed: false, filter: 'any', name: 'reviewed', context: false
    });
});

test('prompt automation saves a provider and model or uses the running session', async () => {
    const board = createWorkspace();
    board.cards.push(createCard({ title: 'Planner' }), createCard({ title: 'Reviewer' }));
    board.items.push({ id: 'hook', type: 'line', arrow: true, start: { id: board.cards[0].id }, end: { id: board.cards[1].id } });
    const { context, elements, calls } = await boot(board);
    vm.runInContext('select("hook")', context);
    const provider = elements.get('#pointer-provider'), model = elements.get('#pointer-model');
    elements.get('#pointer-configure').onclick();
    assert.equal(provider.value, '');
    assert.equal(elements.get('#pointer-model-field').hidden, true);
    provider.value = 'claude'; provider.onchange();
    assert.equal(elements.get('#pointer-model-field').hidden, false);
    assert.equal(model.attributes.get('list'), 'pointer-claude-models');
    const form = elements.get('#pointer-form'), submitter = elements.get('#pointer-submit');
    elements.get('#pointer-text').value = 'Review the change';
    model.value = '--version';
    form.dispatch('submit', { submitter });
    assert.equal(model.attributes.get('aria-invalid'), 'true');
    assert.equal(calls.some(call => call.action === 'pointer-configure'), false);
    model.value = 'sonnet[1m]'; model.oninput();
    form.dispatch('submit', { submitter });
    await flush();
    assert.equal(json(context, 'workspace.items[0].hook.model'), 'sonnet[1m]');
    assert.equal(json(context, 'workspace.items[0].hook.provider'), 'claude');
    elements.get('#pointer-configure').onclick();
    assert.equal(model.value, 'sonnet[1m]');
    provider.value = 'codex'; provider.onchange();
    assert.equal(model.value, '');
    assert.equal(model.attributes.get('list'), 'pointer-codex-models');
    provider.value = ''; provider.onchange();
    form.dispatch('submit', { submitter });
    await flush();
    const hook = json(context, 'workspace.items[0].hook');
    assert.equal(hook.provider, undefined);
    assert.equal(hook.model, undefined);
});

test('rejected hook configuration leaves the arrow plain and explains the host error', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    board.items.push({ id: 'hook', type: 'line', arrow: true, start: { id: board.cards[0].id }, end: { id: board.cards[1].id } });
    const { context, elements } = await boot(board, { respond: action => action === 'pointer-configure' ? { error: 'Hook pointers cannot form a cycle.' } : null });
    vm.runInContext('select("hook")', context); elements.get('#pointer-configure').onclick();
    elements.get('#pointer-text').value = 'Review'; elements.get('#pointer-form').dispatch('submit');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext('workspace.items[0].hook', context), undefined);
    assert.equal(elements.get('#pointer-dialog').open, true);
    assert.equal(elements.get('#pointer-error').textContent, 'Hook pointers cannot form a cycle.');
});

test('pointer configuration stays current through layout undo, and deleted automation does not return', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    board.items.push({ id: 'hook', type: 'line', arrow: true, start: { id: board.cards[0].id }, end: { id: board.cards[1].id }, hook: { event: 'stop', action: 'prompt', text: 'Review', armed: true } });
    const { context } = await boot(board);
    vm.runInContext('select("hook"); recordChange(() => workspace.items[0].color = "blue"); workspace.items[0].hook.armed = false; undo();', context);
    assert.equal(json(context, 'workspace.items[0].hook.armed'), false);
    vm.runInContext('recordChange(() => removeItems(["hook"])); undo()', context);
    assert.equal(vm.runInContext('workspace.items[0].hook', context), undefined);
});

function switcherState(context) {
    return json(context, '({ active: switcherActive, matches: switcherMatches, query: switcherQuery.value, open: terminalSwitcher.open })');
}

test('hook configuration preserves hidden canvases and global pause survives navigation and reload', async () => {
    const board = twoCanvases(), extra = createCard();
    board.cards.push(extra); board.canvases[1].cardIds.push(extra.id);
    board.items.push({ id: 'background-hook', type: 'line', arrow: true,
        start: { id: board.cards[1].id }, end: { id: extra.id },
        hook: { event: 'trigger', action: 'shell', text: 'echo done', armed: true } });
    board.canvases[1].itemIds.push('background-hook');
    const { context, elements, calls, onEvent } = await boot(board);
    assert.equal(elements.get('#pointers-pause').hidden, false, 'hidden hooks remain pausable');
    onEvent({ type: 'pointer', id: 'background-hook', state: 'failed', message: 'Target is stopped.' });
    assert.equal(json(context, 'pointerStates.get("background-hook").state'), 'failed');
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-0');
    elements.get('#pointers-pause').onclick(); await flush();
    const configured = calls.find(call => call.action === 'pointer-configure');
    assert.equal(configured.payload.workspace.cards.length, 3);
    assert.equal(configured.payload.workspace.canvases.length, 2);
    vm.runInContext('switchCanvas("canvas-1"); select("background-hook")', context);
    assert.equal(json(context, 'workspace.hooksPaused'), true);
    assert.equal(elements.get('#pointers-pause').textContent, 'Resume automations');
    assert.equal(elements.get('#pointer-status').textContent, 'Paused across all canvases');
    assert.equal(json(context, 'workspace.items[0].hook.armed'), true);
    assert.equal(json(context, 'itemViews.get("background-hook").element.dataset.pointerState'), 'paused');
    const saved = json(context, 'workspaceSnapshot()');
    assert.equal(saved.hooksPaused, true);
    context.savedHooks = saved;
    vm.runInContext('loadWorkspace(savedHooks); createCanvas("Paused too")', context);
    assert.equal(json(context, 'workspace.hooksPaused'), true);
    elements.get('#pointers-pause').onclick(); await flush();
    assert.equal(vm.runInContext('canvasStates.some(canvas => canvas.board.hooksPaused)', context), false);
});

test('browser viewer pointer controls stay unavailable and follow the desktop global pause', async () => {
    const board = createWorkspace(); board.cards.push(createCard(), createCard());
    board.items.push({ id: 'hook', type: 'line', arrow: true,
        start: { id: board.cards[0].id }, end: { id: board.cards[1].id },
        hook: { event: 'trigger', action: 'shell', text: 'echo done', armed: true } });
    const { context, elements, calls, onEvent } = await boot(board, { remote: true, role: 'view' });
    vm.runInContext('select("hook")', context);
    for (const id of ['#pointer-configure', '#pointer-toggle', '#pointers-pause']) assert.equal(elements.get(id).hidden, true);
    await assert.rejects(vm.runInContext('savePointerChange(null, null, true)', context), /read-only/);
    const paused = structuredClone(board); paused.hooksPaused = true;
    onEvent({ type: 'remote-workspace', workspace: paused });
    assert.equal(json(context, 'workspace.hooksPaused'), true);
    assert.equal(calls.some(call => call.action === 'pointer-configure'), false);
});
function switcherSearch(elements, value) {
    const query = elements.get('#switcher-query'); query.value = value; query.oninput();
}

test('terminal switcher follows the active canvas and waits for canvas mutations', async () => {
    const board = twoCanvases(), { context, elements, calls } = await boot(board, { terminals: true });
    vm.runInContext('canvasMutation = true', context);
    assert.equal(vm.runInContext('openTerminalSwitcher()', context), false);
    vm.runInContext('canvasMutation = false; openTerminalSwitcher()', context);
    assert.deepEqual(switcherState(context).matches, [board.cards[0].id]);
    switcherSearch(elements, 'Background');
    assert.deepEqual(switcherState(context).matches, [], 'hidden canvases keep running outside this canvas search');
    vm.runInContext('terminalSwitcher.close(); switchCanvas("canvas-1"); openTerminalSwitcher()', context);
    assert.deepEqual(switcherState(context).matches, [board.cards[1].id]);
    context.oldCanvasId = board.cards[0].id;
    vm.runInContext('confirmTerminalSwitch(oldCanvasId)', context);
    assert.equal(switcherState(context).open, true, 'an ID from the previous canvas cannot be confirmed');
    vm.runInContext('confirmTerminalSwitch()', context);
    assert.equal(switcherState(context).open, false);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
    assert.equal(json(context, 'selected'), board.cards[1].id);
    assert.equal(json(context, 'sessions.size'), 2);
    assert.deepEqual(calls.map(call => call.action), ['initialize'], 'switching and searching never launch shells');
});

test('switcher reveals a distant terminal at the wheel zoom and canvas scrolling resumes afterward', async () => {
    const board = createWorkspace();
    board.cards.push(createCard({ title: 'Nearby' }), createCard({ title: 'Distant', x: 2400 }));
    const h = await boot(board), wheel = canvasWheel(h);
    wheel();
    const zoomed = json(h.context, 'workspace.camera.z');
    assert.ok(zoomed > board.camera.z);
    vm.runInContext('openTerminalSwitcher()', h.context);
    switcherSearch(h.elements, 'Distant');
    h.elements.get('#terminal-switcher').dispatch('keydown', { key: 'Enter' });
    assert.equal(switcherState(h.context).open, false);
    assert.equal(json(h.context, 'selected'), board.cards[1].id);
    assert.equal(json(h.context, 'workspace.camera.z'), zoomed);
    const revealed = json(h.context, 'workspace.camera');
    assert.ok(revealed.x < 0, 'the distant terminal is brought into view');
    assert.equal(wheel({ deltaY: 100, timeStamp: 300 }).defaultPrevented, true);
    assert.ok(json(h.context, 'workspace.camera.z') < zoomed);
    assert.equal(json(h.context, 'selected'), board.cards[1].id);
    assert.deepEqual(h.calls.map(call => call.action), ['initialize'], 'navigation starts no commands');
});

test('switcher live titles and reveal preserve terminal colors, themes, and running instances', async () => {
    const board = createWorkspace(); board.terminalTheme = 'midnight'; board.camera.z = .65;
    board.cards.push(createCard({ title: 'Task one', color: 'purple' }), createCard({ title: 'Task two', titleMode: 'automatic', color: 'red', theme: 'paper', x: 2400 }));
    const { context, elements, calls, onEvent } = await boot(board, { terminals: true });
    const live = Array.from(vm.runInContext('[...sessions.values()]', context)), terminals = live.map(s => s.terminal);
    for (const s of live) { s.status = 'running'; s.terminal.selection = 'kept output'; }
    vm.runInContext('openTerminalSwitcher()', context);
    switcherSearch(elements, 'task');
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'ArrowDown' });
    const active = switcherState(context).active;
    assert.equal(active, board.cards[1].id);
    onEvent({ type: 'title', id: active, title: 'Task renamed', titleMode: 'automatic', titleRevision: 1 });
    assert.equal(switcherState(context).active, active);
    assert.equal(switcherState(context).query, 'task');
    assert.equal(elements.get('#switcher-results').children[1].children[1].children[0].textContent, 'Task renamed');
    assert.equal(live[1].element.querySelector('.card-title').attributes.get('aria-label'), 'Rename terminal: Task renamed');
    const minimap = elements.get('#minimap-cards').children;
    assert.deepEqual(minimap.map(node => node.title), ['Task one', 'Task renamed']);
    assert.ok(minimap[0].classList.contains('color-purple'));
    assert.ok(minimap[1].classList.contains('color-red'));
    assert.ok(elements.get('#outline').children[1].classList.contains('color-red'));
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Enter' });
    assert.equal(json(context, 'selected'), active);
    assert.equal(json(context, 'workspace.camera.z'), .65);
    assert.equal(elements.get('#terminal-theme').value, 'paper');
    assert.ok(live[1].element.classList.contains('color-red'));
    assert.deepEqual(live.map(s => s.terminal.options.theme.background), ['#101827', '#faf7f0']);
    for (let i = 0; i < live.length; i++) {
        assert.equal(live[i].terminal, terminals[i]);
        assert.equal(terminals[i].selection, 'kept output');
        assert.equal(live[i].status, 'running');
    }
    assert.deepEqual(calls.map(call => call.action), ['initialize']);
});

test('switcher searches automatic title events live and honors manual precedence and stale revisions', async () => {
    const board = createWorkspace();
    const automatic = createCard({ title: 'repo · Codex', titleMode: 'automatic' });
    const manual = createCard({ title: 'Manual task', titleMode: 'manual' });
    board.cards.push(automatic, manual);
    const { context, elements, onEvent, document } = await boot(board, {
        respond: (action, payload) => action === 'rename-title'
            ? { card: { title: payload.title, titleMode: payload.mode, titleRevision: 3 } } : null
    });
    vm.runInContext('openTerminalSwitcher()', context);
    switcherSearch(elements, 'fix ไทย');
    assert.deepEqual(switcherState(context).matches, []);
    const event = { type: 'title', id: automatic.id, title: 'Fix ไทย <task>', titleMode: 'automatic', titleRevision: 1 };
    onEvent(event);
    assert.deepEqual(switcherState(context).matches, [automatic.id]);
    assert.equal(elements.get('#switcher-results').children[0].children[1].children[0].textContent, event.title);
    assert.equal(switcherState(context).active, automatic.id);
    assert.equal(switcherState(context).query, 'fix ไทย');
    assert.equal(document.activeElement, elements.get('#switcher-query'));
    onEvent({ ...event, title: 'Stale', titleRevision: 0 });
    onEvent({ ...event, id: manual.id, titleRevision: 9 });
    assert.deepEqual(switcherState(context).matches, [automatic.id]);
    onEvent({ ...event, title: 'Another task', titleRevision: 2 });
    assert.deepEqual(switcherState(context).matches, []);
    switcherSearch(elements, 'another');
    assert.deepEqual(switcherState(context).matches, [automatic.id]);
    await vm.runInContext('renameTerminal(workspace.cards[0], "manual", "My task")', context);
    assert.deepEqual(switcherState(context).matches, []);
    switcherSearch(elements, 'my task');
    onEvent({ ...event, title: 'Late generated task', titleRevision: 4 });
    assert.deepEqual(switcherState(context).matches, [automatic.id]);
    assert.equal(elements.get('#switcher-results').children[0].children[1].children[0].textContent, 'My task');
    assert.equal(document.activeElement, elements.get('#switcher-query'));
});

test('switcher shortcut works with a collapsed sidebar and restores focus without changing sidebar preferences', async () => {
    const { context, elements, document } = await navigationBoard({ cards: [['Shell', 0, 0]] });
    elements.get('#outline-toggle').click();
    elements.get('#sidebar-toggle').click();
    elements.get('#viewport').focus();
    const preferences = json(context, 'sidebarPreferences');
    navigationKey(context, 'P', { ctrlKey: true, shiftKey: true });
    assert.equal(switcherState(context).open, true);
    assert.equal(document.activeElement, elements.get('#switcher-query'));
    assert.equal(elements.get('#sidebar').hidden, true);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Escape' });
    assert.equal(document.activeElement, elements.get('#viewport'));
    assert.deepEqual(json(context, 'sidebarPreferences'), preferences);
    assert.equal(elements.get('#outline-section').hidden, true);
    assert.equal(elements.get('#sidebar').hidden, true);
});

test('switcher shortcut and accessible button focus the query without taking Ctrl+P, slash, or Focus shortcuts', async () => {
    const { context, elements, id, state } = await navigationBoard({ cards: [['Shell', 0, 0], ['Codex', 2000, 0]] });
    vm.runInContext(`select(${JSON.stringify(id('Codex'))}, { type: false })`, context);
    assert.equal(navigationKey(context, 'p', { ctrlKey: true }).prevented, false);
    assert.equal(navigationKey(context, 'P', { ctrlKey: true, shiftKey: true, altKey: true }).prevented, false);
    assert.equal(navigationKey(context, 'P', { ctrlKey: true, shiftKey: true }).prevented, true);
    assert.equal(switcherState(context).open, true);
    assert.equal(switcherState(context).active, id('Codex'));
    assert.equal(elements.get('#switcher-query').focusCount, 1);
    const terminal = vm.runInContext(`sessions.get(${JSON.stringify(id('Shell'))}).terminal`, context);
    const key = { type: 'keydown', key: 'P', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false };
    assert.equal(terminal.keyHandler(key), false);
    assert.equal(terminal.keyHandler({ ...key, ctrlKey: false, metaKey: true }), false);
    assert.equal(terminal.keyHandler({ ...key, shiftKey: false }), true);
    // App shortcuts are inert while the switcher is modal.
    navigationKey(context, 'F', { ctrlKey: true, shiftKey: true });
    assert.equal(state().focusedTerminal, null);
    elements.get('#switcher-close').onclick();
    navigationKey(context, '/');
    assert.equal(elements.get('#search').focusCount, 1);
    elements.get('#find-terminal').onclick();
    assert.equal(switcherState(context).open, true);
    elements.get('#terminal-switcher').close();
    navigationKey(context, 'P', { metaKey: true, shiftKey: true });
    assert.equal(switcherState(context).open, true);
});

test('switcher keyboard confirmation reveals a duplicate title by ID at the same zoom and Enter separately types', async () => {
    const { context, elements, state } = await navigationBoard({ cards: [['Shell', 0, 0], ['Shell', 2200, 0]], camera: { x: 100, y: 48, z: .65 } });
    const ids = json(context, 'workspace.cards.map(card => card.id)');
    vm.runInContext('openTerminalSwitcher()', context);
    const dialog = elements.get('#terminal-switcher'), query = elements.get('#switcher-query');
    assert.deepEqual(switcherState(context).matches, ids);
    dialog.dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(switcherState(context).active, ids[1], 'arrows wrap in sidebar order');
    assert.equal(query.attributes.get('aria-activedescendant'), `switcher-option-${ids[1]}`);
    const options = elements.get('#switcher-results').children;
    assert.equal(options[1].attributes.get('aria-selected'), 'true');
    assert.match(options[1].title, new RegExp(ids[1]));
    const before = state();
    assert.equal(before.selected, null, 'browsing does not select or pan');
    let stopped = false, prevented = false;
    dialog.dispatch('keydown', { key: 'Enter', stopPropagation() { stopped = true; }, preventDefault() { prevented = true; } });
    assert.equal(stopped && prevented, true);
    assert.equal(switcherState(context).open, false);
    const now = state();
    assert.equal(now.selected, ids[1]);
    assert.deepEqual(now.highlighted, [ids[1]]);
    assert.equal(now.camera.z, .65);
    assert.ok(now.camera.x < before.camera.x);
    assert.deepEqual(Object.values(now.typed), [0, 0]);
    assert.equal(query.attributes.has('aria-activedescendant'), false);
    assert.equal(query.attributes.get('aria-expanded'), 'false');
    navigationKey(context, 'Enter', { repeat: true });
    assert.equal(state().typed[ids[1]], 0, 'a held confirmation never starts typing');
    navigationKey(context, 'Enter');
    assert.equal(state().typed[ids[1]], 1);
});

test('switcher and sidebar share case-insensitive title, live folder, and profile filtering without AI', async () => {
    const { context, elements, id, onEvent } = await navigationBoard({ cards: [['Default shell', 0, 0, { cwd: '/one' }], ['Manual API', 700, 0, { profile: 'codex', cwd: '/repo' }]] });
    vm.runInContext('openTerminalSwitcher()', context);
    switcherSearch(elements, ' API   CODEX ');
    assert.deepEqual(switcherState(context).matches, [id('Manual API')]);
    const search = elements.get('#search'); search.value = 'api codex'; search.oninput();
    assert.equal(elements.get('#outline').children.length, 1);
    onEvent({ type: 'cwd', id: id('Manual API'), cwd: '/Live/Folder' });
    switcherSearch(elements, 'live/folder');
    assert.deepEqual(switcherState(context).matches, [id('Manual API')]);
    switcherSearch(elements, 'default');
    assert.deepEqual(switcherState(context).matches, [id('Default shell')]);
    switcherSearch(elements, '<script>');
    assert.deepEqual(switcherState(context).matches, []);
    assert.equal(elements.get('#switcher-status').textContent, 'No matching terminals.');
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Enter' });
    assert.equal(switcherState(context).open, true);
    assert.equal(elements.get('#switcher-query').attributes.has('aria-activedescendant'), false);
});

test('open switcher preserves query and active ID through effective-title changes, creation, and removal', async () => {
    const { context, elements } = await navigationBoard({ cards: [['Task one', 0, 0], ['Task two', 700, 0], ['Other', 1400, 0]] });
    vm.runInContext('openTerminalSwitcher()', context);
    switcherSearch(elements, 'task');
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'ArrowDown' });
    const active = switcherState(context).active;
    // #28's effective-title integration contract: update card.title after precedence, then refresh.
    vm.runInContext(`findCard(${JSON.stringify(active)}).title = 'Task generated <title>'; refresh()`, context);
    assert.equal(switcherState(context).active, active);
    assert.equal(switcherState(context).query, 'task');
    assert.equal(elements.get('#switcher-results').children[1].children[1].children[0].textContent, 'Task generated <title>');
    assert.equal(vm.runInContext(`sessions.get(${JSON.stringify(active)}).element.querySelector('.card-title').textContent`, context), 'Task generated <title>');
    const added = createCard({ title: 'Task new' }); context.newCard = added;
    vm.runInContext('workspace.cards.push(newCard); mount(newCard); refresh()', context);
    assert.equal(switcherState(context).active, active);
    assert.equal(switcherState(context).matches.length, 3);
    vm.runInContext(`removeCard(findCard(${JSON.stringify(active)}))`, context);
    assert.equal(switcherState(context).active, added.id, 'the next surviving result keeps the same row');
    vm.runInContext(`findCard(${JSON.stringify(added.id)}).title = 'Renamed'; refresh()`, context);
    assert.equal(switcherState(context).matches.length, 1);
    assert.equal(elements.get('#switcher-query').ownerDocument.activeElement, elements.get('#switcher-query'), 'live updates leave typing in the query');
    // A stale pointer click must not jump to a removed target or close the switcher.
    vm.runInContext(`confirmTerminalSwitch(${JSON.stringify(active)})`, context);
    assert.equal(switcherState(context).open, true);
    assert.equal(switcherState(context).query, 'task');
});

test('switcher cancellation restores prior focus and selection or falls back when the opener disappears', async () => {
    const { context, elements, document, state } = await navigationBoard({ cards: [['A', 0, 0], ['B', 700, 0]] });
    const opener = elements.get('#workspace-name'); opener.focus();
    const before = state();
    vm.runInContext('openTerminalSwitcher()', context);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'ArrowDown' });
    let interceptedButton = false;
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Enter', target: { closest: selector => selector === 'button' ? {} : null }, preventDefault() { interceptedButton = true; } });
    assert.equal(interceptedButton, false, 'the close button keeps its native Enter activation');
    assert.equal(switcherState(context).open, true);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Escape' });
    assert.equal(document.activeElement, opener);
    assert.deepEqual(state(), before);
    vm.runInContext('openTerminalSwitcher()', context);
    opener.isConnected = false;
    elements.get('#terminal-switcher').dispatch('cancel');
    assert.equal(document.activeElement, elements.get('#viewport'));
    assert.equal(switcherState(context).open, false);
});

test('switcher handles an empty canvas, stopped targets, pointer confirmation, and Focus mode without starting commands', async () => {
    const empty = await navigationBoard({ cards: [] });
    vm.runInContext('openTerminalSwitcher()', empty.context);
    assert.match(empty.elements.get('#switcher-status').textContent, /no terminals/i);
    empty.elements.get('#terminal-switcher').dispatch('keydown', { key: 'ArrowDown' });
    empty.elements.get('#terminal-switcher').dispatch('keydown', { key: 'Enter' });
    assert.equal(switcherState(empty.context).open, true);
    const { context, elements, id, state, calls } = await navigationBoard({ cards: [['A', 0, 0], ['B', 3000, 0]], running: false });
    vm.runInContext(`setFocus(${JSON.stringify(id('A'))}, { type: false }); openTerminalSwitcher()`, context);
    elements.get('#switcher-results').children[1].onclick();
    assert.equal(state().focusedTerminal, id('B'));
    assert.equal(state().selected, id('B'));
    navigationKey(context, 'Enter');
    assert.equal(vm.runInContext(`sessions.get(${JSON.stringify(id('B'))}).element.querySelector('[data-action="toggle"]').focusCount`, context), 1);
    assert.equal(calls.some(call => call.action === 'start'), false);
    elements.get('#exit-focus').onclick();
    assert.ok(state().camera.x < 0, 'Focus defers the reveal until returning to the canvas');
});

const AGENT_TARGETS = [
    { id: 'claude', name: 'Claude Code', folders: ['C:\Users\me\.claude\skills'], detected: ['Claude Code'], status: 'missing' },
    { id: 'agents', name: 'Codex, Gemini CLI, opencode, and other agents', folders: ['C:\Users\me\.agents\skills'], detected: [], status: 'missing' },
];
const agentRows = elements => elements.get('#agent-targets').children;
const agentBox = row => row.children[0];

test('agent setup and terminal search keep each other modal and remain available after closing', async () => {
    const board = createWorkspace(); board.cards.push(createCard({ title: 'Shell' }));
    const { context, elements, calls } = await boot(board, { respond: action => action === 'agent-setup' ? { targets: structuredClone(AGENT_TARGETS) } : null });
    elements.get('#agent-setup').onclick(); await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    navigationKey(context, 'P', { ctrlKey: true, shiftKey: true });
    assert.equal(!!switcherState(context).open, false);
    elements.get('#agent-dialog').close();
    elements.get('#find-terminal').onclick();
    assert.equal(switcherState(context).open, true);
    const setupCalls = () => calls.filter(call => call.action === 'agent-setup').length;
    const before = setupCalls();
    elements.get('#agent-setup').onclick(); await flush();
    assert.equal(setupCalls(), before, 'search blocks setup before any host request');
    assert.equal(elements.get('#agent-dialog').open, false);
    elements.get('#terminal-switcher').dispatch('keydown', { key: 'Escape' });
    elements.get('#agent-setup').onclick(); await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    assert.equal(setupCalls(), before + 1);
});

test('the first launch offers the agent setup once and declining it is remembered', async () => {
    const respond = (action, payload) => action === 'initialize'
        ? { workspace: createWorkspace(), profiles: PROFILES, home: '', platform: 'win32', agentSetup: true }
        : action === 'agent-setup' ? { targets: structuredClone(AGENT_TARGETS) } : null;
    const { calls, elements } = await boot(createWorkspace(), { respond });
    await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    assert.deepEqual(agentRows(elements).map(row => agentBox(row).value), ['claude', 'agents']);
    assert.deepEqual(agentRows(elements).map(row => agentBox(row).checked), [true, false], 'what this computer uses is preselected');
    assert.match(agentRows(elements)[1].children[1].children[1].textContent, /Not found/);
    // Not now, the close button, and Escape all close the dialog; each declines the offer.
    elements.get('#agent-dialog').close(); elements.get('#agent-dialog').dispatch('close'); await flush();
    assert.deepEqual(structuredClone(calls.filter(c => c.action === 'agent-setup').map(c => c.payload)), [{}, { dismiss: true }]);
    // Reopened from the sidebar, closing it records nothing more.
    elements.get('#agent-setup').onclick(); await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    elements.get('#agent-dialog').close(); elements.get('#agent-dialog').dispatch('close'); await flush();
    assert.deepEqual(structuredClone(calls.filter(c => c.action === 'agent-setup').map(c => c.payload)), [{}, { dismiss: true }, {}]);
});

test('Settings › Set up AI agents installs the skill where the user chose and reports failures in the dialog', async () => {
    let fail = true;
    const targets = structuredClone(AGENT_TARGETS);
    targets[0].status = 'current'; targets[1].detected = ['Codex']; targets[1].status = 'outdated';
    const respond = (action, payload) => action !== 'agent-setup' ? null
        : payload.install && fail ? { error: 'Could not install the skill in C:\Users\me\.agents\skills\terminal-canvas\SKILL.md: Access is denied.' }
            : { targets, installed: payload.install || [] };
    const { calls, elements } = await boot(createWorkspace(), { respond });
    assert.deepEqual(calls.map(c => c.action), ['initialize'], 'the setup is not offered after the first launch');
    // The footer's gear opens the Settings menu, whose first item is the agent setup.
    elements.get('#settings-menu').hidden = true; // as the markup starts it
    elements.get('#settings').onclick();
    assert.equal(elements.get('#settings-menu').hidden, false);
    assert.equal(elements.get('#settings').attributes.get('aria-expanded'), 'true');
    elements.get('#settings').onclick();
    assert.equal(elements.get('#settings-menu').hidden, true, 'the gear also closes it');
    elements.get('#settings').onclick();
    elements.get('#settings-menu').dispatch('keydown', { key: 'Escape' });
    assert.equal(elements.get('#settings-menu').hidden, true, 'Escape closes it');
    elements.get('#settings').onclick();
    elements.get('#agent-setup').onclick(); await flush();
    assert.equal(elements.get('#settings-menu').hidden, true, 'choosing an item closes it');
    assert.equal(elements.get('#settings').attributes.get('aria-expanded'), 'false');
    assert.equal(elements.get('#agent-dialog').open, true);
    assert.deepEqual(agentRows(elements).map(row => agentBox(row).checked), [false, true], 'installed copies are not preselected');
    assert.equal(agentRows(elements)[1].children[1].children[0].children[1].textContent, 'UPDATE');
    agentBox(agentRows(elements)[0]).checked = true;
    elements.get('#agent-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    assert.equal(elements.get('#agent-error').hidden, false);
    assert.match(elements.get('#agent-error').textContent, /Access is denied/);
    fail = false;
    elements.get('#agent-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(elements.get('#agent-dialog').open, false);
    assert.deepEqual(structuredClone(calls.filter(c => c.action === 'agent-setup').map(c => c.payload)).slice(1), [{ install: ['claude', 'agents'] }, { install: ['claude', 'agents'] }]);
    assert.match(elements.get('#toast').textContent, /installed for Claude Code and Codex, Gemini CLI, opencode, and other agents/);
    // Nothing chosen only closes the dialog.
    elements.get('#agent-setup').onclick(); await flush();
    agentRows(elements).forEach(row => { agentBox(row).checked = false; });
    elements.get('#agent-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(elements.get('#agent-dialog').open, false);
    assert.equal(calls.filter(c => c.action === 'agent-setup').length, 4);
});


const TMUX_MISSING = {
    installed: false, path: null, version: null, minimum: '3.3', manager: 'winget and MSYS2',
    command: "winget install --id MSYS2.MSYS2 -e; & 'C:\\msys64\\usr\\bin\\bash.exe' -lc 'pacman -Sy --noconfirm --needed tmux util-linux'",
};
const tmuxPayloads = calls => structuredClone(calls.filter(c => c.action === 'tmux-setup').map(c => c.payload));

test('the first launch offers tmux after the agent setup closes, once, and declining it is remembered', async () => {
    const respond = action => action === 'initialize'
        ? { workspace: createWorkspace(), profiles: PROFILES, home: '', platform: 'win32', agentSetup: true, tmuxSetup: true }
        : action === 'agent-setup' ? { targets: structuredClone(AGENT_TARGETS) }
            : action === 'tmux-setup' ? structuredClone(TMUX_MISSING) : null;
    const { calls, elements } = await boot(createWorkspace(), { respond });
    await flush();
    assert.equal(elements.get('#agent-dialog').open, true);
    assert.equal(!!elements.get('#tmux-dialog').open, false, 'one dialog at a time');
    assert.deepEqual(tmuxPayloads(calls), []);
    elements.get('#agent-dialog').close(); await flush();
    assert.equal(elements.get('#tmux-dialog').open, true);
    assert.equal(elements.get('#tmux-status').textContent, 'tmux is not installed.');
    assert.equal(elements.get('#tmux-command').textContent, TMUX_MISSING.command);
    assert.equal(elements.get('#tmux-plan').hidden, false);
    assert.equal(elements.get('#tmux-cancel').textContent, 'Not now');
    elements.get('#tmux-dialog').close(); await flush();
    assert.deepEqual(tmuxPayloads(calls), [{}, { dismiss: true }]);
    // Closing the agent setup again (from Settings) does not offer tmux again.
    elements.get('#agent-setup').onclick(); await flush();
    elements.get('#agent-dialog').close(); await flush();
    assert.equal(elements.get('#tmux-dialog').open, false);
    // Reopened from Settings, closing it records nothing more.
    elements.get('#tmux-setup').onclick(); await flush();
    assert.equal(elements.get('#tmux-dialog').open, true);
    elements.get('#tmux-dialog').close(); await flush();
    assert.deepEqual(tmuxPayloads(calls), [{}, { dismiss: true }, {}]);
});

test('without the agent offer, the first launch offers tmux right away', async () => {
    const respond = action => action === 'initialize'
        ? { workspace: createWorkspace(), profiles: PROFILES, home: '', platform: 'darwin', tmuxSetup: true }
        : action === 'tmux-setup' ? structuredClone(TMUX_MISSING) : null;
    const { elements } = await boot(createWorkspace(), { respond });
    await flush();
    assert.equal(elements.get('#tmux-dialog').open, true);
});

test('Settings › Install tmux runs the install in its own terminal and reports failures in the dialog', async () => {
    let status = { ...TMUX_MISSING, path: 'C:\\msys64\\usr\\bin\\tmux.exe', version: '3.2' }, fail = true;
    const respond = (action, payload) => action === 'create-card' ? { card: createCard(payload) }
        : action !== 'tmux-setup' ? null
            : payload.install && fail ? { error: 'Could not save the tmux setup: Access is denied.' } : structuredClone(status);
    const { context, calls, elements } = await boot(createWorkspace(), { respond, terminals: true });
    assert.deepEqual(calls.map(c => c.action), ['initialize'], 'nothing is offered after the first launch');
    elements.get('#settings').onclick();
    elements.get('#tmux-setup').onclick(); await flush();
    assert.equal(elements.get('#settings-menu').hidden, true, 'choosing an item closes the menu');
    assert.equal(elements.get('#tmux-dialog').open, true);
    assert.equal(elements.get('#tmux-status').textContent, 'tmux 3.2 is at C:\\msys64\\usr\\bin\\tmux.exe, but 3.3 or newer is needed.');
    assert.equal(elements.get('#tmux-install').lastChild.textContent, 'Update tmux');
    elements.get('#tmux-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(elements.get('#tmux-dialog').open, true);
    assert.equal(elements.get('#tmux-error').hidden, false);
    assert.match(elements.get('#tmux-error').textContent, /Access is denied/);
    assert.equal(json(context, 'workspace.cards.length'), 0, 'a failed request starts nothing');
    fail = false;
    elements.get('#tmux-form').onsubmit({ preventDefault() {} }); await flush();
    assert.equal(elements.get('#tmux-dialog').open, false);
    const install = json(context, 'workspace.cards[0]');
    assert.deepEqual([install.title, install.command, install.profile], ['Install tmux', TMUX_MISSING.command, 'shell']);
    assert.equal(calls.filter(c => c.action === 'start').at(-1).payload.card.id, install.id);
    assert.match(elements.get('#toast').textContent, /installing in the new terminal/);
    assert.deepEqual(tmuxPayloads(calls), [{}, { install: true }, { install: true }]);

    // Once tmux is ready, the dialog only reports it.
    status = { ...TMUX_MISSING, installed: true, path: '/opt/homebrew/bin/tmux', version: '3.8' };
    elements.get('#tmux-setup').onclick(); await flush();
    assert.equal(elements.get('#tmux-status').textContent, 'tmux 3.8 is installed: /opt/homebrew/bin/tmux');
    assert.equal(elements.get('#tmux-status').classList.contains('ready'), true);
    assert.deepEqual([elements.get('#tmux-plan').hidden, elements.get('#tmux-install').hidden], [true, true]);
    assert.equal(elements.get('#tmux-cancel').textContent, 'Close');
    elements.get('#tmux-dialog').close();

    // Without a package manager it says what to do instead.
    status = { ...TMUX_MISSING, manager: null, command: null };
    elements.get('#tmux-setup').onclick(); await flush();
    assert.match(elements.get('#tmux-status').textContent, /^tmux is not installed\. No supported package manager was found\. Install tmux 3\.3 or newer yourself/);
    assert.equal(elements.get('#tmux-install').hidden, true);
});


test('automatic titles update hidden canvases and persist without switching or starting terminals', async () => {
    const board = twoCanvases();
    board.cards.forEach(card => { card.titleMode = 'automatic'; });
    const { context, elements, onEvent, calls } = await boot(board);
    const hidden = board.cards[1].id;
    const title = () => vm.runInContext(`anyCard('${hidden}').title`, context);
    const event = { type: 'title', id: hidden, title: 'Background task', titleMode: 'automatic', titleRevision: 1 };
    onEvent(event);
    assert.equal(title(), 'Background task');
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-0');
    assert.equal(vm.runInContext(`sessions.get('${hidden}').element.hidden`, context), true);
    assert.equal(vm.runInContext(`sessions.get('${hidden}').element.querySelector('.card-title').attributes.get('aria-label')`, context), 'Rename terminal: Background task');
    onEvent({ ...event, title: 'Stale', titleRevision: 0 });
    onEvent({ ...event, title: 'Wrong epoch', titleEpoch: 99, titleRevision: 2 });
    assert.equal(title(), 'Background task');
    await vm.runInContext('save()', context);
    assert.equal(calls.find(call => call.action === 'save').payload.cards.find(card => card.id === hidden).title, 'Background task');
    vm.runInContext('switchCanvas("canvas-1"); openTerminalSwitcher()', context);
    assert.equal(elements.get('#outline').children[0].children[1].textContent, 'Background task');
    assert.equal(elements.get('#minimap-cards').children[0].title, 'Background task');
    elements.get('#switcher-query').value = 'Background'; elements.get('#switcher-query').oninput();
    assert.deepEqual(switcherState(context).matches, [hidden]);
    vm.runInContext(`anyCard('${hidden}').titleMode = 'manual'; switchCanvas('canvas-0')`, context);
    onEvent({ ...event, title: 'Late automatic', titleRevision: 3 });
    assert.equal(title(), 'Background task');
    assert.equal(calls.some(call => ['start', 'stop'].includes(call.action)), false);
});

test('pending title renames finish on their owning canvas after a canvas switch', async () => {
    const board = twoCanvases(), id = board.cards[0].id;
    board.cards[0].titleMode = 'automatic';
    let finish;
    const { context, onEvent } = await boot(board, { respond: (action, payload) => action === 'rename-title'
        ? new Promise(resolve => { finish = () => resolve({ card: { title: payload.title, titleMode: 'manual', titleRevision: 2 } }); }) : null });
    const pending = vm.runInContext('renameTerminal(workspace.cards[0], "manual", "Chosen name")', context);
    await flush();
    vm.runInContext('switchCanvas("canvas-1")', context);
    onEvent({ type: 'title', id, title: 'Deferred generated name', titleMode: 'automatic', titleRevision: 3 });
    finish(); await pending;
    assert.equal(vm.runInContext(`anyCard('${id}').title`, context), 'Chosen name');
    assert.equal(vm.runInContext(`anyCard('${id}').titleRevision`, context), 2);
    assert.equal(json(context, 'activeCanvas.id'), 'canvas-1');
});

test('the footer Keep running button and the Settings item switch together and show the host state', async () => {
    let enabled = false;
    const respond = (action, payload) => {
        if (action !== 'keep-running') return null;
        enabled = payload.enabled;
        return { enabled, via: enabled ? 'helper' : null, available: true, sessions: [] };
    };
    const { elements, calls } = await boot(createWorkspace(), { respond });
    const button = elements.get('#keep-toggle');
    const shown = () => [button.attributes.get('aria-pressed'), elements.get('#keep-toggle-state').textContent,
        elements.get('#keep-setting').attributes.get('aria-checked')];
    button.onclick(); await flush();
    assert.deepEqual(shown(), ['true', 'On', 'true']);
    elements.get('#keep-setting').onclick(); await flush();
    assert.deepEqual(shown(), ['false', 'Off', 'false']);
    assert.deepEqual(structuredClone(calls.filter(call => call.action === 'keep-running').map(call => call.payload)), [{ enabled: true }, { enabled: false }]);
    assert.equal(button.disabled, false);
});

test('a refused Keep running switch keeps the shown state and reports why', async () => {
    const respond = action => action === 'keep-running' ? { error: 'Keeping terminals running needs tmux, which was not found.' } : null;
    const { elements } = await boot(createWorkspace(), { respond });
    elements.get('#keep-toggle').onclick(); await flush();
    assert.equal(elements.get('#keep-toggle').attributes.get('aria-pressed'), 'false');
    assert.equal(elements.get('#keep-toggle').disabled, false);
    assert.match(elements.get('#toast').textContent, /needs tmux, which was not found/);
});
