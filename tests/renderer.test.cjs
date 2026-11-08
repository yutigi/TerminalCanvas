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
async function boot(workspace, { initialized = true, respond } = {}) {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
    elements.get('#toast').hidden = true;
    elements.get('#minimap-map').clientWidth = 198;
    elements.get('#minimap-map').clientHeight = 120;
    const calls = [];
    const bridge = {
        async invoke(action, payload) {
            calls.push({ action, payload });
            const response = respond?.(action, payload);
            if (response) return response;
            if (action === 'initialize') return initialized ? { workspace: structuredClone(workspace), profiles: PROFILES, home: '', platform: 'win32' } : new Promise(() => {});
            return { ok: true };
        },
        onEvent() {}, resize() {}, acknowledge() {}, input() {}
    };
    const document = {
        querySelector: selector => selector === 'dialog[open]' ? [...elements.values()].find(e => e.open) : elements.get(selector),
        querySelectorAll: () => [], createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}
    };
    const window = Object.assign(new Element(), { terminalCanvas: bridge });
    const context = vm.createContext({ document, window, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {} });
    // Load renderer scripts in the same order as index.html.
    for (const [, script] of html.matchAll(/<script src="\.\/([^"]+)" defer>/g)) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', script), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    return { elements, calls, context, window };
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

test('canvas input before the workspace loads is ignored instead of throwing', async () => {
    const { elements } = await boot(createWorkspace(), { initialized: false });
    const viewport = elements.get('#viewport');
    viewport.dispatch('wheel', { ctrlKey: true, deltaY: -100 });
    viewport.dispatch('pointerdown', { target: viewport });
    viewport.dispatch('pointerdown', { target: viewport, shiftKey: true });
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
    assert.equal(bar.hidden, true, 'terminals and images have no style');
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
    assert.deepEqual(json(context, 'workspace.items.map(i => i.id).filter(id => ["frame", "inside"].includes(id))'), [], 'cut removes the copied items');
    assert.equal(json(context, 'boardClipboard.marker'), 'Plan\n\nInside');
    vm.runInContext('undo()', context);
    assert.equal(json(context, 'workspace.items.filter(i => i.id === "frame" || i.id === "inside").length'), 2, 'cut is undoable');
    vm.runInContext('select("solo"); copySelection(); workspace.camera = { x: 0, y: 0, z: 1 }; pasteBoardItems()', context);
    const copy = json(context, 'workspace.items.at(-1)');
    assert.deepEqual([copy.x + copy.w / 2, copy.y + copy.h / 2], [550, 360], 'lands in the middle of the view');
    assert.equal(copy.groups, undefined, 'a one-member group is not kept');
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
