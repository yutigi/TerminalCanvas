const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
        const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {}, ...values };
        for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) { this.captured.delete(id); }
    remove() {}
    setAttribute(name, value) { this.attributes.set(name, value); }
    focus() {}
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
        querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {}
    };
    const context = vm.createContext({ document, window: { terminalCanvas: bridge, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {} });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/minimap.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), context);
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
