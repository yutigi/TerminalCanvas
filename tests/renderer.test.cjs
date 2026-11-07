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
    addEventListener() {}
    removeEventListener() {}
    remove() {}
    setAttribute() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
}
async function boot(workspace) {
    const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
    const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => ['#' + match[1], new Element()]));
    elements.get('#toast').hidden = true;
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
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8'), context);
    await new Promise(resolve => setImmediate(resolve));
    return { elements, calls };
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
