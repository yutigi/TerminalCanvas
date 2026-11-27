/* The desktop sidebar's Browser access button: three text-readable states and the existing dialogs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/remote-ui.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');

class Element {
    constructor(id = '') {
        this.id = id; this.hidden = false; this.textContent = ''; this.value = ''; this.disabled = false;
        this.dataset = {}; this.attributes = new Map(); this.queries = new Map();
        const classes = new Set();
        this.classList = {
            toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return !!force; },
            contains: name => classes.has(name)
        };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    querySelector(selector) {
        if (!this.queries.has(selector)) this.queries.set(selector, new Element(selector));
        return this.queries.get(selector);
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { return this.onclick?.(); }
}

/* Builds the sidebar button from the shipped markup so the initial (pre-render) state is tested too. */
function boot({ remote = false, respond = () => ({}) } = {}) {
    const markup = html.match(/<button[^>]*id="remote-settings"[^>]*>[\s\S]*?<\/button>/)[0];
    const elements = new Map();
    for (const id of ['remote-settings', 'remote-access-label', 'remote-access-status', 'remote-access-chip', 'remote-address']) {
        elements.set('#' + id, new Element(id));
    }
    const button = elements.get('#remote-settings');
    button.dataset.state = markup.match(/data-state="([^"]+)"/)[1];
    button.setAttribute('aria-label', markup.match(/aria-label="([^"]+)"/)[1]);
    for (const id of ['remote-access-label', 'remote-access-status', 'remote-access-chip']) {
        elements.get('#' + id).textContent = markup.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))[1];
    }
    const dialogs = [], calls = [];
    let handler;
    const document = {
        querySelector: selector => elements.get(selector),
        createElement: () => { const dialog = new Element(); dialogs.push(dialog); return dialog; },
        body: { append() {} }
    };
    const bridge = {
        remote,
        async invoke(action, payload) { calls.push({ action, payload }); return respond(action, payload); },
        onEvent(fn) { handler = fn; }
    };
    vm.runInNewContext(source, { window: { terminalCanvas: bridge, __TAURI__: { core: {} } }, document });
    const view = () => ({
        state: button.dataset.state,
        label: elements.get('#remote-access-label').textContent,
        status: elements.get('#remote-access-status').textContent,
        chip: elements.get('#remote-access-chip').textContent,
        name: button.getAttribute('aria-label'),
        running: button.classList.contains('remote-running')
    });
    return { elements, button, dialogs, calls, view, event: payload => handler({ type: 'remote-status', ...payload }) };
}

const OFF = { state: 'off', label: 'Browser access', status: 'Not sharing', chip: 'Off', name: 'Browser access: off', running: false };
const url = 'http://127.0.0.1:4123/';

test('the shipped sidebar button starts in the readable Off state', () => {
    const { button, view } = boot();
    assert.equal(button.hidden, false);
    assert.deepEqual(view(), OFF);
    assert.match(html, /<small id="remote-address" hidden><\/small>/);
    assert.match(html, /id="remote-settings"[^>]*aria-haspopup="dialog"/);
    assert.match(html, /id="remote-access-chip"[^>]*aria-hidden="true"/, 'the chip repeats the state and stays out of the name');
    assert.match(html, /<button[^>]*id="remote-settings"[^>]*><span data-icon="globe"><\/span>/);
});

test('status events move between off, on with no browsers, and on with connected browsers', () => {
    const { view, event, elements } = boot();
    event({ running: true, url, clients: 0 });
    assert.deepEqual(view(), { state: 'waiting', label: 'Browser access', status: 'No browsers connected', chip: 'On',
        name: 'Browser access: on, no browsers connected', running: true });
    assert.equal(elements.get('#remote-address').hidden, false);
    assert.equal(elements.get('#remote-address').textContent, url);
    event({ running: true, url, clients: 1 });
    assert.deepEqual(view(), { state: 'connected', label: 'Browser access', status: '1 browser connected', chip: 'On',
        name: 'Browser access: on, 1 browser connected', running: true });
    event({ running: true, url, clients: 3 });
    assert.equal(view().status, '3 browsers connected');
    assert.equal(view().name, 'Browser access: on, 3 browsers connected');
    event({ running: true, url, clients: 0 });
    assert.equal(view().state, 'waiting', 'the last browser leaving returns to the waiting state');
    event({ running: false, clients: 0 });
    assert.deepEqual(view(), OFF);
    assert.equal(elements.get('#remote-address').hidden, true);
    assert.equal(elements.get('#remote-address').textContent, '');
});

test('a stopped server never shows a stale client count', () => {
    const { view, event } = boot();
    event({ running: true, url, clients: 2 });
    event({ running: false });
    assert.deepEqual(view(), OFF);
    event({ running: true, url, clients: 'not a number' });
    assert.equal(view().status, 'No browsers connected');
});

test('activating the button refreshes the status and then opens the existing dialog', async () => {
    let status = { running: true, url, clients: 2, controlToken: 'c', viewToken: 'v' };
    const { button, dialogs, calls, view } = boot({ respond: action => action === 'remote-status' ? status
        : action === 'remote-stop' ? (status = { running: false, clients: 0 }) : {} });
    const dialog = dialogs.find(element => element.id === 'remote-dialog');
    assert.ok(dialog, 'the desktop dialog is created once at startup');
    await button.click();
    assert.deepEqual(calls.map(call => call.action), ['remote-status']);
    assert.equal(dialog.open, true);
    assert.equal(view().status, '2 browsers connected');
    await dialog.querySelector('#remote-start-stop').onclick();
    assert.equal(calls.at(-1).action, 'remote-stop');
    assert.deepEqual(view(), OFF, 'stopping from the dialog updates the sidebar');
});

test('starting access from the dialog shows the waiting state at once', async () => {
    const { dialogs, view } = boot({ respond: action => action === 'remote-start' ? { running: true, url, clients: 0 } : {} });
    const dialog = dialogs.find(element => element.id === 'remote-dialog');
    dialog.querySelector('#remote-port').value = '0';
    await dialog.querySelector('#remote-start-stop').onclick();
    assert.equal(view().state, 'waiting');
    assert.equal(view().chip, 'On');
});

test('browser clients keep a single Browser access features entry', () => {
    const { button, dialogs, elements } = boot({ remote: true });
    const limits = dialogs.find(element => element.id === 'remote-limitations');
    assert.equal(elements.get('#remote-access-label').textContent, 'Browser access features');
    assert.equal(elements.get('#remote-access-status').hidden, true);
    assert.equal(elements.get('#remote-access-chip').hidden, true);
    assert.equal(button.getAttribute('aria-label'), null, 'the visible label names the button');
    assert.equal(button.dataset.state, 'features');
    button.click();
    assert.equal(limits.open, true);
});
