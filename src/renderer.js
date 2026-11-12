/* The renderer owns layout and terminal emulation. All OS access goes through preload. */
'use strict';
const $ = selector => document.querySelector(selector);
const paths = {
    canvas: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/>',
    terminal: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 4 3-4 3m7 0h5"/>',
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
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
    x: '<path d="m6 6 12 12M6 18 18 6"/>',
    type: '<path d="M5 7V5h14v2M12 5v14m-3 0h6"/>',
    note: '<path d="M4 4h16v10l-6 6H4V4Z"/><path d="M14 20v-6h6"/>',
    square: '<rect x="4" y="5" width="16" height="14" rx="2"/>',
    circle: '<ellipse cx="12" cy="12" rx="9" ry="8"/>',
    line: '<path d="M5 19 19 5"/>',
    arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
    frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    package: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 8v8l9 5 9-5V8m-9 5v8"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.terminal}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const bridge = window.terminalCanvas;
const viewport = $('#viewport');
const world = $('#world');
const minimap = $('#minimap');
const minimapMap = $('#minimap-map');
const sessions = new Map();
// Terminals sit inside the zoomed world; xterm needs mouse coordinates without that scale.
window.TerminalCanvasPointer?.install(window);
let workspace, profiles = [], selected, focused, hand = false, autosaveTimer, toastTimer, saveRevision = 0, confirmation;
let ready = false, formBusy = false, duplicateBusy = false, activeDrags = 0;
let topCardZIndex = 0;
let minimapVisible = true, minimapLayout, minimapDrag;
// `selection` holds every selected terminal and item; `selected` is the primary one.
let selection = new Set(), activeTool = 'select', editing = null;
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
    const hasElements = workspace.cards.length + workspace.items.length > 0;
    $('#minimap-toggle').disabled = !hasElements;
    $('#minimap-toggle').setAttribute('aria-pressed', String(minimapVisible));
    minimap.hidden = !minimapVisible || !hasElements || !!focused;
    if (minimap.hidden || minimapMap.clientWidth <= 20 || minimapMap.clientHeight <= 20) return;
    const boardItems = workspace.items.filter(item => item.type !== 'line');
    minimapLayout = minimapDrag?.layout || window.TerminalCanvasMinimap.layout([...workspace.cards, ...boardItems], workspace.camera,
        { width: viewport.clientWidth, height: viewport.clientHeight }, minimapMap.clientWidth, minimapMap.clientHeight);
    const nodes = workspace.cards.map((card, index) => {
        const node = document.createElement('div');
        const status = sessions.get(card.id)?.status;
        node.className = `minimap-card${selection.has(card.id) ? ' selected' : ''}${['running', 'starting'].includes(status) ? ' running' : ''}`;
        node.style.setProperty('--profile-color', profiles.find(profile => profile.id === card.profile).color);
        node.title = card.title;
        positionMinimapElement(node, minimapLayout.cards[index]);
        return node;
    }).concat(boardItems.map((item, index) => {
        const node = document.createElement('div');
        node.className = `minimap-item minimap-${item.type}${selection.has(item.id) ? ' selected' : ''}`;
        positionMinimapElement(node, minimapLayout.cards[workspace.cards.length + index]);
        return node;
    }));
    $('#minimap-cards').replaceChildren(...nodes);
    const view = visibleWorld();
    positionMinimapElement($('#minimap-viewport'), {
        x: view.x * minimapLayout.scale + minimapLayout.offsetX,
        y: view.y * minimapLayout.scale + minimapLayout.offsetY,
        w: view.w * minimapLayout.scale,
        h: view.h * minimapLayout.scale
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
function renderCardGeometry(card) {
    const el = sessions.get(card.id)?.element;
    if (!el) return;
    Object.assign(el.style, { left: `${card.x}px`, top: `${card.y}px`, width: `${card.w}px`, height: `${card.h}px` });
}
function renderGeometry(card) {
    renderCardGeometry(card); renderLines(); renderSelectionBox(); renderMinimap();
}
function refresh() {
    renderMinimap();
    const running = [...sessions.values()].filter(s => ['running', 'starting'].includes(s.status)).length;
    $('#card-count').textContent = workspace.cards.length;
    $('#outline-count').textContent = String(workspace.cards.length).padStart(2, '0');
    $('#running-count').textContent = `${running} running`;
    $('#terminal-total').textContent = `${workspace.cards.length} terminal${workspace.cards.length === 1 ? '' : 's'}`;
    $('#empty-state').hidden = workspace.cards.length + workspace.items.length > 0;
    $('#focus-toggle').disabled = !findCard(selected);
    const filter = $('#search').value.toLowerCase();
    const outline = $('#outline');
    outline.replaceChildren();
    workspace.cards.filter(c => `${c.title} ${c.cwd} ${c.profile}`.toLowerCase().includes(filter)).forEach(card => {
        const s = sessions.get(card.id);
        const button = document.createElement('button');
        button.className = `outline-item ${selection.has(card.id) ? 'selected' : ''} ${s.status === 'running' ? 'running' : ''}`;
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
// Selecting one element selects its whole group. Shift toggles the group in or out of the selection.
function select(id, { additive = false } = {}) {
    const ids = id ? Geometry.expandGroups(new Set([id]), elementRecords()) : new Set();
    if (additive) {
        const present = [...ids].every(key => selection.has(key));
        for (const key of ids) present ? selection.delete(key) : selection.add(key);
    } else selection = ids;
    selected = selection.has(id) ? id : [...selection].at(-1) ?? null;
    applySelection(true, !additive);
}
function setSelection(ids) {
    selection = new Set(ids);
    if (!selection.has(selected)) selected = [...selection].at(-1) ?? null;
    applySelection(false);
}
// A plain click on a terminal focuses it even inside a group; Shift additions leave the keyboard to the board.
function applySelection(raise, focusTerminal = raise) {
    for (const [key, s] of sessions) s.element.classList.toggle('selected', selection.has(key));
    for (const [key, view] of itemViews) view.element.classList.toggle('selected', selection.has(key));
    viewport.classList.toggle('single-selection', selection.size === 1);
    const s = sessions.get(selected), item = findItem(selected);
    if (raise && s) {
        // Reparenting during pointerdown interrupts the browser's terminal focus handling.
        s.element.style.zIndex = String(++topCardZIndex);
        if (s.status === 'running' && focusTerminal) s.terminal?.focus();
    }
    if (raise && item && !['frame', 'line'].includes(item.type)) itemViews.get(item.id).element.style.zIndex = String(++topCardZIndex);
    // Board shortcuts need focus outside the terminal, which would otherwise receive Delete and Ctrl+G.
    if (selected && !(s && focusTerminal) && document.activeElement?.closest?.('.xterm')) viewport.focus({ preventScroll: true });
    renderSelectionBox(); renderStyleToolbar(); refresh();
}
function renderSelectionBox() {
    const box = $('#selection-box');
    const chosen = [...selection].map(findElement).filter(Boolean);
    const outer = chosen.length ? Geometry.outerGroup(chosen[0]) : null;
    const grouped = !!outer && chosen.every(e => Geometry.outerGroup(e) === outer);
    if (chosen.length < 2 && !grouped) { box.hidden = true; return; }
    const b = Geometry.unionBounds(chosen.map(boundsOf));
    Object.assign(box.style, { left: `${b.x - 8}px`, top: `${b.y - 8}px`, width: `${b.w + 16}px`, height: `${b.h + 16}px` });
    box.classList.toggle('grouped', grouped);
    box.hidden = false;
}
function pointerOnElement(event, id, handle) {
    if (event.button !== 0 || focused || editing === id) return;
    if (event.shiftKey) { event.preventDefault(); select(id, { additive: true }); return; }
    startMove(event, id, handle);
}
// What moves with the selection: grouped elements, everything inside a moved frame, and free line ends.
function movingElements() {
    const records = elementRecords();
    let ids = new Set(selection);
    for (const id of selection) {
        const frame = findItem(id);
        if (frame?.type === 'frame') Geometry.frameContents({ id, bounds: boundsOf(frame) }, records).forEach(key => ids.add(key));
    }
    ids = Geometry.expandGroups(ids, records);
    const elements = [...ids].map(findElement).filter(Boolean);
    return { rects: elements.filter(e => e.type !== 'line'), lines: elements.filter(e => e.type === 'line') };
}
function startMove(event, id, handle) {
    if (event.button !== 0 || focused || event.shiftKey) return;
    if (!selection.has(id)) select(id);
    const { rects, lines } = movingElements(), z = workspace.camera.z;
    const origins = rects.map(e => ({ e, x: e.x, y: e.y }));
    const ends = lines.map(line => ({ line, start: line.start.id ? null : { ...line.start }, end: line.end.id ? null : { ...line.end } }));
    const shift = (point, dx, dy) => ({ x: clampCoordinate(point.x + dx / z), y: clampCoordinate(point.y + dy / z) });
    beginDrag(handle, event, (dx, dy) => {
        for (const o of origins) { Object.assign(o.e, shift(o, dx, dy)); placeElement(o.e); }
        for (const o of ends) { if (o.start) o.line.start = shift(o.start, dx, dy); if (o.end) o.line.end = shift(o.end, dx, dy); }
        renderLines(); renderSelectionBox();
    }, moved => { if (moved) { renderMinimap(); changed(); } }, { history: true });
}
// Grouping wraps whole groups in a new outer group; ungrouping removes only the outermost level.
function groupSelection() {
    if (boardBusy()) return;
    const chosen = [...selection].map(findElement).filter(Boolean);
    if (Geometry.selectionUnits(chosen).size < 2) return toast('Select two or more items or groups to group them.');
    if (chosen.some(e => (e.groups?.length || 0) >= GROUP_DEPTH)) return toast(`Groups can be nested up to ${GROUP_DEPTH} levels deep.`);
    recordHistory();
    const paths = Geometry.groupPaths(chosen, newId());
    chosen.forEach((e, index) => setGroups(e, paths[index]));
    renderSelectionBox(); changed();
}
function ungroupSelection() {
    if (boardBusy()) return;
    const chosen = [...selection].map(findElement).filter(e => e?.groups);
    if (!chosen.length) return;
    recordHistory();
    const paths = Geometry.ungroupPaths(chosen);
    chosen.forEach((e, index) => setGroups(e, paths[index]));
    pruneGroups();
    renderSelectionBox(); changed();
}
// Keyboard deletion never closes terminals; their close button handles running processes.
function deleteSelection() {
    if (boardBusy()) return;
    const ids = [...selection].filter(id => findItem(id));
    if (ids.length) { recordHistory(); removeItems(ids); }
    else if (selection.size) toast('Use a terminal\'s close button to remove it.');
}
function centerCard(card) {
    const z = workspace.camera.z;
    workspace.camera.x = Math.max(-100000, Math.min(100000, (viewport.clientWidth - card.w * z) / 2 - card.x * z));
    workspace.camera.y = Math.max(-100000, Math.min(100000, (viewport.clientHeight - card.h * z) / 2 - card.y * z));
    renderCamera(); changed();
}
function fitCanvas() {
    if (focused) setFocus(null);
    const bounds = Geometry.unionBounds([...workspace.cards, ...workspace.items].map(boundsOf));
    if (!bounds) { workspace.camera = { x: 48, y: 48, z: 1 }; renderCamera(); return; }
    const minX = bounds.x, minY = bounds.y, maxX = bounds.x + Math.max(1, bounds.w), maxY = bounds.y + Math.max(1, bounds.h);
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
    renderCamera(); renderStyleToolbar();
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
    toggle.title = ['running', 'starting'].includes(value) ? 'Stop terminal' : card.session ? 'Resume session' : 'Start terminal';
    toggle.setAttribute('aria-label', toggle.title);
    s.placeholder.hidden = ['running', 'starting'].includes(value) || value === 'exited';
    if (message) s.element.querySelector('.placeholder-copy').textContent = message;
    s.element.querySelector('[data-action="fresh-shell"]').disabled = ['running', 'starting'].includes(value);
    refresh();
}
function recoveryInfo(card) {
    const s = sessions.get(card.id); if (!s) return;
    if (['running', 'starting'].includes(s.status)) showDirectory(s, s.cwd);
    else showDirectory(s, card.cwd || 'Home directory');
    s.element.querySelector('[data-action="start"]').innerHTML = icon('play') + (card.session ? 'Resume session' : 'Start terminal');
    s.element.querySelector('.placeholder-copy').textContent = card.session
        ? `Saved ${card.session.provider === 'claude' ? 'Claude Code' : 'Codex'} session ${card.session.sessionId.slice(0, 8)}. Resume it, or open a fresh shell.`
        : card.command ? `Ready to run: ${card.command}. No saved AI session ID is available.` : 'Your shell is ready. Start when you are.';
    if (!['running', 'starting'].includes(s.status)) {
        const toggle = s.element.querySelector('[data-action="toggle"]');
        toggle.title = card.session ? 'Resume session' : 'Start terminal';
        toggle.setAttribute('aria-label', toggle.title);
    }
}
function mount(card) {
    const profile = profiles.find(p => p.id === card.profile);
    const el = document.createElement('article'); el.className = 'terminal-card'; el.dataset.id = card.id;
    el.style.zIndex = String(++topCardZIndex);
    el.innerHTML = `<div class="card-header"><span class="card-title"></span><span class="card-status"><i></i><span class="status-text">Ready</span></span><div class="card-actions"><button class="icon-button" data-action="duplicate" title="Duplicate: new shell in current directory (Ctrl+Shift+D)" aria-label="Duplicate terminal (Ctrl+Shift+D)">${icon('copy')}</button><button class="icon-button" data-action="toggle" title="Start terminal" aria-label="Start terminal">${icon('play')}</button><button class="icon-button" data-action="fresh-shell" title="Start fresh shell" aria-label="Start fresh shell">${icon('terminal')}</button><button class="icon-button" data-action="focus" title="Focus terminal" aria-label="Focus terminal">${icon('maximize')}</button><button class="icon-button" data-action="close" title="Close terminal" aria-label="Close terminal">${icon('x')}</button></div></div><div class="card-directory">${icon('folder')}<span></span></div><div class="terminal-body"><div class="terminal-placeholder"><span class="placeholder-icon">${icon('terminal')}</span><p class="placeholder-copy"></p><button class="button" data-action="start">${icon('play')}Start terminal</button><button class="button" data-action="fresh">Start fresh shell</button></div></div><div class="card-resize" title="Drag to resize"></div>`;
    el.querySelector('.card-header').prepend(mark(profile));
    el.querySelector('.card-title').textContent = card.title;
    const s = { element: el, status: 'idle', generation: 0, terminal: null, fit: null, metadataRevision: 0, placeholder: el.querySelector('.terminal-placeholder') };
    sessions.set(card.id, s); world.append(el); renderGeometry(card);
    recoveryInfo(card);
    if (window.Terminal && window.FitAddon) {
        s.terminal = new window.Terminal({
            fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace", fontSize: 12, lineHeight: 1.3,
            cursorBlink: true, scrollback: 5000, allowProposedApi: false,
            linkHandler: {
                allowNonHttpProtocols: false,
                activate(event, uri) {
                    if (!event.isTrusted || event.button !== 0) return;
                    event.preventDefault();
                    run(() => invoke('open-link', uri));
                }
            },
            theme: { background: '#15191f', foreground: '#c8d1dc', cursor: '#c8ecb5', selectionBackground: '#52694e80', black: '#29313d', red: '#e59a91', green: '#b5d69a', yellow: '#dfc68c', blue: '#94b5e8', magenta: '#baa0da', cyan: '#91cbc7', white: '#d5dce5', brightBlack: '#667486', brightRed: '#f0b2a9', brightGreen: '#c8ecb5', brightYellow: '#f1dbab', brightBlue: '#b2cdff', brightMagenta: '#d8bcf6', brightCyan: '#b1e4df', brightWhite: '#f0f4fa' }
        });
        s.fit = new window.FitAddon.FitAddon(); s.terminal.loadAddon(s.fit); s.terminal.open(el.querySelector('.terminal-body'));
        s.terminal.onData(data => {
            // ConPTY can ask for its cursor before the start invoke resolves.
            // Answer an observed query while keeping early user typing blocked.
            const startupReply = s.status === 'starting' && s.startupCursorQueries > 0 && /^\x1b\[\d+;\d+R$/.test(data);
            if (startupReply) s.startupCursorQueries--;
            if (s.status === 'running' || startupReply) bridge.input(card.id, data);
        });
        s.terminal.onResize(({ cols, rows }) => { if (['running', 'starting'].includes(s.status)) bridge.resize(card.id, cols, rows); });
        s.terminal.attachCustomKeyEventHandler(event => {
            const key = event.key.toLowerCase();
            if (event.altKey || event.isComposing) return true;
            if ((event.ctrlKey || event.metaKey) && ((!event.shiftKey && ['s', 'o'].includes(key)) || (event.shiftKey && ['n', 'f', 'd'].includes(key)))) return false;
            const modified = event.ctrlKey || event.metaKey;
            const copy = modified && key === 'c' && (event.shiftKey || event.metaKey || s.terminal.hasSelection());
            const paste = modified && key === 'v';
            if (!copy && !paste) return true; // Selection-free Ctrl+C remains xterm's shell interrupt.
            // Returning false only bypasses xterm; cancel Chromium's native clipboard action too.
            event.preventDefault();
            event.stopPropagation();
            if (event.type === 'keydown') {
                const text = copy ? s.terminal.getSelection() : '';
                if (copy && text) run(() => invoke('clipboard-write', text));
                if (paste && s.status === 'running') {
                    // Capture at keydown: restart can happen before the queued clipboard read begins.
                    const generation = s.generation;
                    run(async () => {
                        const { text } = await invoke('clipboard-read');
                        if (sessions.get(card.id) === s && s.status === 'running' && s.generation === generation) s.terminal.paste(text);
                    });
                }
            }
            return false;
        });
        s.observer = new ResizeObserver(() => fitTerminal(s));
        s.observer.observe(el.querySelector('.terminal-body'));
        requestAnimationFrame(() => fitTerminal(s));
    }
    el.addEventListener('pointerdown', event => {
        if (event.shiftKey) select(card.id, { additive: true });
        else if (!selection.has(card.id)) select(card.id);
        else if (selected !== card.id) { selected = card.id; applySelection(true); }
    });
    el.querySelectorAll('[data-action]').forEach(button => button.onclick = () => run(async () => {
        const action = button.dataset.action;
        if (action === 'duplicate') await duplicateTerminal(card);
        if (action === 'focus') setFocus(focused ? null : card.id);
        if (action === 'start') await start(card);
        if (action === 'fresh' || action === 'fresh-shell') await start(card, 'fresh');
        if (action === 'toggle') {
            if (s.status === 'starting') return;
            if (s.status === 'running') { await invoke('stop', { id: card.id }); s.terminal?.writeln('\r\n\x1b[90m[Terminal stopped]\x1b[0m'); setStatus(card, 'exited'); }
            else await start(card);
        }
        if (action === 'close') {
            if (['running', 'starting'].includes(s.status) && !await confirmAction('Close this terminal?', 'Its running shell and child processes will be stopped. Terminal output is not saved.', 'Close terminal')) return;
            await invoke('stop', { id: card.id });
            removeCard(card);
        }
    }));
    const header = el.querySelector('.card-header');
    header.addEventListener('pointerdown', event => { if (!event.target.closest('button')) startMove(event, card.id, header); });
    drag(el.querySelector('.card-resize'), () => !focused, (dx, dy, initial) => {
        card.w = Math.max(400, Math.min(2400, initial.w + dx / workspace.camera.z));
        card.h = Math.max(280, Math.min(1800, initial.h + dy / workspace.camera.z));
        renderGeometry(card);
    }, () => ({ w: card.w, h: card.h }));
}
// Closing a terminal is not undoable; undo steps that refer to it leave its connectors with free ends.
function removeCard(card) {
    if (focused === card.id) setFocus(null);
    detachConnectors([card.id]);
    dispose(card.id); workspace.cards = workspace.cards.filter(c => c.id !== card.id);
    pruneGroups();
    selection.delete(card.id);
    if (selected === card.id) selected = [...selection].at(-1) ?? null;
    renderLines(); applySelection(false); changed();
}
function dispose(id) {
    const s = sessions.get(id); if (!s) return;
    s.observer?.disconnect(); s.terminal?.dispose(); s.element.remove(); sessions.delete(id);
}
function showDirectory(s, cwd) {
    s.cwd = cwd;
    const label = cwd || 'Current directory unavailable';
    s.element.querySelector('.card-directory span').textContent = label;
    s.element.querySelector('.card-directory').title = label;
}
// `launch` names the program's request that opened this card, so the host can log its output.
async function start(card, mode = card.session ? 'resume' : 'start', launch) {
    const s = sessions.get(card.id);
    if (!s || ['running', 'starting'].includes(s.status)) return;
    if (!s.terminal) throw new Error('Live terminals require the desktop app and installed xterm dependencies. Run npm install, then npm start.');
    s.generation++;
    s.startupCursorQueries = 0; s.startupQueryTail = '';
    s.terminal.reset(); fitTerminal(s); showDirectory(s, null); setStatus(card, 'starting');
    try {
        clearTimeout(autosaveTimer);
        await invoke('autosave', workspace);
        const metadataRevision = s.metadataRevision;
        const result = await invoke('start', { card, cols: s.terminal.cols, rows: s.terminal.rows, mode, ...(launch ? { launch } : {}) });
        if (sessions.get(card.id) !== s) return;
        if (s.metadataRevision === metadataRevision) {
            if (result.cwd) card.cwd = result.cwd;
            if (result.session) card.session = result.session;
        }
        recoveryInfo(card); changed();
        if (s.status === 'starting') setStatus(card, 'running');
        s.terminal.focus();
    } catch (error) { showDirectory(s, card.cwd || 'Home directory'); setStatus(card, 'idle', error.message); throw error; }
}
// Tracks one pointer from `event` until release. `move(dx, dy, e)` gets screen deltas; `end(moved, e)` runs once.
// With `history`, nothing moves until the pointer passes the click threshold; that first movement
// records an undo step, so a click records nothing and later steps stay in order. A cancelled drag
// is put back where it started.
function beginDrag(element, event, move, end, { history = false } = {}) {
    // A drag whose release never arrived (the window lost focus first) ends where it last was.
    for (const stop of [...openDrags]) stop();
    event.preventDefault(); element.setPointerCapture(event.pointerId);
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false, done = false, step = null, last = event;
    activeDrags++;
    const stop = () => finish(last);
    openDrags.add(stop);
    const update = e => {
        if (done || e.pointerId !== event.pointerId) return;
        last = e;
        const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (history && !moved) return;
        if (history && !step) { step = snapshotBoard(); commitHistory(step); }
        move(dx, dy, e);
    };
    // If the captured element is removed mid-drag, the release goes elsewhere; the window still sees it.
    const finish = e => {
        if (done || e.pointerId !== event.pointerId) return;
        done = true;
        openDrags.delete(stop);
        for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) element.removeEventListener(type, type === 'pointermove' ? update : finish);
        window.removeEventListener('pointerup', finish, true); window.removeEventListener('pointercancel', finish, true);
        activeDrags--;
        if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
        const cancelled = e.type === 'pointercancel';
        if (step && cancelled) { restoreBoard(step); discardHistory(step); }
        end?.(moved && !cancelled, e);
        notifyBoardIdle();
    };
    element.addEventListener('pointermove', update);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, finish);
    window.addEventListener('pointerup', finish, true); window.addEventListener('pointercancel', finish, true);
}
const openDrags = new Set();
window.addEventListener('blur', () => { for (const stop of [...openDrags]) stop(); });
function drag(element, allowed, move, initial) {
    element.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !allowed(event)) return;
        const data = initial();
        beginDrag(element, event, (dx, dy) => move(dx, dy, data), moved => { if (moved) changed(); }, { history: true });
    });
}
const onCanvasChrome = target => !!target.closest('.canvas-toolbar, .create-toolbar, .style-toolbar, .minimap, .exit-focus');
// Capture phase: finish in-place edits, and let creation tools draw over existing elements.
viewport.addEventListener('pointerdown', event => {
    if (editing && !event.target.closest('.item-editor, .frame-title-editor')) document.activeElement?.blur();
    if (!ready || focused || event.button !== 0 || !CREATION_TOOLS.includes(activeTool) || onCanvasChrome(event.target)) return;
    event.stopPropagation();
    beginCreate(event);
}, true);
viewport.addEventListener('pointerdown', event => {
    if (!ready || focused || event.target.closest('button') || onCanvasChrome(event.target)) return;
    const empty = event.target === viewport || event.target === world || !!event.target.closest('.empty-state');
    if (event.button !== 1 && !(event.button === 0 && (hand || empty))) return;
    if (event.button === 0 && event.shiftKey && !hand) {
        // Shift-drag on empty canvas draws a selection rectangle; plain drag keeps panning.
        const start = toWorld(event), draft = $('#draft');
        let rect = { ...start, w: 0, h: 0 };
        draft.classList.add('marquee');
        beginDrag(viewport, event, (_dx, _dy, e) => {
            rect = Geometry.rectFromPoints(start, toWorld(e)); draft.hidden = false;
            Object.assign(draft.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
        }, moved => {
            draft.hidden = true; draft.classList.remove('marquee');
            if (moved) setSelection([...selection, ...Geometry.expandGroups(new Set(Geometry.marquee(rect, elementRecords())), elementRecords())]);
        });
        return;
    }
    viewport.classList.add('panning');
    const initial = { ...workspace.camera };
    beginDrag(viewport, event, (dx, dy) => {
        workspace.camera.x = clampCoordinate(initial.x + dx);
        workspace.camera.y = clampCoordinate(initial.y + dy); renderCamera();
    }, moved => {
        viewport.classList.remove('panning');
        if (moved) changed();
        else if (event.button === 0 && empty) setSelection([]);
    });
});
viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (!ready) return;
    // Wheel events from a zoomed terminal carry coordinates rewritten for xterm; zoom around the real pointer.
    const rect = viewport.getBoundingClientRect(), point = window.TerminalCanvasPointer?.clientPoint(event) ?? { x: event.clientX, y: event.clientY };
    zoom(Math.exp(-event.deltaY * .002), { x: point.x - rect.left, y: point.y - rect.top });
}, { passive: false });
async function duplicateTerminal(source) {
    if (!ready || duplicateBusy || document.querySelector('dialog[open]')) return;
    if (workspace.cards.length >= 24) return toast('A workspace can contain up to 24 terminals.');
    duplicateBusy = true;
    try {
        const result = await invoke('duplicate-directory', source);
        if (findCard(source.id) !== source || document.querySelector('dialog[open]')) return;
        if (result.warning) {
            openLaunch('shell');
            $('#cwd').value = result.cwd;
            $('#launch-error').textContent = result.warning;
            $('#launch-error').hidden = false;
            return;
        }
        if (workspace.cards.length >= 24) return toast('A workspace can contain up to 24 terminals.');
        const { card } = await invoke('create-card', { profile: 'shell', command: '', cwd: result.cwd, x: clampCoordinate(source.x + 40), y: clampCoordinate(source.y + 40) });
        if (findCard(source.id) !== source || document.querySelector('dialog[open]')) return;
        if (workspace.cards.length >= 24) return toast('A workspace can contain up to 24 terminals.');
        workspace.cards.push(card); mount(card); select(card.id); changed(); refresh();
        if (focused) setFocus(card.id);
        await start(card);
    } finally { duplicateBusy = false; }
}
// A program asked for a new terminal with `tc-hook new-terminal`: an agent of any kind, a harness, or
// a script. From inside a terminal (`event.id`), it opens beside that terminal, joined to it by an
// arrow. From outside the canvas (`event.external`), it opens beside the named `event.parent`, or in
// view when there is none. The host validated the request; requests open one at a time, in order.
// Every outcome is reported back as `launch-result`, so the program learns the new card's ID or why
// nothing opened.
let terminalRequests = Promise.resolve();
let markAppReady;
const appReady = new Promise(resolve => { markAppReady = resolve; });
function requestTerminal(event) {
    const report = outcome => { if (event.request) invoke('launch-result', { request: event.request, ...outcome }).catch(() => {}); };
    terminalRequests = terminalRequests.then(async () => {
        try { report({ card: (await openRequestedTerminal(event)).id }); }
        catch (error) { report({ error: error.message }); toast(error.message); }
    });
}
// Returns the started card, or throws why it could not open.
async function openRequestedTerminal(event) {
    await appReady;
    let parent = findCard(event.external ? event.parent : event.id) || null;
    const closed = 'The terminal that asked for a new terminal has closed.';
    if (!event.external && !parent) throw new Error(closed);
    const requester = () => parent?.title || 'A program';
    const ensureRoom = () => {
        if (workspace.cards.length >= 24) throw new Error(`${requester()} asked for a new terminal, but a workspace can contain up to 24 terminals.`);
    };
    ensureRoom();
    await whenBoardIdle();
    const size = { w: 660, h: 430 };
    const taken = [...workspace.cards, ...workspace.items.filter(item => item.type !== 'line')].map(boundsOf);
    const spot = parent ? Geometry.placeBeside(parent, size, taken) : Geometry.placeNear(viewportCenterWorld(), size, taken);
    const { card } = await invoke('create-card', { profile: event.profile, title: event.title, cwd: event.cwd, command: event.command, x: clampCoordinate(spot.x), y: clampCoordinate(spot.y) });
    if (parent && !workspace.cards.includes(parent)) {
        if (!event.external) throw new Error(closed);
        parent = null;
    }
    ensureRoom();
    await whenBoardIdle();
    workspace.cards.push(card); mount(card);
    if (parent && workspace.items.length < ITEM_LIMIT) {
        recordHistory();
        const arrow = { id: newId(), type: 'line', start: { id: parent.id }, end: { id: card.id }, arrow: true };
        workspace.items.push(arrow); mountLine(arrow);
    }
    renderLines(); select(card.id); changed(); refresh();
    if (focused) setFocus(card.id);
    else if (!Geometry.intersects(visibleWorld(), card)) centerCard(card);
    toast(`${requester()} opened a new terminal: ${card.title}.`);
    await start(card, undefined, event.request);
    return card;
}
function openLaunch(profileId = 'shell') {
    if (!ready || document.querySelector('dialog[open]')) return;
    if (workspace.cards.length >= 24) return toast('A workspace can contain up to 24 terminals.');
    const profile = profiles.find(p => p.id === profileId);
    $('#profile').value = profile.id; $('#terminal-title').value = profile.name; $('#command').value = profile.command;
    $('#launch-error').hidden = true; $('#launch-dialog').showModal();
}
$('#profile').onchange = () => { const p = profiles.find(p => p.id === $('#profile').value); $('#terminal-title').value = p.name; $('#command').value = p.command; };
$('#browse-folder').onclick = () => run(async () => { const result = await invoke('pick-folder', { cwd: $('#cwd').value.trim() }); if (result.path) $('#cwd').value = result.path; });
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
    if (editing) document.activeElement?.blur();
    workspace = board;
    workspace.items = Array.isArray(board.items) ? board.items : [];
    clearHistory();
    // The browser preview stores unvalidated layouts, which may still use format 2's single group.
    for (const e of [...workspace.cards, ...workspace.items]) {
        if (e.group && !e.groups) e.groups = [e.group];
        delete e.group;
    }
    setFocus(null);
    for (const id of sessions.keys()) dispose(id);
    for (const id of [...itemViews.keys()]) disposeItem(id);
    topCardZIndex = 0;
    selected = null; selection = new Set(); $('#workspace-name').value = board.name;
    board.cards.forEach(mount); workspace.items.forEach(mountItem); renderCamera(); applySelection(false);
}
async function canReplace() {
    if (!workspace.cards.length && !workspace.items.length) return true;
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
    if (!ready || boardBusy()) return; setFocus(null);
    const columns = Math.max(1, Math.ceil(Math.sqrt(workspace.cards.length)));
    recordChange(() => workspace.cards.forEach((c, i) => { c.x = (i % columns) * 700; c.y = Math.floor(i / columns) * 470; c.w = 660; c.h = 430; renderGeometry(c); }));
    fitCanvas();
};
$('#focus-toggle').onclick = () => { if (ready) setFocus(focused ? null : selected); };
$('#exit-focus').onclick = () => setFocus(null);
$('#fit').onclick = () => { if (ready) fitCanvas(); };
$('#zoom-in').onclick = () => { if (ready) zoom(1.15); };
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#zoom-out').onclick = () => { if (ready) zoom(1 / 1.15); };
$('#zoom-reset').onclick = () => { if (ready) zoom(1 / workspace.camera.z); };
function setTool(name) {
    if (editing) document.activeElement?.blur();
    activeTool = name; hand = name === 'hand';
    viewport.classList.toggle('hand', hand);
    viewport.classList.toggle('creating', CREATION_TOOLS.includes(name));
    document.querySelectorAll('[data-tool]').forEach(button => {
        button.classList.toggle('active', button.dataset.tool === name);
        button.setAttribute('aria-pressed', String(button.dataset.tool === name));
    });
}
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { if (ready) setTool(button.dataset.tool); });
document.querySelectorAll('[data-color]').forEach(button => button.onclick = () => { if (ready) setItemColor(button.dataset.color); });
document.querySelectorAll('[data-font-size]').forEach(button => button.onclick = () => { if (ready) setItemFontSize(button.dataset.fontSize); });
$('#image-tool').onclick = () => run(async () => {
    if (!ready || focused) return;
    await importing(async () => {
        const result = await invoke('pick-image');
        if (result.asset) await placeImage(result.asset, viewportCenterWorld());
    });
});
$('#clean-images').onclick = () => run(async () => { if (ready) await cleanUpImages(); });
$('#export-workspace').onclick = () => run(async () => {
    if (!ready) return;
    workspace.name = $('#workspace-name').value.trim() || 'Untitled workspace';
    const result = await invoke('export', workspace);
    if (result.canceled) return;
    const images = `${result.images} image${result.images === 1 ? '' : 's'}`;
    toast(result.missing ? `Portable copy exported with ${images}. ${result.missing} missing image${result.missing === 1 ? ' was' : 's were'} not included.` : `Portable copy exported${result.images ? ` with ${images} embedded` : ''}.`);
});
document.addEventListener('paste', event => {
    if (!ready || focused || document.querySelector('dialog[open]') || event.target?.closest?.('input,textarea,.xterm')) return;
    if (pasteFromClipboard(event.clipboardData)) event.preventDefault();
});
viewport.addEventListener('dragover', event => {
    if (!ready || focused || ![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
viewport.addEventListener('drop', event => {
    if (!ready || focused || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    const point = toWorld(event);
    run(async () => { if (!await importImageFiles(event.dataTransfer.files, point)) toast('Drop PNG, JPEG, GIF, or WebP images.'); });
});
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
function info(title, body) { $('#info-title').textContent = title; $('#info-content').innerHTML = body; $('#info-dialog').showModal(); }
$('#help').onclick = () => info('A workspace that moves with you.', '<p class="info-copy">Launch a terminal for each task or AI agent. Drag its header to move it, pull the bottom-right corner to resize, and use Focus for uninterrupted work.</p><div class="help-grid"><span>New terminal</span><kbd>Ctrl Shift N</kbd><span>Duplicate selected terminal (fresh shell)</span><kbd>Ctrl Shift D</kbd><span>Save / open workspace</span><kbd>Ctrl S / Ctrl O</kbd><span>Toggle focused terminal</span><kbd>Ctrl Shift F</kbd><span>Copy selected terminal text</span><kbd>Ctrl C / Ctrl Shift C</kbd><span>Paste terminal text</span><kbd>Ctrl V / Ctrl Shift V</kbd><span>Interrupt (clear text selection first)</span><kbd>Ctrl C</kbd><span>Select / hand / text / note</span><kbd>V / H / T / N</kbd><span>Rectangle / ellipse / frame</span><kbd>R / O / F</kbd><span>Line / arrow (drag between items to connect)</span><kbd>L / A</kbd><span>Add to selection / select area</span><kbd>Shift click / Shift drag</kbd><span>Group / ungroup (groups can nest)</span><kbd>Ctrl G / Ctrl Shift G</kbd><span>Undo / redo board changes</span><kbd>Ctrl Z / Ctrl Shift Z</kbd><span>Copy / cut / paste / duplicate items</span><kbd>Ctrl C / X / V / D</kbd><span>Edit text / delete items</span><kbd>Double-click / Delete</kbd><span>Add an image</span><kbd>Paste or drop a file</kbd><span>Pan the canvas</span><kbd>Drag background / middle-drag</kbd><span>Zoom at pointer</span><kbd>Ctrl + scroll</kbd></div><p class="info-note">Terminal shortcuts work in canvas and fullscreen Focus views. Ctrl C copies selected text and interrupts the shell when no text is selected. Click inside the terminal to clear a text selection before interrupting. On macOS, Command C/V also copy/paste; Ctrl C still interrupts without a selection.</p><p class="info-note">Workspaces save layouts, folders, launch commands, and board items. Images stay in this app&rsquo;s data folder; use Export portable copy to embed them in a file you can move to another computer. Terminal output and running processes are not restored. Commands only run when you start a terminal.</p>');
$('#plugins').onclick = () => info('One canvas. More possibilities.', '<p class="info-copy">Terminal Canvas starts with a terminal card type and a desktop host API. This is the foundation for bringing other tools into the workspace.</p><p class="info-note"><strong>WebCanvas · Planned</strong><br>Browser cards alongside AI terminals, using isolated browser views. Plugin loading and browser integration are not implemented in this version.</p>');
document.addEventListener('keydown', event => {
    if (!ready || document.querySelector('dialog[open]')) return;
    if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 's') { event.preventDefault(); run(save); }
        if (key === 'o') { event.preventDefault(); $('#open-workspace').click(); }
        if (key === 'd' && event.shiftKey && !event.altKey && !event.repeat && !event.target.closest('input,select,textarea:not(.xterm-helper-textarea),[contenteditable="true"]')) {
            const card = findCard(event.target.closest('.terminal-card')?.dataset.id || selected);
            if (card) { event.preventDefault(); run(() => duplicateTerminal(card)); }
        }
        if (key === 'n' && event.shiftKey) { event.preventDefault(); openLaunch(); }
        if (key === 'f' && event.shiftKey) { event.preventDefault(); if (findCard(selected)) setFocus(focused ? null : selected); }
        const onBoard = !focused && !event.target.closest('input,textarea,select,.xterm');
        if (key === 'g' && onBoard) { event.preventDefault(); event.shiftKey ? ungroupSelection() : groupSelection(); }
        if (((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) && onBoard) { event.preventDefault(); redo(); }
        else if (key === 'z' && onBoard) { event.preventDefault(); undo(); }
        // Ctrl+V arrives as a paste event, which also carries images from other apps.
        if (!event.shiftKey && onBoard && (key === 'c' || key === 'x') && copySelection({ cut: key === 'x' })) event.preventDefault();
        if (!event.shiftKey && onBoard && key === 'd') { event.preventDefault(); duplicateSelection(); }
        return;
    }
    if (event.altKey || event.target.closest('input,textarea,select,.xterm')) return;
    if (event.key === '/') { event.preventDefault(); $('#search').focus(); return; }
    if (focused) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
    if (event.key === 'Escape') { if (activeTool !== 'select') setTool('select'); else setSelection([]); return; }
    const shortcut = { v: 'select', h: 'hand', t: 'text', n: 'note', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', f: 'frame' }[event.key.toLowerCase()];
    if (shortcut && !event.shiftKey) { event.preventDefault(); setTool(shortcut); }
});
window.addEventListener('resize', () => { if (ready) renderCamera(); });
if (bridge) {
    bridge.onEvent(event => {
        const s = sessions.get(event.id);
        if (event.type === 'metadata') {
            const card = workspace?.cards.find(c => c.id === event.id);
            if (card) {
                if (s) s.metadataRevision++;
                if (s && !event.initial && event.cwd !== card.cwd) s.cwd = event.cwd;
                card.cwd = event.cwd;
                if (event.session) card.session = event.session;
                recoveryInfo(card); changed(); refresh();
            }
        }
        if (event.type === 'data') {
            if (s?.status === 'starting') {
                const output = (s.startupQueryTail || '') + event.data;
                s.startupCursorQueries += [...output.matchAll(/\x1b\[6n/g)].length;
                s.startupQueryTail = output.slice(-3);
            }
            if (s?.terminal) s.terminal.write(event.data, () => bridge.acknowledge(event.id, event.data.length));
            else bridge.acknowledge(event.id, event.data.length);
        }
        if (event.type === 'cwd' && s) showDirectory(s, event.cwd);
        if (event.type === 'exit' && s) { s.terminal?.writeln(`\r\n\x1b[90m[Process exited · code ${event.exitCode}]\x1b[0m`); setStatus(workspace.cards.find(c => c.id === event.id), 'exited'); }
        if (event.type === 'error') toast(event.message);
        if (event.type === 'launch') requestTerminal(event);
        if (event.type === 'closing') run(async () => {
            if (event.running && !await confirmAction('Close Terminal Canvas?', `${event.running} running terminal${event.running === 1 ? '' : 's'} will stop. Your layout will be saved; terminal output will not.`, 'Close app')) return;
            clearTimeout(autosaveTimer); await invoke('close', workspace);
        });
    });
    run(async () => {
        const initial = await invoke('initialize'); profiles = initial.profiles;
        $('#platform-chrome').media = initial.platform === 'darwin' ? 'all' : 'not all';
        for (const p of profiles) {
            const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; $('#profile').append(option);
            const button = document.createElement('button'); button.className = 'profile-button'; button.append(mark(p));
            const label = document.createElement('span'); label.textContent = p.name; button.append(label);
            const arrow = document.createElement('span'); arrow.className = 'launch-arrow'; arrow.innerHTML = icon('plus'); button.append(arrow);
            button.onclick = () => openLaunch(p.id); $('#profile-list').append(button);
        }
        $('#cwd').value = initial.home; $('#runtime-label').textContent = initial.preview ? 'Browser preview · shells unavailable' : initial.platform === 'win32' ? 'Windows · ConPTY' : 'Local · PTY';
        loadWorkspace(initial.workspace); ready = true; markAppReady(); renderStyleToolbar();
        if (initial.warning) toast(initial.warning);
    });
} else toast('Desktop bridge unavailable. Run cargo run -p terminal-canvas.');
