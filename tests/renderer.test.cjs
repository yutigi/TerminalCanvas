const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { PROFILES, createWorkspace, createCard } = require('../src/workspace.cjs');

// A small DOM boundary substitute checks renderer boot/state without claiming visual coverage.
class Element {
    constructor() {
        this.children = []; this.queries = new Map(); this.value = ''; this.hidden = false;
        this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {}, remove() {} };
        this.dataset = {}; this.lastChild = { textContent: '' }; this.clientWidth = 1100; this.clientHeight = 720;
        this.listeners = new Map(); this.attributes = new Map(); this.captured = new Set();
    }
    append(...children) { this.children.push(...children); }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = children; }
    get childElementCount() { return this.children.length; }
    querySelector(selector) {
        if (!this.queries.has(selector)) this.queries.set(selector, new Element());
        return this.queries.get(selector);
    }
    querySelectorAll() { return []; }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    dispatch(type, values = {}) {
        let stopped = false;
        const event = { type, button: 0, pointerId: 1, clientX: 0, clientY: 0, target: this, preventDefault() {}, stopPropagation() { stopped = true; }, ...values };
        for (const handler of [...(this.listeners.get(type) || [])]) { handler(event); if (stopped) break; }
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    remove() {}
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    closest() { return null; }
    focus() {}
    blur() { this.dispatch('blur'); }
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
}
async function boot(workspace) {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
    elements.get('#toast').hidden = true;
    elements.get('#minimap-map').clientWidth = 198;
    elements.get('#minimap-map').clientHeight = 120;
    const calls = [];
    const bridge = {
        async invoke(action, payload) {
            calls.push({ action, payload });
            if (action === 'initialize') return { workspace: structuredClone(workspace), profiles: PROFILES, home: '', platform: 'win32' };
            return { ok: true };
        },
        onEvent() {}, resize() {}, acknowledge() {}, input() {}
    };
    const document = {
        querySelector: selector => selector === 'dialog[open]' ? [...elements.values()].find(e => e.open) : elements.get(selector),
        querySelectorAll: () => [], createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}
    };
    const context = vm.createContext({ document, window: { terminalCanvas: bridge, addEventListener() {} }, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {} });
    // Load renderer scripts in the same order as index.html.
    for (const [, script] of html.matchAll(/<script src="\.\/([^"]+)" defer>/g)) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', script), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    return { elements, calls, context };
}
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
    assert.equal(stroke.attributes.get('marker-end'), 'url(#arrowhead)');
    assert.equal(vm.runInContext('itemViews.get("note-1").text.textContent', context), 'Hello\nboard');
    assert.ok(Number(vm.runInContext('itemViews.get("frame").element.style.zIndex', context)) < 0, 'frames stay behind other items');
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
    assert.equal(json(context, 'workspace.items[0].group'), json(context, 'workspace.items[1].group'));
    const element = vm.runInContext('itemViews.get("a").element', context);
    element.dispatch('pointerdown', { clientX: 10, clientY: 10 });
    element.dispatch('pointermove', { clientX: 110, clientY: 60 });
    element.dispatch('pointerup', { clientX: 110, clientY: 60 });
    assert.deepEqual(json(context, 'workspace.items.map(i => [i.x, i.y])'), [[100, 50], [400, 50], [600, 0]]);
    vm.runInContext('ungroupSelection(); select("a")', context);
    assert.deepEqual(json(context, '[...selection]'), ['a']);
    assert.equal(json(context, 'workspace.items.some(i => i.group)'), false);
});
test('clicking a grouped terminal still focuses it for typing, while Shift additions do not', async () => {
    const workspace = createWorkspace();
    const card = { ...createCard(), group: 'pair' };
    workspace.cards.push(card);
    workspace.items.push(note('a', 900, 0, { group: 'pair' }), note('b', 1300, 0));
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
