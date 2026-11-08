/* The renderer owns layout and terminal emulation. All OS access goes through preload. */
'use strict';
const $ = selector => document.querySelector(selector);
const paths = {
    canvas: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/>',
    terminal: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 4 3-4 3m7 0h5"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    puzzle: '<path d="M8 3h3a3 3 0 1 1 6 0h4v7a3 3 0 1 0 0 6v5h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 0 0-6V3h5Z"/>',
    'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01"/>',
    save: '<path d="M20 21H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h13l4 4v13a1 1 0 0 1-1 1Z"/><path d="M7 3v6h9V3M7 21v-8h10v8"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    minimize: '<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',
    scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8"/>',
    move: '<path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3m14-6 3 3-3 3"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
    pointer: '<path d="m5 3 14 9-7 1-3 7-4-17Z"/>',
    hand: '<path d="M8 13V6a2 2 0 0 1 4 0v6-7a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v7c0 5-3 7-7 7-3 0-5-2-7-4l-3-4a2 2 0 0 1 3-2l2 2Z"/>',
    play: '<path d="m8 4 12 8-12 8V4Z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    x: '<path d="m6 6 12 12M6 18 18 6"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.terminal}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const bridge = window.terminalCanvas;
const viewport = $('#viewport');
const world = $('#world');
const minimap = $('#minimap');
const minimapMap = $('#minimap-map');
const sessions = new Map();
let workspace, profiles = [], selected, focused, hand = false, autosaveTimer, toastTimer, saveRevision = 0, confirmation;
let ready = false, formBusy = false;
let minimapVisible = true, minimapLayout, minimapDrag;
const mark = profile => {
    const el = document.createElement('span');
    el.className = 'profile-mark';
    el.style.setProperty('--profile-color', profile.color);
    el.textContent = profile.initials;
    return el;
};
function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}
async function invoke(action, payload) {
    if (!bridge) throw new Error('Open Terminal Canvas with npm start.');
    const result = await bridge.invoke(action, payload);
    if (result?.error) throw new Error(result.error);
    return result;
}
function run(task) { Promise.resolve().then(task).catch(error => toast(error.message)); }
function changed() {
    if (!ready) return;
    const revision = ++saveRevision;
    $('#save-state').lastChild.textContent = 'Saving…';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => run(async () => {
        await invoke('autosave', workspace);
        if (revision === saveRevision) $('#save-state').lastChild.textContent = 'Saved locally';
    }), 500);
}
function renderCamera() {
    const { x, y, z } = workspace.camera;
    world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    viewport.style.backgroundSize = `${24 * z}px ${24 * z}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.setProperty('--viewport-width', `${viewport.clientWidth}px`);
    viewport.style.setProperty('--viewport-height', `${viewport.clientHeight}px`);
    $('#zoom-reset').textContent = `${Math.round(z * 100)}%`;
    renderMinimap();
}
function positionMinimapElement(element, rect) {
    Object.assign(element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
}
function renderMinimap() {
    const hasCards = workspace.cards.length > 0;
    $('#minimap-toggle').disabled = !hasCards;
    $('#minimap-toggle').setAttribute('aria-pressed', String(minimapVisible));
    minimap.hidden = !minimapVisible || !hasCards || !!focused;
    if (minimap.hidden || minimapMap.clientWidth <= 20 || minimapMap.clientHeight <= 20) return;
    minimapLayout = minimapDrag?.layout || window.TerminalCanvasMinimap.layout(workspace.cards, workspace.camera,
        { width: viewport.clientWidth, height: viewport.clientHeight }, minimapMap.clientWidth, minimapMap.clientHeight);
    const nodes = workspace.cards.map((card, index) => {
        const node = document.createElement('div');
        const status = sessions.get(card.id)?.status;
        node.className = `minimap-card${card.id === selected ? ' selected' : ''}${['running', 'starting'].includes(status) ? ' running' : ''}`;
        node.style.setProperty('--profile-color', profiles.find(profile => profile.id === card.profile).color);
        node.title = card.title;
        positionMinimapElement(node, minimapLayout.cards[index]);
        return node;
    });
    $('#minimap-cards').replaceChildren(...nodes);
    const { x, y, z } = workspace.camera;
    positionMinimapElement($('#minimap-viewport'), {
        x: -x / z * minimapLayout.scale + minimapLayout.offsetX,
        y: -y / z * minimapLayout.scale + minimapLayout.offsetY,
        w: viewport.clientWidth / z * minimapLayout.scale,
        h: viewport.clientHeight / z * minimapLayout.scale
    });
}
$('#minimap-toggle').onclick = () => { minimapVisible = !minimapVisible; renderMinimap(); };
minimap.addEventListener('pointerdown', event => event.stopPropagation());
minimap.addEventListener('wheel', event => event.stopPropagation());
minimapMap.addEventListener('pointerdown', event => {
    if (!ready || minimap.hidden || event.button !== 0 || minimapDrag || !minimapLayout) return;
    event.preventDefault(); minimapMap.focus(); minimapMap.setPointerCapture(event.pointerId);
    // Freeze the projection during navigation so changing bounds cannot move the target under the pointer.
    const map = minimapLayout, rect = minimapMap.getBoundingClientRect(), frame = map.viewport;
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const inside = point.x >= frame.x && point.x <= frame.x + frame.w && point.y >= frame.y && point.y <= frame.y + frame.h;
    const offset = inside ? { x: frame.x + frame.w / 2 - point.x, y: frame.y + frame.h / 2 - point.y } : { x: 0, y: 0 };
    minimapDrag = { layout: map };
    const move = e => {
        if (e.pointerId !== event.pointerId) return;
        workspace.camera = window.TerminalCanvasMinimap.cameraAtPoint(
            { x: e.clientX - rect.left + offset.x, y: e.clientY - rect.top + offset.y }, map,
            { width: viewport.clientWidth, height: viewport.clientHeight }, workspace.camera.z);
        renderCamera();
    };
    const end = e => {
        if (e.pointerId !== event.pointerId) return;
        minimapMap.removeEventListener('pointermove', move);
        minimapMap.removeEventListener('pointerup', end);
        minimapMap.removeEventListener('pointercancel', end);
        minimapMap.removeEventListener('lostpointercapture', end);
        minimapDrag = null;
        if (minimapMap.hasPointerCapture(event.pointerId)) minimapMap.releasePointerCapture(event.pointerId);
        renderMinimap(); changed();
    };
    minimapMap.addEventListener('pointermove', move);
    minimapMap.addEventListener('pointerup', end);
    minimapMap.addEventListener('pointercancel', end);
    minimapMap.addEventListener('lostpointercapture', end);
    move(event);
});
minimapMap.addEventListener('keydown', event => {
    if (!ready || minimap.hidden || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const amount = event.shiftKey ? .5 : .1;
    const dx = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0;
    const dy = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    workspace.camera.x = Math.max(-100000, Math.min(100000, workspace.camera.x + dx * viewport.clientWidth * amount));
    workspace.camera.y = Math.max(-100000, Math.min(100000, workspace.camera.y + dy * viewport.clientHeight * amount));
    renderCamera(); changed();
});
function renderGeometry(card) {
    const el = sessions.get(card.id)?.element;
    if (!el) return;
    Object.assign(el.style, { left: `${card.x}px`, top: `${card.y}px`, width: `${card.w}px`, height: `${card.h}px` });
    renderMinimap();
}
function refresh() {
    renderMinimap();
    const running = [...sessions.values()].filter(s => ['running', 'starting'].includes(s.status)).length;
    $('#card-count').textContent = workspace.cards.length;
    $('#outline-count').textContent = String(workspace.cards.length).padStart(2, '0');
    $('#running-count').textContent = `${running} running`;
    $('#terminal-total').textContent = `${workspace.cards.length} terminal${workspace.cards.length === 1 ? '' : 's'}`;
    $('#empty-state').hidden = workspace.cards.length > 0;
    $('#focus-toggle').disabled = !selected;
    const filter = $('#search').value.toLowerCase();
    const outline = $('#outline');
    outline.replaceChildren();
    workspace.cards.filter(c => `${c.title} ${c.cwd} ${c.profile}`.toLowerCase().includes(filter)).forEach(card => {
        const s = sessions.get(card.id);
        const button = document.createElement('button');
        button.className = `outline-item ${card.id === selected ? 'selected' : ''} ${s.status === 'running' ? 'running' : ''}`;
        button.append(mark(profiles.find(p => p.id === card.profile)));
        const label = document.createElement('span'); label.className = 'label'; label.textContent = card.title;
        const dot = document.createElement('span'); dot.className = 'state-dot'; dot.title = s.status;
        button.append(label, dot);
        button.onclick = () => { if (focused) setFocus(null); select(card.id); centerCard(card); };
        outline.append(button);
    });
    if (!outline.childElementCount) {
        const p = document.createElement('p'); p.className = 'outline-empty';
        p.textContent = workspace.cards.length ? 'No matching terminals.' : 'Your terminals will appear here.';
        outline.append(p);
    }
}
function select(id) {
    selected = id;
    for (const [key, s] of sessions) s.element.classList.toggle('selected', key === id);
    const s = sessions.get(id);
    if (s) { world.append(s.element); if (s.status === 'running') s.terminal?.focus(); }
    refresh();
}
function centerCard(card) {
    const z = workspace.camera.z;
    workspace.camera.x = Math.max(-100000, Math.min(100000, (viewport.clientWidth - card.w * z) / 2 - card.x * z));
    workspace.camera.y = Math.max(-100000, Math.min(100000, (viewport.clientHeight - card.h * z) / 2 - card.y * z));
    renderCamera(); changed();
}
function fitCanvas() {
    if (focused) setFocus(null);
    if (!workspace.cards.length) { workspace.camera = { x: 48, y: 48, z: 1 }; renderCamera(); return; }
    const minX = Math.min(...workspace.cards.map(c => c.x)), minY = Math.min(...workspace.cards.map(c => c.y));
    const maxX = Math.max(...workspace.cards.map(c => c.x + c.w)), maxY = Math.max(...workspace.cards.map(c => c.y + c.h));
    const z = Math.max(.35, Math.min(1, (viewport.clientWidth - 80) / (maxX - minX), (viewport.clientHeight - 120) / (maxY - minY)));
    workspace.camera = {
        x: Math.max(-100000, Math.min(100000, (viewport.clientWidth - (maxX - minX) * z) / 2 - minX * z)),
        y: Math.max(-100000, Math.min(100000, (viewport.clientHeight - (maxY - minY) * z) / 2 - minY * z - 20)), z
    };
    renderCamera(); changed();
}
function zoom(factor, point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) {
    if (focused) return;
    const cam = workspace.camera;
    const z = Math.max(.35, Math.min(1.5, cam.z * factor));
    cam.x = Math.max(-100000, Math.min(100000, point.x - (point.x - cam.x) * z / cam.z));
    cam.y = Math.max(-100000, Math.min(100000, point.y - (point.y - cam.y) * z / cam.z));
    cam.z = z; renderCamera(); changed();
}
function setFocus(id) {
    focused = id;
    viewport.classList.toggle('focus-mode', !!id);
    $('#exit-focus').hidden = !id;
    for (const [key, s] of sessions) s.element.classList.toggle('focused', key === id);
    renderCamera();
    if (id) select(id);
    requestAnimationFrame(() => { for (const s of sessions.values()) fitTerminal(s); });
}
function fitTerminal(s) {
    if (!s?.fit || !s.element.offsetWidth || !s.element.offsetHeight) return;
    const size = s.fit.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) s.terminal.resize(Math.max(2, Math.min(500, size.cols)), Math.max(1, Math.min(300, size.rows)));
}
function confirmAction(title, description, label = 'Continue') {
    if (confirmation) return Promise.resolve(false);
    $('#confirm-title').textContent = title;
    $('#confirm-description').textContent = description;
    $('#confirm-ok').textContent = label;
    $('#confirm-dialog').showModal();
    return new Promise(resolve => { confirmation = resolve; });
}
function finishConfirm(value) { $('#confirm-dialog').close(); const resolve = confirmation; confirmation = null; resolve?.(value); }
$('#confirm-ok').onclick = () => finishConfirm(true);
$('#confirm-cancel').onclick = () => finishConfirm(false);
$('#confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirm(false); });
function setStatus(card, value, message) {
    const s = sessions.get(card.id); if (!s) return;
    s.status = value;
    s.element.classList.toggle('running', value === 'running' || value === 'starting');
    s.element.querySelector('.status-text').textContent = value === 'running' ? 'Running' : value === 'starting' ? 'Starting' : value === 'exited' ? 'Exited' : 'Ready';
    const toggle = s.element.querySelector('[data-action="toggle"]');
    toggle.innerHTML = icon(['running', 'starting'].includes(value) ? 'stop' : 'play');
    toggle.title = ['running', 'starting'].includes(value) ? 'Stop terminal' : 'Start terminal';
    toggle.setAttribute('aria-label', toggle.title);
    s.placeholder.hidden = ['running', 'starting'].includes(value) || value === 'exited';
    if (message) s.element.querySelector('.placeholder-copy').textContent = message;
    refresh();
}
function mount(card) {
    const profile = profiles.find(p => p.id === card.profile);
    const el = document.createElement('article'); el.className = 'terminal-card'; el.dataset.id = card.id;
    el.innerHTML = `<div class="card-header"><span class="card-title"></span><span class="card-status"><i></i><span class="status-text">Ready</span></span><div class="card-actions"><button class="icon-button" data-action="toggle" title="Start terminal" aria-label="Start terminal">${icon('play')}</button><button class="icon-button" data-action="focus" title="Focus terminal" aria-label="Focus terminal">${icon('maximize')}</button><button class="icon-button" data-action="close" title="Close terminal" aria-label="Close terminal">${icon('x')}</button></div></div><div class="card-directory">${icon('folder')}<span></span></div><div class="terminal-body"><div class="terminal-placeholder"><span class="placeholder-icon">${icon('terminal')}</span><p class="placeholder-copy"></p><button class="button" data-action="start">${icon('play')}Start terminal</button></div></div><div class="card-resize" title="Drag to resize"></div>`;
    el.querySelector('.card-header').prepend(mark(profile));
    el.querySelector('.card-title').textContent = card.title;
    el.querySelector('.card-directory span').textContent = card.cwd || 'Home directory';
    el.querySelector('.card-directory').title = card.cwd || 'Home directory';
    el.querySelector('.placeholder-copy').textContent = card.command ? `Ready to run: ${card.command}` : 'Your shell is ready. Start when you are.';
    const s = { element: el, status: 'idle', terminal: null, fit: null, placeholder: el.querySelector('.terminal-placeholder') };
    sessions.set(card.id, s); world.append(el); renderGeometry(card);
    if (window.Terminal && window.FitAddon) {
        s.terminal = new window.Terminal({
            fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace", fontSize: 12, lineHeight: 1.3,
            cursorBlink: true, scrollback: 5000, allowProposedApi: false,
            theme: { background: '#15191f', foreground: '#c8d1dc', cursor: '#c8ecb5', selectionBackground: '#52694e80', black: '#29313d', red: '#e59a91', green: '#b5d69a', yellow: '#dfc68c', blue: '#94b5e8', magenta: '#baa0da', cyan: '#91cbc7', white: '#d5dce5', brightBlack: '#667486', brightRed: '#f0b2a9', brightGreen: '#c8ecb5', brightYellow: '#f1dbab', brightBlue: '#b2cdff', brightMagenta: '#d8bcf6', brightCyan: '#b1e4df', brightWhite: '#f0f4fa' }
        });
        s.fit = new window.FitAddon.FitAddon(); s.terminal.loadAddon(s.fit); s.terminal.open(el.querySelector('.terminal-body'));
        s.terminal.onData(data => { if (s.status === 'running') bridge.input(card.id, data); });
        s.terminal.onResize(({ cols, rows }) => { if (['running', 'starting'].includes(s.status)) bridge.resize(card.id, cols, rows); });
        s.terminal.attachCustomKeyEventHandler(event => {
            const key = event.key.toLowerCase();
            if ((event.ctrlKey || event.metaKey) && ((!event.shiftKey && ['s', 'o'].includes(key)) || (event.shiftKey && ['n', 'f'].includes(key)))) return false;
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && ['c', 'v'].includes(event.key.toLowerCase())) {
                if (event.type === 'keydown') run(async () => {
                    if (event.key.toLowerCase() === 'c') await invoke('clipboard-write', s.terminal.getSelection());
                    else if (s.status === 'running') s.terminal.paste((await invoke('clipboard-read')).text);
                });
                return false;
            }
            return true;
        });
        s.observer = new ResizeObserver(() => fitTerminal(s));
        s.observer.observe(el.querySelector('.terminal-body'));
        requestAnimationFrame(() => fitTerminal(s));
    }
    el.addEventListener('pointerdown', () => { if (selected !== card.id) select(card.id); });
    el.querySelectorAll('[data-action]').forEach(button => button.onclick = () => run(async () => {
        const action = button.dataset.action;
        if (action === 'focus') setFocus(focused ? null : card.id);
        if (action === 'start') await start(card);
        if (action === 'toggle') {
            if (s.status === 'starting') return;
            if (s.status === 'running') { await invoke('stop', { id: card.id }); s.terminal?.writeln('\r\n\x1b[90m[Terminal stopped]\x1b[0m'); setStatus(card, 'exited'); }
            else await start(card);
        }
        if (action === 'close') {
            if (['running', 'starting'].includes(s.status) && !await confirmAction('Close this terminal?', 'Its running shell and child processes will be stopped. Terminal output is not saved.', 'Close terminal')) return;
            await invoke('stop', { id: card.id });
            if (focused === card.id) setFocus(null);
            dispose(card.id); workspace.cards = workspace.cards.filter(c => c.id !== card.id);
            if (selected === card.id) selected = null;
            changed(); refresh();
        }
    }));
    drag(el.querySelector('.card-header'), event => !focused && !event.target.closest('button'), (dx, dy, initial) => {
        card.x = Math.max(-100000, Math.min(100000, initial.x + dx / workspace.camera.z));
        card.y = Math.max(-100000, Math.min(100000, initial.y + dy / workspace.camera.z));
        renderGeometry(card);
    }, () => ({ x: card.x, y: card.y }));
    drag(el.querySelector('.card-resize'), () => !focused, (dx, dy, initial) => {
        card.w = Math.max(400, Math.min(2400, initial.w + dx / workspace.camera.z));
        card.h = Math.max(280, Math.min(1800, initial.h + dy / workspace.camera.z));
        renderGeometry(card);
    }, () => ({ w: card.w, h: card.h }));
}
function dispose(id) {
    const s = sessions.get(id); if (!s) return;
    s.observer?.disconnect(); s.terminal?.dispose(); s.element.remove(); sessions.delete(id);
}
async function start(card) {
    const s = sessions.get(card.id);
    if (!s || ['running', 'starting'].includes(s.status)) return;
    if (!s.terminal) throw new Error('Live terminals require the desktop app and installed xterm dependencies. Run npm install, then npm start.');
    s.terminal.reset(); fitTerminal(s); setStatus(card, 'starting');
    try {
        await invoke('start', { card, cols: s.terminal.cols, rows: s.terminal.rows });
        if (sessions.get(card.id) !== s) return;
        if (s.status === 'starting') setStatus(card, 'running');
        s.terminal.focus();
    } catch (error) { setStatus(card, 'idle', error.message); throw error; }
}
function drag(element, allowed, move, initial) {
    element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !allowed(event)) return;
        event.preventDefault(); element.setPointerCapture(event.pointerId);
        const origin = { x: event.clientX, y: event.clientY }, data = initial();
        const update = e => move(e.clientX - origin.x, e.clientY - origin.y, data);
        const end = () => {
            element.removeEventListener('pointermove', update); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end); changed();
        };
        element.addEventListener('pointermove', update); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end);
    });
}
viewport.addEventListener('pointerdown', event => {
    if (focused || event.target.closest('button') || event.target.closest('.canvas-toolbar')) return;
    if (event.button !== 1 && !(event.button === 0 && (hand || event.target === viewport || event.target === world || event.target.closest('.empty-state')))) return;
    event.preventDefault(); viewport.setPointerCapture(event.pointerId); viewport.classList.add('panning');
    const x = event.clientX, y = event.clientY, initial = { ...workspace.camera };
    const move = e => {
        workspace.camera.x = Math.max(-100000, Math.min(100000, initial.x + e.clientX - x));
        workspace.camera.y = Math.max(-100000, Math.min(100000, initial.y + e.clientY - y)); renderCamera();
    };
    const end = () => { viewport.classList.remove('panning'); viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', end); viewport.removeEventListener('pointercancel', end); changed(); };
    viewport.addEventListener('pointermove', move); viewport.addEventListener('pointerup', end); viewport.addEventListener('pointercancel', end);
});
viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault(); const rect = viewport.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
}, { passive: false });
function openLaunch(profileId = 'shell') {
    if (!ready || document.querySelector('dialog[open]')) return;
    if (workspace.cards.length >= 24) return toast('A workspace can contain up to 24 terminals.');
    const profile = profiles.find(p => p.id === profileId);
    $('#profile').value = profile.id; $('#terminal-title').value = profile.name; $('#command').value = profile.command;
    $('#launch-error').hidden = true; $('#launch-dialog').showModal();
}
$('#profile').onchange = () => { const p = profiles.find(p => p.id === $('#profile').value); $('#terminal-title').value = p.name; $('#command').value = p.command; };
$('#browse-folder').onclick = () => run(async () => { const result = await invoke('pick-folder'); if (result.path) $('#cwd').value = result.path; });
$('#launch-form').onsubmit = event => {
    event.preventDefault(); if (formBusy) return;
    formBusy = true; $('#launch-submit').disabled = true;
    run(async () => {
        try {
            const { x, y, z } = workspace.camera;
            const count = workspace.cards.length;
            const result = await invoke('create-card', { profile: $('#profile').value, title: $('#terminal-title').value.trim(), cwd: $('#cwd').value.trim(), command: $('#command').value.trim(), x: Math.round((60 - x) / z + (count % 4) * 35), y: Math.round((40 - y) / z + (count % 4) * 35) });
            workspace.cards.push(result.card); mount(result.card); select(result.card.id); changed(); refresh();
            $('#launch-dialog').close();
            if (focused) setFocus(result.card.id);
            await start(result.card);
        } catch (error) {
            $('#launch-error').textContent = error.message; $('#launch-error').hidden = false;
            throw error;
        } finally { formBusy = false; $('#launch-submit').disabled = false; }
    });
};
function loadWorkspace(board) {
    clearTimeout(autosaveTimer);
    workspace = board;
    setFocus(null);
    for (const id of sessions.keys()) dispose(id);
    selected = null; $('#workspace-name').value = board.name;
    board.cards.forEach(mount); renderCamera(); refresh();
}
async function canReplace() {
    if (!workspace.cards.length) return true;
    return confirmAction('Replace this workspace?', 'Save a workspace file first if you want to keep this layout. Running terminals will stop; their output will not be saved.', 'Replace workspace');
}
async function save() { workspace.name = $('#workspace-name').value.trim() || 'Untitled workspace'; const result = await invoke('save', workspace); if (!result.canceled) toast('Workspace saved. Restoring it will not rerun commands.'); }
$('#save').onclick = () => run(save);
$('#open-workspace').onclick = () => run(async () => { if (!await canReplace()) return; const result = await invoke('open'); if (result.workspace) { loadWorkspace(result.workspace); changed(); toast('Workspace restored. Start each terminal when you are ready.'); } });
$('#new-workspace').onclick = () => run(async () => { if (!await canReplace()) return; loadWorkspace((await invoke('new')).workspace); changed(); });
$('#workspace-name').oninput = () => { workspace.name = $('#workspace-name').value.trim() || 'Untitled workspace'; changed(); };
$('#search').oninput = () => { if (ready) refresh(); };
$('#canvas-nav').onclick = () => { if (ready) fitCanvas(); };
$('#add-terminal').onclick = $('#empty-add').onclick = () => openLaunch();
$('#arrange').onclick = () => {
    if (!ready) return; setFocus(null);
    const columns = Math.max(1, Math.ceil(Math.sqrt(workspace.cards.length)));
    workspace.cards.forEach((c, i) => { c.x = (i % columns) * 700; c.y = Math.floor(i / columns) * 470; c.w = 660; c.h = 430; renderGeometry(c); }); fitCanvas();
};
$('#focus-toggle').onclick = () => { if (ready) setFocus(focused ? null : selected); };
$('#exit-focus').onclick = () => setFocus(null);
$('#fit').onclick = () => { if (ready) fitCanvas(); };
$('#zoom-in').onclick = () => { if (ready) zoom(1.15); };
$('#zoom-out').onclick = () => { if (ready) zoom(1 / 1.15); };
$('#zoom-reset').onclick = () => { if (ready) zoom(1 / workspace.camera.z); };
function tool(isHand) { hand = isHand; viewport.classList.toggle('hand', hand); $('#hand-tool').classList.toggle('active', hand); $('#select-tool').classList.toggle('active', !hand); }
$('#hand-tool').onclick = () => tool(true); $('#select-tool').onclick = () => tool(false);
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
function info(title, body) { $('#info-title').textContent = title; $('#info-content').innerHTML = body; $('#info-dialog').showModal(); }
$('#help').onclick = () => info('A workspace that moves with you.', '<p class="info-copy">Launch a terminal for each task or AI agent. Drag its header to move it, pull the bottom-right corner to resize, and use Focus for uninterrupted work.</p><div class="help-grid"><span>New terminal</span><kbd>Ctrl Shift N</kbd><span>Save / open workspace</span><kbd>Ctrl S / Ctrl O</kbd><span>Toggle focused terminal</span><kbd>Ctrl Shift F</kbd><span>Copy / paste terminal text</span><kbd>Ctrl Shift C / V</kbd><span>Pan the canvas</span><kbd>Drag background / middle-drag</kbd><span>Zoom at pointer</span><kbd>Ctrl + scroll</kbd></div><p class="info-note">Workspaces save layouts, folders, and launch commands. Terminal output and running processes are not restored. Commands only run when you start a terminal.</p>');
$('#plugins').onclick = () => info('One canvas. More possibilities.', '<p class="info-copy">Terminal Canvas starts with a terminal card type and a desktop host API. This is the foundation for bringing other tools into the workspace.</p><p class="info-note"><strong>WebCanvas · Planned</strong><br>Browser cards alongside AI terminals, using isolated browser views. Plugin loading and browser integration are not implemented in this version.</p>');
document.addEventListener('keydown', event => {
    if (!ready || document.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 's') { event.preventDefault(); run(save); }
        if (key === 'o') { event.preventDefault(); $('#open-workspace').click(); }
        if (key === 'n' && event.shiftKey) { event.preventDefault(); openLaunch(); }
        if (key === 'f' && event.shiftKey) { event.preventDefault(); if (selected) setFocus(focused ? null : selected); }
    } else if (event.key === '/' && !event.target.closest('input,textarea,.xterm')) { event.preventDefault(); $('#search').focus(); }
});
window.addEventListener('resize', () => { if (ready) renderCamera(); });
if (bridge) {
    bridge.onEvent(event => {
        const s = sessions.get(event.id);
        if (event.type === 'data') {
            if (s?.terminal) s.terminal.write(event.data, () => bridge.acknowledge(event.id, event.data.length));
            else bridge.acknowledge(event.id, event.data.length);
        }
        if (event.type === 'exit' && s) { s.terminal?.writeln(`\r\n\x1b[90m[Process exited · code ${event.exitCode}]\x1b[0m`); setStatus(workspace.cards.find(c => c.id === event.id), 'exited'); }
        if (event.type === 'error') toast(event.message);
        if (event.type === 'closing') run(async () => {
            if (event.running && !await confirmAction('Close Terminal Canvas?', `${event.running} running terminal${event.running === 1 ? '' : 's'} will stop. Your layout will be saved; terminal output will not.`, 'Close app')) return;
            clearTimeout(autosaveTimer); await invoke('close', workspace);
        });
    });
    run(async () => {
        const initial = await invoke('initialize'); profiles = initial.profiles;
        for (const p of profiles) {
            const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; $('#profile').append(option);
            const button = document.createElement('button'); button.className = 'profile-button'; button.append(mark(p));
            const label = document.createElement('span'); label.textContent = p.name; button.append(label);
            const arrow = document.createElement('span'); arrow.className = 'launch-arrow'; arrow.innerHTML = icon('plus'); button.append(arrow);
            button.onclick = () => openLaunch(p.id); $('#profile-list').append(button);
        }
        $('#cwd').value = initial.home; $('#runtime-label').textContent = initial.preview ? 'Browser preview · shells unavailable' : initial.platform === 'win32' ? 'Windows · ConPTY' : 'Local · PTY';
        loadWorkspace(initial.workspace); ready = true;
        if (initial.warning) toast(initial.warning);
    });
} else toast('Desktop bridge unavailable. Run npm start or npm run dev for the layout preview.');
