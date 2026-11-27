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
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4Z"/><path d="M19 15v4m-2-2h4"/>',
    columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    rows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.terminal}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
const bridge = window.terminalCanvas;
const viewport = $('#viewport');
const world = $('#world');
const minimap = $('#minimap');
const minimapMap = $('#minimap-map');
const sessions = new Map();
// Whole CSS pixels; a card leaves out its `fontSize` at the default. The host validates the same range.
const TERMINAL_FONT = window.TerminalCanvasItemStyles.TERMINAL_FONT_SIZE;
// Terminals sit inside the zoomed world; xterm needs mouse coordinates without that scale.
window.TerminalCanvasPointer?.install(window);
let workspace, profiles = [], selected, focused, hand = false, autosaveTimer, toastTimer, saveRevision = 0, confirmation;
let ready = false, formBusy = false, duplicateBusy = false, activeDrags = 0;
let topCardZIndex = 0;
let minimapVisible = true, minimapLayout, minimapDrag;
// UI preferences belong to this webview profile, never to a workspace or its undo history.
const SIDEBAR_PREFERENCE_KEY = 'terminal-canvas.sidebar.v1';
const sidebarSections = { workspace: '#workspace-section', profiles: '#profile-list', outline: '#outline-section' };
const sidebarPreferences = { collapsed: false, workspace: false, profiles: false, outline: false };
try {
    const saved = JSON.parse(window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY));
    for (const key of Object.keys(sidebarPreferences)) {
        if (typeof saved?.[key] === 'boolean') sidebarPreferences[key] = saved[key];
    }
} catch { /* Missing, malformed, or unavailable storage keeps the expanded defaults. */ }
// Focus hides the sidebar temporarily; the toggle and search can reveal it for this Focus visit.
let focusSidebarRevealed = false;
// A Focus view of several terminals: `{ cardIds, orientation: 'row' | 'column', sizes }`, saved with its canvas.
let split = null;
function saveSidebarPreferences() {
    try { window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, JSON.stringify(sidebarPreferences)); }
    catch { /* A blocked or full store must not prevent using the sidebar. */ }
}
function renderSidebar({ preserveCenter = true } = {}) {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const sidebar = $('#sidebar'), toggle = $('#sidebar-toggle');
    const collapsed = sidebarPreferences.collapsed || (!!focused && !focusSidebarRevealed);
    if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
    sidebar.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Show sidebar' : 'Hide sidebar');
    toggle.title = `${collapsed ? 'Show' : 'Hide'} sidebar (Ctrl/Cmd+Shift+B)`;
    for (const [name, selector] of Object.entries(sidebarSections)) {
        const content = $(selector), disclosure = $(`#${name}-toggle`);
        const hidden = sidebarPreferences[name];
        if (hidden && content.contains(document.activeElement)) disclosure.focus();
        disclosure.setAttribute('aria-expanded', String(!hidden));
        // Keep the workspace count in its original place when expanded, and in the heading when hidden.
        if (name === 'workspace') {
            const parent = hidden ? disclosure : $('#canvas-nav');
            if ($('#card-count').parentElement !== parent) parent.append($('#card-count'));
        }
        content.hidden = hidden;
    }
    if (!ready) return;
    // Changing the available width must preserve the world point at the viewport's center.
    if (preserveCenter) {
        workspace.camera.x = Math.max(-100000, Math.min(100000, workspace.camera.x + (viewport.clientWidth - width) / 2));
        workspace.camera.y = Math.max(-100000, Math.min(100000, workspace.camera.y + (viewport.clientHeight - height) / 2));
    }
    renderCamera(); renderFocus();
    requestAnimationFrame(() => { for (const s of sessions.values()) fitTerminal(s); });
}
function setSidebarCollapsed(collapsed) {
    sidebarPreferences.collapsed = collapsed;
    if (focused) focusSidebarRevealed = !collapsed;
    renderSidebar(); saveSidebarPreferences();
}
$('#sidebar-toggle').onclick = () => setSidebarCollapsed(!$('#sidebar').hidden);
for (const name of Object.keys(sidebarSections)) {
    $(`#${name}-toggle`).onclick = () => {
        sidebarPreferences[name] = !sidebarPreferences[name];
        renderSidebar(); saveSidebarPreferences();
    };
}
renderSidebar();
// `selection` holds every selected terminal and item; `selected` is the primary one.
let selection = new Set(), activeTool = 'select', editing = null;
// The terminal reached with the keyboard, highlighted while the keyboard is on the board rather than in it.
let keyboardCurrent = null;
const mark = profile => {
    const el = document.createElement('span');
    el.className = 'profile-mark';
    el.style.setProperty('--profile-color', profile.color);
    el.textContent = profile.initials;
    return el;
};
// A longer message, such as a startup warning with its fix, stays up long enough to read.
function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, Math.max(6000, (message?.length || 0) * 60));
}
async function invoke(action, payload) {
    if (!bridge) throw new Error('Open Terminal Canvas with npm start.');
    if (bridge.remote && browserWorkspaceActions.has(action)) {
        if (action === 'pointer-configure') payload = { ...payload, workspace: undefined };
        return controlTerminal({ action: 'workspace-action', name: action, payload });
    }
    if (payload === workspace && ['autosave', 'save', 'export', 'close'].includes(action)) payload = workspaceSnapshot();
    const result = await bridge.invoke(action, payload);
    if (result?.error) throw new Error(result.error);
    return result;
}
function run(task) { Promise.resolve().then(task).catch(error => toast(error.message)); }
const remoteController = () => bridge?.remote && bridge.role === 'control' && !bridge.disconnected;
const browserWorkspaceActions = new Set(['agent-setup', 'claude-accounts', 'delete-unused-images', 'keep-running', 'pointer-check', 'pointer-configure', 'tmux-setup', 'unused-images']);
async function controlTerminal(command) {
    if (remoteController()) await saveRemoteLayout();
    return invoke('remote-terminal', { epoch: titleEpoch, command });
}
function changed() {
    if (!ready) return;
    if (bridge?.remote) {
        if (!remoteController()) return;
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => run(saveRemoteLayout), 500);
        return;
    }
    const revision = ++saveRevision;
    $('#save-state').lastChild.textContent = 'Saving…';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => run(async () => {
        await invoke('autosave', workspace);
        if (revision === saveRevision) $('#save-state').lastChild.textContent = 'Saved locally';
    }), 500);
}
function renderCamera() {
    closeCanvasMenu();
    const { x, y, z } = workspace.camera;
    world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    viewport.style.backgroundSize = `${24 * z}px ${24 * z}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    viewport.style.setProperty('--viewport-width', `${viewport.clientWidth}px`);
    viewport.style.setProperty('--viewport-height', `${viewport.clientHeight}px`);
    viewport.style.setProperty('--camera-zoom', String(z));
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
        applyItemStyle(card, node);
        node.title = terminalDisplayTitle(card);
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
// card.title is the effective title after automatic/manual precedence has been applied.
// Title updates call refresh() so both searches update without losing focus.
function terminalDisplayTitle(card) { return card.title; }
function matchingTerminals(query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return workspace.cards.filter(card => {
        const profile = profiles.find(p => p.id === card.profile);
        const text = [terminalDisplayTitle(card), card.cwd, sessions.get(card.id)?.cwd, card.profile, profile?.name].join(' ').toLowerCase();
        return terms.every(term => text.includes(term));
    });
}
function refresh() {
    for (const card of workspace.cards) {
        const title = sessions.get(card.id)?.element.querySelector('.card-title');
        if (title) {
            title.textContent = terminalDisplayTitle(card);
            title.title = `${terminalDisplayTitle(card)} · Click to rename`;
            title.setAttribute('aria-label', `Rename terminal: ${terminalDisplayTitle(card)}`);
        }
    }
    renderMinimap();
    renderCanvases();
    const running = [...sessions.values()].filter(s => ['running', 'starting'].includes(s.status)).length;
    $('#card-count').textContent = workspace.cards.length;
    $('#outline-count').textContent = String(workspace.cards.length).padStart(2, '0');
    $('#running-count').textContent = `${running} running`;
    $('#terminal-total').textContent = `${workspace.cards.length} terminal${workspace.cards.length === 1 ? '' : 's'}`;
    $('#empty-state').hidden = workspace.cards.length + workspace.items.length > 0;
    const terminals = [...selection].filter(id => findCard(id)).length;
    $('#focus-toggle').disabled = !findCard(selected) && !terminals;
    $('#focus-toggle').title = terminals > 1 ? 'Show the selected terminals in a split view (Ctrl+Shift+F)' : 'Focus the selected terminal (Ctrl+Shift+F)';
    const outline = $('#outline');
    outline.replaceChildren();
    matchingTerminals($('#search').value).forEach(card => {
        const s = sessions.get(card.id);
        // A workspace reload mounts cards one at a time; recovery updates can refresh mid-load.
        if (!s) return;
        const button = document.createElement('button');
        button.className = `outline-item ${selection.has(card.id) ? 'selected' : ''} ${s.status === 'running' ? 'running' : ''}`;
        applyItemStyle(card, button);
        button.append(mark(profiles.find(p => p.id === card.profile)));
        const label = document.createElement('span'); label.className = 'label'; label.textContent = terminalDisplayTitle(card);
        const dot = document.createElement('span'); dot.className = 'state-dot'; dot.title = s.status;
        button.append(label, dot);
        button.onclick = () => { if (focused) setFocus(null); showTerminal(card.id); };
        outline.append(button);
    });
    if (!outline.childElementCount) {
        const p = document.createElement('p'); p.className = 'outline-empty';
        p.textContent = workspace.cards.length ? 'No matching terminals.' : 'Your terminals will appear here.';
        outline.append(p);
    }
    renderTerminalSwitcher();
}
// Selecting one element selects its whole group. Shift toggles the group in or out of the selection.
// `type: false` selects a terminal without moving the keyboard into it.
function select(id, { additive = false, type = true } = {}) {
    const ids = id ? Geometry.expandGroups(new Set([id]), elementRecords()) : new Set();
    if (additive) {
        const present = [...ids].every(key => selection.has(key));
        for (const key of ids) present ? selection.delete(key) : selection.add(key);
    } else selection = ids;
    selected = selection.has(id) ? id : [...selection].at(-1) ?? null;
    applySelection(true, !additive && type);
}
function setSelection(ids) {
    selection = new Set(ids);
    if (!selection.has(selected)) selected = [...selection].at(-1) ?? null;
    applySelection(false);
}
// A plain click on a terminal focuses it even inside a group; Shift additions leave the keyboard to the board.
function applySelection(raise, focusTerminal = raise) {
    if (keyboardCurrent !== selected) keyboardCurrent = null;
    for (const [key, s] of sessions) {
        s.element.classList.toggle('selected', selection.has(key));
        s.element.classList.toggle('keyboard-current', key === keyboardCurrent);
    }
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
    if (bridge?.remote && (!remoteController() || remoteLayoutSave)) return;
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
// Keyboard navigation. The keyboard is either on the board, where Alt+Arrow moves the selection between
// terminals, or typing in one terminal, where everything except the app's Ctrl+Shift shortcuts reaches
// the program, Alt+Arrow included. Enter moves the keyboard into the selected terminal; Ctrl+Shift+E
// moves it back out to the board. Both work in Focus mode, where Alt+Arrow changes the focused terminal.
const NAV_DIRECTIONS = Object.freeze({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' });
// A revealed terminal keeps this far from the view's edges, and this far from the toolbars and minimap.
const REVEAL_INSET = Object.freeze({ left: 24, top: 24, right: 24, bottom: 24 });
const REVEAL_GAP = 16;
// The toolbars and minimap over the canvas, measured as currently laid out, in view coordinates.
// Hidden ones measure empty and are left out.
function canvasOverlays() {
    const area = viewport.getBoundingClientRect();
    return [$('.create-toolbar'), $('.canvas-toolbar'), $('#style-toolbar'), minimap].flatMap(element => {
        if (!element || element.hidden) return [];
        const r = element.getBoundingClientRect();
        if (!r.width || !r.height) return [];
        return [{ x: r.left - area.left - REVEAL_GAP, y: r.top - area.top - REVEAL_GAP, w: r.width + 2 * REVEAL_GAP, h: r.height + 2 * REVEAL_GAP }];
    });
}
// The terminal chosen from the keyboard in Focus mode, revealed once the canvas and its toolbars return.
let revealOnReturn = null;
function revealCard(card) {
    const view = { width: viewport.clientWidth, height: viewport.clientHeight };
    const camera = Geometry.revealCamera(workspace.camera, boundsOf(card), view, REVEAL_INSET, canvasOverlays());
    if (camera.x === workspace.camera.x && camera.y === workspace.camera.y) return;
    workspace.camera = camera; renderCamera(); changed();
}
function clearKeyboardCurrent() {
    if (!keyboardCurrent) return;
    sessions.get(keyboardCurrent)?.element.classList.remove('keyboard-current');
    keyboardCurrent = null;
}
// Selects the terminal with this ID, with its group, and leaves the keyboard on the board: the terminal
// is highlighted and panned into view at the current zoom. In Focus mode it becomes the focused terminal,
// and the canvas pans to it when Focus ends, once the toolbars it must clear are laid out again.
function showTerminal(id) {
    const canvas = canvasForCard(id);
    if (canvas && canvas !== activeCanvas && !switchCanvas(canvas.id)) return false;
    const card = findCard(id);
    if (!card) return false;
    keyboardCurrent = id;
    if (focused && focused !== id) setFocus(id, { type: false });
    else select(id, { type: false });
    if (focused) revealOnReturn = id;
    else revealCard(card);
    viewport.focus({ preventScroll: true });
    return true;
}
const terminalSwitcher = $('#terminal-switcher');
const switcherQuery = $('#switcher-query');
let switcherActive = null, switcherMatches = [], switcherReturnFocus = null;
// Shared entry point for the UI button, shortcut, and the context menu (#37).
function openTerminalSwitcher() {
    if (!ready || canvasMutation || activeDrags || document.querySelector('dialog[open]')) return false;
    switcherReturnFocus = document.activeElement;
    switcherQuery.value = '';
    switcherActive = focused || selected;
    terminalSwitcher.showModal();
    switcherQuery.setAttribute('aria-expanded', 'true');
    renderTerminalSwitcher();
    switcherQuery.focus({ preventScroll: true });
    return true;
}
function renderTerminalSwitcher() {
    if (!terminalSwitcher.open) return;
    const previousIndex = switcherMatches.indexOf(switcherActive);
    switcherMatches = matchingTerminals(switcherQuery.value).map(card => card.id);
    if (!switcherMatches.includes(switcherActive)) switcherActive = switcherMatches[Math.max(0, Math.min(previousIndex, switcherMatches.length - 1))] || null;
    const results = $('#switcher-results');
    results.replaceChildren(...switcherMatches.map(id => {
        const card = findCard(id), profile = profiles.find(p => p.id === card.profile);
        const option = document.createElement('div');
        option.id = `switcher-option-${id}`;
        option.className = 'switcher-option';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(id === switcherActive));
        option.append(mark(profile));
        const text = document.createElement('div'); text.className = 'switcher-text';
        const title = document.createElement('div'); title.className = 'switcher-title'; title.textContent = terminalDisplayTitle(card);
        const detail = document.createElement('div'); detail.className = 'switcher-detail';
        detail.textContent = `${profile.name} · ${sessions.get(id)?.cwd || card.cwd || 'No folder'} · ${sessions.get(id)?.status || 'idle'} · ${id}`;
        text.append(title, detail); option.append(text);
        option.title = `${title.textContent}\n${detail.textContent}`;
        // Keep the combobox as the only result-navigation focus target.
        option.addEventListener('pointerdown', event => event.preventDefault());
        option.onclick = () => confirmTerminalSwitch(id);
        return option;
    }));
    if (switcherActive) {
        switcherQuery.setAttribute('aria-activedescendant', `switcher-option-${switcherActive}`);
        results.children[switcherMatches.indexOf(switcherActive)]?.scrollIntoView?.({ block: 'nearest' });
    } else switcherQuery.removeAttribute('aria-activedescendant');
    const status = !workspace.cards.length ? 'There are no terminals on this canvas yet.'
        : !switcherMatches.length ? 'No matching terminals.'
        : `${switcherMatches.length} terminal${switcherMatches.length === 1 ? '' : 's'}${switcherQuery.value.trim() ? ' found' : ' on this canvas'}.`;
    // Folder polling must not repeatedly announce an unchanged result count.
    if ($('#switcher-status').textContent !== status) $('#switcher-status').textContent = status;
}
function confirmTerminalSwitch(id = switcherActive) {
    // Revalidate the stable ID at confirmation, including a result removed since the last render.
    if (!id || !findCard(id)) { renderTerminalSwitcher(); return; }
    switcherReturnFocus = null;
    terminalSwitcher.close();
    showTerminal(id);
}
terminalSwitcher.addEventListener('close', () => {
    switcherQuery.setAttribute('aria-expanded', 'false');
    switcherQuery.removeAttribute('aria-activedescendant');
    const target = switcherReturnFocus;
    switcherReturnFocus = null;
    if (target) {
        if (target.isConnected && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
        else viewport.focus({ preventScroll: true });
    }
});
terminalSwitcher.addEventListener('cancel', event => { event.preventDefault(); terminalSwitcher.close(); });
terminalSwitcher.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); terminalSwitcher.close(); return; }
    if (event.target.closest('button')) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) confirmTerminalSwitch(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const count = switcherMatches.length;
    if (!count) return;
    const index = switcherMatches.indexOf(switcherActive);
    switcherActive = switcherMatches[(index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count];
    renderTerminalSwitcher();
});
switcherQuery.oninput = renderTerminalSwitcher;
$('#find-terminal').onclick = openTerminalSwitcher;
$('#switcher-close').onclick = () => terminalSwitcher.close();
// From the selected element, or with nothing selected from the middle of the view, to the nearest
// terminal that way. When none lies that way the selection stays, and a selected terminal is shown again.
function navigateTerminals(direction) {
    if (boardBusy()) return;
    if (editing) document.activeElement?.blur();
    // In a split view, the keys move between its panes as they are laid out on screen.
    const panes = focused && split ? splitPanes().panes : null;
    const where = e => (panes && e.type === 'terminal' ? panes[split.cardIds.indexOf(e.id)] : boundsOf(e));
    const candidates = (panes ? split.cardIds.map(findCard) : workspace.cards).map(card => ({ id: card.id, bounds: where(card) }));
    if (!candidates.length) return toast('There are no terminals on this canvas yet.');
    const origin = findElement(focused || selected);
    const id = origin
        ? Geometry.nearestInDirection(where(origin), direction, candidates.filter(candidate => candidate.id !== origin.id), origin.id)
        : Geometry.nearestToPoint(viewportCenterWorld(), candidates);
    showTerminal(id || (origin?.type === 'terminal' ? origin.id : null));
}
// Enter: type in the selected terminal. One that is not running gets its Start or Resume button instead,
// so the keyboard never starts a command by itself.
function enterTerminal(id) {
    const s = sessions.get(id);
    if (!findCard(id) || !s) return false;
    if (s.status === 'running') select(id);
    else if (s.status !== 'starting') s.element.querySelector('[data-action="toggle"]').focus();
    return true;
}
// Ctrl+Shift+E: back to the board, keeping the terminal the keyboard was in selected.
function leaveToBoard(target) {
    if (editing) document.activeElement?.blur();
    if (!showTerminal(target?.closest?.('.terminal-card')?.dataset.id || focused || selected)) viewport.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', clearKeyboardCurrent, true);
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
// Focus shows one terminal across the canvas area, or a split view of several. `panes` starts a split
// view of those terminals, in that order, with `id` the one to type in; fewer than two ends it. Without
// `panes`, a split view stays while `id` is one of its terminals.
function setFocus(id, { type = true, panes = null } = {}) {
    if (!!focused !== !!id) focusSidebarRevealed = false;
    const before = split;
    if (panes) split = panes.length > 1 ? { cardIds: [...panes], orientation: 'row', sizes: panes.map(() => 1 / panes.length) } : null;
    else if (!id || !split?.cardIds.includes(id)) split = null;
    // A split view is saved with its canvas, so a single-canvas workspace starts keeping canvas metadata.
    if (split && split !== before) canvasExtended = true;
    focused = id;
    renderFocus();
    renderSidebar();
    renderCamera(); renderStyleToolbar();
    if (id) select(id, { type });
    else if (revealOnReturn) {
        const card = findCard(revealOnReturn);
        revealOnReturn = null;
        if (card) revealCard(card);
    }
    requestAnimationFrame(() => { for (const s of sessions.values()) fitTerminal(s); });
    if (split !== before) changed();
}
// Ctrl+Shift+F and the Focus button: Focus on the selected terminal, or a split view of two to four
// selected terminals in their canvas order, left to right; again to return to the canvas.
const SPLIT_LIMIT = 4;
function toggleFocus() {
    if (!ready) return;
    if (focused) return setFocus(null);
    const terminals = [...selection].map(findCard).filter(Boolean);
    if (terminals.length < 2) { if (findCard(selected)) setFocus(selected); return; }
    if (terminals.length > SPLIT_LIMIT) return toast('A split view shows up to four terminals. Select fewer, then try again.');
    terminals.sort((a, b) => a.x - b.x || a.y - b.y);
    setFocus(findCard(selected) ? selected : terminals[0].id, { panes: terminals.map(card => card.id) });
}
// Panes fill the same area as a single focused terminal, with room between them for the dividers.
const SPLIT_GAP = 10, SPLIT_MIN = 120;
let splitDividers = [];
const focusArea = () => ({ x: 18, y: 60, w: viewport.clientWidth - 36, h: viewport.clientHeight - 80 });
const splitPanes = () => Geometry.splitLayout(focusArea(), split, SPLIT_GAP);
const splitRoom = () => {
    const area = focusArea();
    return (split.orientation === 'row' ? area.w : area.h) - SPLIT_GAP * (split.cardIds.length - 1);
};
// Shows the focused terminal, or every pane of the split view, and places the dividers.
function renderFocus() {
    const layout = focused && split ? splitPanes() : null, panes = layout ? split.cardIds : [focused];
    viewport.classList.toggle('focus-mode', !!focused);
    viewport.classList.toggle('split-mode', !!layout);
    $('#exit-focus').hidden = !focused;
    $('#split-layout').hidden = !layout;
    for (const [id, s] of sessions) {
        const index = s.canvas === activeCanvas && focused ? panes.indexOf(id) : -1;
        s.element.classList.toggle('focused', index >= 0);
        if (!layout || index < 0) continue;
        const pane = layout.panes[index];
        for (const [key, value] of Object.entries({ x: pane.x, y: pane.y, w: pane.w, h: pane.h })) s.element.style.setProperty(`--pane-${key}`, `${value}px`);
    }
    // Dividers are replaced only when their number changes, so one being dragged stays in place.
    const wanted = layout ? layout.dividers.length : 0;
    if (splitDividers.length !== wanted) {
        splitDividers = Array.from({ length: wanted }, (_, index) => splitDividers[index] || splitDivider(index));
        $('#split-dividers').replaceChildren(...splitDividers);
    }
    if (!layout) return;
    const row = split.orientation === 'row', sum = list => list.reduce((total, size) => total + size, 0);
    layout.dividers.forEach((box, index) => {
        const divider = splitDividers[index];
        Object.assign(divider.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
        divider.className = `split-divider ${row ? 'vertical' : 'horizontal'}`;
        divider.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
        // The share of the room before this divider, whatever the shares add up to.
        divider.setAttribute('aria-valuenow', String(Math.round(sum(split.sizes.slice(0, index + 1)) / sum(split.sizes) * 100)));
        const [before, after] = [split.cardIds[index], split.cardIds[index + 1]].map(id => findCard(id)?.title || 'terminal');
        divider.setAttribute('aria-label', `Resize ${before} and ${after}`);
    });
    $('#split-row').setAttribute('aria-pressed', String(row));
    $('#split-column').setAttribute('aria-pressed', String(!row));
}
// A divider between pane `index` and the next. Drag it, or use the arrow keys (Shift for larger steps).
function splitDivider(index) {
    const divider = document.createElement('div');
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-valuemin', '0'); divider.setAttribute('aria-valuemax', '100');
    divider.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !split) return;
        const sizes = [...split.sizes], room = splitRoom(), row = split.orientation === 'row';
        beginDrag(divider, event, (dx, dy) => {
            split.sizes = Geometry.moveSplitDivider(sizes, index, row ? dx : dy, room, SPLIT_MIN);
            renderFocus();
        }, moved => { if (moved) changed(); });
    });
    divider.addEventListener('keydown', event => {
        const row = split?.orientation === 'row';
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (!split || !step || ['ArrowUp', 'ArrowDown'].includes(event.key) === row || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); event.stopPropagation();
        const room = splitRoom();
        split.sizes = Geometry.moveSplitDivider(split.sizes, index, step * room * (event.shiftKey ? .2 : .05), room, SPLIT_MIN);
        renderFocus(); changed();
    });
    return divider;
}
function setSplitOrientation(orientation) {
    if (!split || split.orientation === orientation) return;
    split.orientation = orientation;
    renderFocus(); changed();
}
$('#split-row').onclick = () => setSplitOrientation('row');
$('#split-column').onclick = () => setSplitOrientation('column');
// Clicking or tabbing into a pane makes it the one Alt + arrow keys move from and Ctrl+Shift+F leaves.
function activatePane(id) {
    if (!split || !focused || focused === id || !split.cardIds.includes(id)) return;
    focused = id;
    changed();
}
// The split view without terminal `id`, or null when fewer than two terminals would remain.
function splitWithout(state, id) {
    const index = state?.cardIds.indexOf(id) ?? -1;
    if (index < 0) return state;
    const cardIds = state.cardIds.filter(key => key !== id);
    return cardIds.length > 1 ? { ...state, cardIds, sizes: state.sizes.filter((_, at) => at !== index) } : null;
}
// A split view as loaded from a file or another client: two to four distinct terminals of `cards`, a
// known orientation, and a share from 1% to 100% for each; anything else is dropped.
function validSplit(state, cards) {
    const ids = new Set(cards.map(card => card.id));
    const cardIds = Array.isArray(state?.cardIds) ? state.cardIds : [];
    const valid = cardIds.length >= 2 && cardIds.length <= SPLIT_LIMIT && new Set(cardIds).size === cardIds.length && cardIds.every(id => ids.has(id))
        && ['row', 'column'].includes(state.orientation) && Array.isArray(state.sizes) && state.sizes.length === cardIds.length
        && state.sizes.every(size => typeof size === 'number' && size >= .01 && size <= 1);
    return valid ? { cardIds: [...cardIds], orientation: state.orientation, sizes: [...state.sizes] } : null;
}
function fitTerminal(s) {
    if (bridge?.remote) return;
    if (!s?.fit || s.canvas !== activeCanvas || !s.element.offsetWidth || !s.element.offsetHeight) return;
    const size = s.fit.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) s.terminal.resize(Math.max(2, Math.min(500, size.cols)), Math.max(1, Math.min(300, size.rows)));
}
const terminalFontSize = card => card.fontSize ?? TERMINAL_FONT.DEFAULT;
const themeIds = window.TerminalCanvasItemStyles.TERMINAL_THEMES;
const terminalTheme = card => window.TerminalCanvasThemes[card.theme || workspace.terminalTheme || 'current'];
function renderTerminalAppearance(card) {
    const s = sessions.get(card.id); if (!s) return;
    applyItemStyle(card, s.element);
    const theme = terminalTheme(card);
    s.element.style.setProperty('--terminal-background', theme.background);
    // Updating options preserves the xterm instance, buffer, selection, and PTY.
    if (s.terminal) s.terminal.options.theme = { ...theme };
}
function renderThemeControls() { $('#workspace-theme').value = workspace?.terminalTheme || 'current'; }
function setWorkspaceTerminalTheme(theme) {
    for (const canvas of canvasStates) {
        if (theme && theme !== 'current') canvas.board.terminalTheme = theme;
        else delete canvas.board.terminalTheme;
    }
}
function setTerminalTheme(theme, global = false) {
    if (!ready || boardBusy() || (theme !== '' && !themeIds.includes(theme))) return;
    const cards = global ? canvasStates.flatMap(canvas => canvas.board.cards) : selectedItems(['terminal']);
    if (!global && !cards.length) return;
    recordChange(() => {
        if (global) setWorkspaceTerminalTheme(theme);
        else for (const card of cards) {
            // An explicit Current overrides a non-Current workspace default.
            if (theme) card.theme = theme;
            else delete card.theme;
        }
        for (const card of cards) renderTerminalAppearance(card);
    });
    renderThemeControls(); renderStyleToolbar(); changed();
}
$('#workspace-theme').onchange = () => { setTerminalTheme($('#workspace-theme').value, true); renderThemeControls(); };
$('#terminal-theme').onchange = () => { setTerminalTheme($('#terminal-theme').value); renderStyleToolbar(); };
// xterm measures the new cell size immediately, so the refit gives a running program its new rows and columns.
function setTerminalFontSize(card, size) {
    const next = Math.max(TERMINAL_FONT.MIN, Math.min(TERMINAL_FONT.MAX, Math.round(size)));
    if (next === terminalFontSize(card)) return;
    if (next === TERMINAL_FONT.DEFAULT) delete card.fontSize;
    else card.fontSize = next;
    const s = sessions.get(card.id);
    if (s?.terminal) { s.terminal.options.fontSize = next; fitTerminal(s); }
    changed();
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
function mount(card, canvas = activeCanvas) {
    const profile = profiles.find(p => p.id === card.profile);
    const el = document.createElement('article'); el.className = 'terminal-card'; el.dataset.id = card.id;
    el.style.zIndex = String(++topCardZIndex);
    el.innerHTML = `<div class="card-header"><button type="button" class="card-title" title="Rename terminal"></button><span class="card-status"><i></i><span class="status-text">Ready</span></span><div class="card-actions"><button class="card-account-icon" data-action="account" title="Claude account: Default" aria-label="Claude account: Default">${icon('user')}</button><button class="icon-button" data-action="duplicate" title="Duplicate: new shell in current directory (Ctrl+Shift+D)" aria-label="Duplicate terminal (Ctrl+Shift+D)">${icon('copy')}</button><button class="icon-button" data-action="toggle" title="Start terminal" aria-label="Start terminal">${icon('play')}</button><button class="icon-button" data-action="fresh-shell" title="Start fresh shell" aria-label="Start fresh shell">${icon('terminal')}</button><button class="icon-button" data-action="focus" title="Focus terminal" aria-label="Focus terminal">${icon('maximize')}</button><button class="icon-button" data-action="close" title="Close terminal" aria-label="Close terminal">${icon('x')}</button></div></div><div class="card-directory">${icon('folder')}<span></span><button class="card-account" data-action="account"></button></div><div class="terminal-body"><div class="terminal-placeholder"><span class="placeholder-icon">${icon('terminal')}</span><p class="placeholder-copy"></p><button class="button" data-action="start">${icon('play')}Start terminal</button><button class="button" data-action="fresh">Start fresh shell</button></div></div><div class="card-resize" title="Drag to resize"></div>`;
    el.querySelector('.card-header').prepend(mark(profile));
    el.querySelector('.card-title').textContent = terminalDisplayTitle(card);
    el.querySelector('.card-title').setAttribute('aria-label', 'Rename terminal: ' + terminalDisplayTitle(card));
    el.querySelector('.card-title').onclick = () => openTitleDialog(card);
    el.querySelector('.card-title').disabled = !!bridge?.remote && !remoteController();
    const s = { element: el, canvas, card, status: 'idle', generation: 0, terminal: null, fit: null, metadataRevision: 0, placeholder: el.querySelector('.terminal-placeholder') };
    el.hidden = canvas !== activeCanvas;
    sessions.set(card.id, s); world.append(el); renderGeometry(card);
    recoveryInfo(card); renderAccount(card); renderTerminalAppearance(card);
    if (window.Terminal && window.FitAddon) {
        s.terminal = new window.Terminal({
            disableStdin: !!bridge?.remote && bridge.role !== 'control',
            fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace", fontSize: terminalFontSize(card), lineHeight: 1.3,
            cursorBlink: true, scrollback: 5000, allowProposedApi: false,
            linkHandler: {
                allowNonHttpProtocols: false,
                activate(event, uri) {
                    if (!event.isTrusted || event.button !== 0) return;
                    event.preventDefault();
                    if (bridge?.remote) {
                        if (URL.canParse(uri)) {
                            const url = new URL(uri);
                            if (['https:', 'http:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
                        }
                        return;
                    }
                    run(() => invoke('open-link', uri));
                }
            },
            theme: { ...terminalTheme(card) }
        });
        s.fit = new window.FitAddon.FitAddon(); s.terminal.loadAddon(s.fit); s.terminal.open(el.querySelector('.terminal-body'));
        s.terminal.onData(data => {
            if (bridge?.remote && (bridge.role !== 'control' || s.replaying || !s.userInput)) return;
            // A kept (tmux) terminal is not told when the whole app loses focus, so a program that
            // dims while unfocused (Claude Code does) stays active while you use another app.
            // Moving to another card or control in the app still reports focus out. The check waits a
            // task, as the browser may blur the terminal before the window itself.
            if (s.kept && data === '\x1b[O') {
                const generation = s.generation;
                setTimeout(() => { if (document.hasFocus() && s.generation === generation && s.status === 'running') bridge.input(card.id, data); });
                return;
            }
            // ConPTY can ask for its cursor before the start invoke resolves.
            // Answer an observed query while keeping early user typing blocked.
            const startupReply = s.status === 'starting' && s.startupCursorQueries > 0 && /^\x1b\[\d+;\d+R$/.test(data);
            if (startupReply) s.startupCursorQueries--;
            if (s.status === 'running' || startupReply) bridge.input(card.id, data);
        });
        if (bridge?.remote) {
            // Only user input reaches the shared PTY. Terminal query responses come from desktop.
            const userInput = event => {
                if (!event.isTrusted) return;
                s.userInput = true;
                // Native dispatch runs a microtask checkpoint between DOM listeners. Keep the
                // flag through xterm's target listener, then clear it in the next task.
                clearTimeout(s.userInputTimer);
                s.userInputTimer = setTimeout(() => { s.userInput = false; }, 0);
            };
            el.addEventListener('keydown', userInput, true);
            el.addEventListener('paste', userInput, true);
            el.addEventListener('input', userInput, true);
        }
        s.terminal.onResize(({ cols, rows }) => { if (['running', 'starting'].includes(s.status)) bridge.resize(card.id, cols, rows); });
        s.terminal.onBell?.(() => markCanvasActivity(s, 'Bell'));
        s.terminal.attachCustomKeyEventHandler(event => {
            const key = event.key.toLowerCase();
            if (canvasShortcut(event, { detect: true })) return false;
            if (event.altKey || event.isComposing) return true;
            if ((event.ctrlKey || event.metaKey) && ((!event.shiftKey && ['s', 'o'].includes(key)) || (event.shiftKey && ['n', 'f', 'd', 'e', 'p', 'b'].includes(key)))) return false;
            const modified = event.ctrlKey || event.metaKey;
            // Ctrl/Cmd+0 resets the text size; Ctrl+- and Ctrl+= still reach the shell (Ctrl+- is readline undo).
            // Digit0 covers layouts whose 0 needs Shift. Numpad0 is matched by its key only: without
            // NumLock it is Insert, and Ctrl+Insert must keep reaching the shell.
            if (modified && !event.shiftKey && (key === '0' || event.code === 'Digit0')) {
                event.preventDefault();
                event.stopPropagation();
                if (event.type === 'keydown') setTerminalFontSize(card, TERMINAL_FONT.DEFAULT);
                return false;
            }
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
                        if (sessions.get(card.id) === s && s.status === 'running' && s.generation === generation) {
                            s.userInput = true;
                            try { s.terminal.paste(text); } finally { s.userInput = false; }
                        }
                    });
                }
            }
            return false;
        });
        s.observer = new ResizeObserver(() => fitTerminal(s));
        s.observer.observe(el.querySelector('.terminal-body'));
        requestAnimationFrame(() => fitTerminal(s));
    }
    el.addEventListener('focusin', () => activatePane(card.id));
    el.addEventListener('pointerdown', event => {
        activatePane(card.id);
        if (event.shiftKey) select(card.id, { additive: true });
        else if (!selection.has(card.id)) select(card.id);
        else if (selected !== card.id) { selected = card.id; applySelection(true); }
    });
    el.querySelectorAll('[data-action]').forEach(button => button.onclick = () => run(async () => {
        if (canvasMutation || s.closing) return;
        const action = button.dataset.action;
        if (bridge?.remote && action !== 'focus' && !remoteController()) return;
        if (action === 'duplicate') await duplicateTerminal(card);
        if (action === 'account') await openAccountDialog(card);
        // In a split view, a pane's Focus button narrows the view to that terminal alone.
        if (action === 'focus') setFocus(split && focused ? card.id : focused ? null : card.id, { panes: split && focused ? [card.id] : null });
        if (action === 'start') await start(card);
        if (action === 'fresh' || action === 'fresh-shell') await start(card, 'fresh');
        if (action === 'toggle') {
            if (s.status === 'starting') return;
            if (s.status === 'running') await stopTerminal(card);
            else await start(card);
        }
        if (action === 'close') {
            if (['running', 'starting'].includes(s.status) && !await confirmAction('Close this terminal?', 'Its running shell and child processes will be stopped. Terminal output is not saved.', 'Close terminal')) return;
            await closeTerminal(card);
        }
    }));
    const header = el.querySelector('.card-header');
    header.addEventListener('pointerdown', event => { if (!event.target.closest('button')) startMove(event, card.id, header); });
    drag(el.querySelector('.card-resize'), () => !focused && !boardBusy(), (dx, dy, initial) => {
        card.w = Math.max(400, Math.min(2400, initial.w + dx / workspace.camera.z));
        card.h = Math.max(280, Math.min(1800, initial.h + dy / workspace.camera.z));
        renderGeometry(card);
    }, () => ({ w: card.w, h: card.h }));
}
// Closing a terminal is not undoable. Arrows attached to it are removed with it; other connectors,
// and those in undo steps that refer to it, are left with free ends.
function removeCard(card) {
    const canvas = sessions.get(card.id).canvas, board = canvas.board;
    const visible = canvas === activeCanvas;
    if (visible) {
        if (revealOnReturn === card.id) revealOnReturn = null;
        // A closed pane leaves the split view; the last one left stays in Focus on its own.
        if (split?.cardIds.includes(card.id)) {
            const rest = split.cardIds.filter(id => id !== card.id);
            split = splitWithout(split, card.id);
            setFocus(focused === card.id ? rest[0] : focused);
        } else if (focused === card.id) setFocus(null);
    } else {
        if (canvas.revealOnReturn === card.id) canvas.revealOnReturn = null;
        if (canvas.split?.cardIds.includes(card.id)) {
            const rest = canvas.split.cardIds.filter(id => id !== card.id);
            canvas.split = splitWithout(canvas.split, card.id);
            if (canvas.focused === card.id) canvas.focused = rest[0];
        } else if (canvas.focused === card.id) canvas.focused = null;
    }
    const arrows = attachedArrows([card.id], board);
    const removed = new Set([card.id, ...arrows]);
    detachConnectors([...removed], board);
    arrows.forEach(disposeItem);
    board.items = board.items.filter(item => !removed.has(item.id));
    dispose(card.id); board.cards = board.cards.filter(c => c.id !== card.id);
    pruneGroups(board);
    const picked = visible ? selection : canvas.selection;
    for (const id of removed) picked.delete(id);
    if (visible && removed.has(selected)) selected = [...picked].at(-1) ?? null;
    if (!visible && removed.has(canvas.selected)) canvas.selected = [...picked].at(-1) ?? null;
    renderLines(); applySelection(false); changed();
}
async function stopTerminal(card) {
    if (bridge.remote) return controlTerminal({ action: 'stop', id: card.id });
    await invoke('stop', { id: card.id });
    const s = sessions.get(card.id);
    if (s?.card !== card) return;
    s.terminal?.writeln('\r\n\x1b[90m[Terminal stopped]\x1b[0m');
    setStatus(card, 'exited');
}
async function closeTerminal(card) {
    const s = sessions.get(card.id);
    if (s?.card !== card || s.closing) return;
    s.closing = true;
    try {
        if (bridge.remote) return await controlTerminal({ action: 'close', id: card.id });
        await invoke('stop', { id: card.id, removePointers: true });
        if (sessions.get(card.id) === s) removeCard(card);
    } finally { s.closing = false; }
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
    if (ready) refresh();
}

/* Titles are plain text. The host owns names and revisions; all surfaces read card.title. */
let titleCard = null, titleBusy = false, launchTitleEdited = false, titleEpoch;
function validTerminalTitle(value) {
    const title = value.trim();
    return title.length > 0 && title.length <= 100 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(title);
}
function showTitle(card) {
    const button = sessions.get(card.id)?.element.querySelector('.card-title');
    if (button) {
        button.textContent = card.title;
        button.title = `${card.title} · Click to rename`;
        button.setAttribute('aria-label', `Rename terminal: ${card.title}`);
    }
    refresh();
}
function applyTitleEvent(event) {
    const card = anyCard(event.id);
    if (event.titleEpoch === titleEpoch && card && card.titleMode === 'automatic' && event.titleMode === 'automatic'
        && Number.isSafeInteger(event.titleRevision) && event.titleRevision > (card.titleRevision || 0)
        && typeof event.title === 'string' && validTerminalTitle(event.title)) {
        Object.assign(card, { title: event.title, titleMode: event.titleMode, titleRevision: event.titleRevision });
        showTitle(card); changed();
    }
}
function openTitleDialog(card) {
    if (!ready || (bridge?.remote && !remoteController()) || titleBusy || document.querySelector('dialog[open]')) return;
    titleCard = card;
    $('#rename-title').value = card.title;
    $('#title-mode').textContent = card.titleMode === 'automatic' ? 'Automatic title' : 'Manual title';
    $('#title-error').hidden = true;
    $('#title-dialog').showModal();
    $('#rename-title').focus(); $('#rename-title').select();
}
async function renameTerminal(card, mode, title) {
    if ((bridge?.remote && !remoteController()) || titleBusy || anyCard(card.id) !== card) return;
    if (mode === 'manual' && !validTerminalTitle(title)) throw new Error('Use a name of 1 to 100 characters without controls.');
    if (bridge?.remote) {
        await controlTerminal({ action: 'rename', id: card.id, mode, title: mode === 'manual' ? title.trim() : null });
        $('#title-dialog').close(); titleCard = null;
        return;
    }
    titleBusy = true;
    const s = sessions.get(card.id), previous = { title: card.title, titleMode: card.titleMode, titleRevision: card.titleRevision };
    // Immediate manual precedence, even while an older automatic event is in flight.
    if (s) s.namingPending = true;
    card.titleMode = mode;
    if (mode === 'manual') card.title = title.trim();
    showTitle(card);
    try {
        // New stopped cards might not have reached the host's debounced autosave yet.
        await invoke('autosave', workspace);
        if (anyCard(card.id) !== card || sessions.get(card.id) !== s) return;
        const result = await invoke('rename-title', { id: card.id, mode, ...(titleEpoch === undefined ? {} : { titleEpoch }), ...(mode === 'manual' ? { title: card.title } : {}) });
        if (anyCard(card.id) !== card || sessions.get(card.id) !== s) return;
        Object.assign(card, { title: result.card.title, titleMode: result.card.titleMode, titleRevision: result.card.titleRevision });
        showTitle(card); changed();
        $('#title-dialog').close(); titleCard = null;
    } catch (error) {
        if (anyCard(card.id) === card) { Object.assign(card, previous); showTitle(card); }
        throw error;
    } finally {
        if (s) {
            s.namingPending = false;
            const deferred = s.deferredTitle; delete s.deferredTitle;
            if (deferred && sessions.get(card.id) === s) applyTitleEvent(deferred);
        }
        titleBusy = false;
    }
}
$('#title-form').onsubmit = event => {
    event.preventDefault();
    const card = titleCard;
    if (card) run(async () => {
        try { await renameTerminal(card, 'manual', $('#rename-title').value); }
        catch (error) { $('#title-error').textContent = error.message; $('#title-error').hidden = false; }
    });
};
$('#automatic-title').onclick = () => {
    const card = titleCard;
    if (card) run(() => renameTerminal(card, 'automatic'));
};
$('#terminal-title').oninput = () => { launchTitleEdited = true; };
// `launch` names the program's request that opened this card, so the host can log its output.
async function start(card, mode = card.session ? 'resume' : 'start', launch, { type = true } = {}) {
    const s = sessions.get(card.id);
    if (!s || ['running', 'starting'].includes(s.status)) return;
    if (bridge.remote) {
        await controlTerminal({ action: 'start', id: card.id, fresh: mode === 'fresh' });
        if (s.canvas === activeCanvas && s.status === 'running') s.terminal?.focus();
        return;
    }
    if (!s.terminal) throw new Error('Live terminals require the desktop app and installed xterm dependencies. Run npm install, then npm start.');
    s.generation++;
    s.startupCursorQueries = 0; s.startupQueryTail = ''; s.kept = false;
    s.terminal.reset(); fitTerminal(s); showDirectory(s, null); setStatus(card, 'starting');
    try {
        clearTimeout(autosaveTimer);
        await invoke('autosave', workspace);
        const metadataRevision = s.metadataRevision;
        const result = await invoke('start', { card, cols: s.terminal.cols, rows: s.terminal.rows, mode, ...(launch ? { launch } : {}) });
        if (sessions.get(card.id) !== s) return;
        s.kept = !!result.kept;
        if (s.metadataRevision === metadataRevision) {
            if (result.cwd) card.cwd = result.cwd;
            if (result.session) card.session = result.session;
        }
        recoveryInfo(card); changed();
        if (s.status === 'starting') setStatus(card, 'running');
        if (type && s.canvas === activeCanvas) s.terminal.focus();
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
const onCanvasChrome = target => !!target.closest('.canvas-toolbar, .create-toolbar, .style-toolbar, .minimap, .exit-focus, .canvas-menu');
// Only the canvas background owns this menu; terminals, board items and controls keep their menus.
function emptyCanvasTarget(target) {
    if (target.closest('button,input,textarea,select,[contenteditable="true"],.terminal-card,.canvas-item,.canvas-line') || onCanvasChrome(target)) return false;
    return target === viewport || target === world || !!target.closest('.empty-state');
}
let canvasMenuPoint = null, canvasPointer = null, canvasMenuIndex = 0;
function canvasMenuButtons() {
    return [...$('#canvas-menu-profiles').children, $('#canvas-menu-find')];
}
function closeCanvasMenu({ restoreFocus = false } = {}) {
    const menu = $('#canvas-menu');
    if (menu.hidden) return;
    menu.hidden = true; canvasMenuPoint = null;
    if (restoreFocus) viewport.focus({ preventScroll: true });
}
function focusCanvasMenu(index) {
    const buttons = canvasMenuButtons();
    canvasMenuIndex = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => { button.tabIndex = i === canvasMenuIndex ? 0 : -1; });
    buttons[canvasMenuIndex].focus();
}
function openCanvasMenu(point) {
    if (!ready || canvasMutation || focused || boardBusy() || document.querySelector('dialog[open]')) return false;
    const area = viewport.getBoundingClientRect();
    const local = { x: Math.max(0, Math.min(area.width, point.x - area.left)), y: Math.max(0, Math.min(area.height, point.y - area.top)) };
    const worldPoint = toWorld({ clientX: area.left + local.x, clientY: area.top + local.y });
    // The hand tool disables world hit targets so they can pan; they still are not empty space.
    if (hand && Geometry.topmostAt(worldPoint, elementRecords().filter(record => !record.line))) return false;
    canvasMenuPoint = worldPoint;
    const menu = $('#canvas-menu'); menu.hidden = false;
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(local.x, area.width - size.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(local.y, area.height - size.height))}px`;
    focusCanvasMenu(0);
    return true;
}
function findTerminalFromCanvas() {
    closeCanvasMenu({ restoreFocus: true });
    openTerminalSwitcher();
}
$('#canvas-menu-find').onclick = findTerminalFromCanvas;
viewport.addEventListener('pointermove', event => {
    if (emptyCanvasTarget(event.target)) canvasPointer = { x: event.clientX, y: event.clientY };
});
function canvasKeyboardPoint() {
    const area = viewport.getBoundingClientRect();
    return canvasPointer || { x: area.left + area.width / 2, y: area.top + area.height / 2 };
}
viewport.addEventListener('contextmenu', event => {
    if (!emptyCanvasTarget(event.target)) return;
    const point = event.button === 0 ? canvasKeyboardPoint() : { x: event.clientX, y: event.clientY };
    if (openCanvasMenu(point)) { canvasPointer = point; event.preventDefault(); }
});
document.addEventListener('pointerdown', event => {
    if (!event.target?.closest?.('#canvas-menu')) closeCanvasMenu();
}, true);
// A small window can make the profile list scroll; scrolling that list keeps its menu usable.
function dismissCanvasMenuOnScroll(event) {
    if (!event.target?.closest?.('#canvas-menu')) closeCanvasMenu();
}
document.addEventListener('wheel', dismissCanvasMenuOnScroll, { capture: true, passive: true });
document.addEventListener('scroll', dismissCanvasMenuOnScroll, true);
window.addEventListener('blur', () => closeCanvasMenu());
window.addEventListener('resize', () => closeCanvasMenu());
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
function zoomFromWheel(event, delta = event.deltaY) {
    // Wheel events from a zoomed terminal carry coordinates rewritten for xterm; use the real pointer.
    const rect = viewport.getBoundingClientRect(), point = window.TerminalCanvasPointer?.clientPoint(event) ?? { x: event.clientX, y: event.clientY };
    zoom(Math.exp(-delta * .002), { x: point.x - rect.left, y: point.y - rect.top });
}
const WHEEL_GESTURE_GAP = 200, WHEEL_ZOOM_THRESHOLD = 4;
let plainWheelGesture = null;
function plainWheelDestination(target) {
    const control = target.closest('.terminal-card, .canvas-item, .canvas-line')
        || target.closest('.canvas-toolbar, .create-toolbar, .style-toolbar, .minimap, .exit-focus')
        || target.closest('button, input, textarea, select, [contenteditable="true"]');
    if (control) return control;
    // Only known background surfaces count as empty; other UI keeps its native scrolling.
    return target === viewport || target === world || target.closest('.empty-state') ? viewport : target;
}
window.addEventListener('blur', () => { plainWheelGesture = null; });
// Capture before xterm or the minimap can consume the event. Crossing destinations consumes the
// remainder of the gesture there, so canvas zoom cannot turn into terminal scrolling or vice versa.
viewport.addEventListener('wheel', event => {
    if (!ready || focused || event.ctrlKey || event.metaKey) { plainWheelGesture = null; return; }
    const destination = plainWheelDestination(event.target), now = event.timeStamp ?? Date.now();
    if (!plainWheelGesture || now - plainWheelGesture.time >= WHEEL_GESTURE_GAP || now < plainWheelGesture.time) {
        plainWheelGesture = { destination, time: now, delta: 0 };
    }
    plainWheelGesture.time = now;
    if (destination !== plainWheelGesture.destination) {
        event.preventDefault(); event.stopPropagation(); return;
    }
    if (destination !== viewport || !event.deltaY) return;
    event.preventDefault(); event.stopPropagation();
    const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? viewport.clientHeight : 1);
    // Ignore tiny direction reversals rather than letting trackpad noise shake the camera.
    if (Math.sign(delta) !== Math.sign(plainWheelGesture.delta)) plainWheelGesture.delta = 0;
    plainWheelGesture.delta += delta;
    if (Math.abs(plainWheelGesture.delta) < WHEEL_ZOOM_THRESHOLD) return;
    zoomFromWheel(event, plainWheelGesture.delta);
    plainWheelGesture.delta = 0;
}, { capture: true, passive: false });
// Ctrl/Cmd + wheel scales a terminal's text anywhere in Focus mode, and over the selected terminal on
// the canvas while its output is showing; everywhere else the listener below zooms the canvas. This
// runs while capturing, so xterm neither scrolls nor reports the wheel to the running program.
const WHEEL_NOTCH = 100;
viewport.addEventListener('wheel', event => {
    if (!ready || (!event.ctrlKey && !event.metaKey)) return;
    // In a split view, the pane under the pointer; in Focus, the focused terminal anywhere.
    const under = event.target?.closest?.('.terminal-card')?.dataset.id;
    const id = (split && focused && under) || focused || under;
    const card = findCard(id), s = sessions.get(id);
    if (!card || !s?.terminal || !s.placeholder.hidden || (!focused && id !== selected)) return;
    event.preventDefault(); event.stopPropagation();
    // A wheel notch is one pixel. Trackpads send small deltas, so the remainder carries over until the direction changes.
    const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1);
    const carried = Math.sign(s.fontWheel || 0) === -Math.sign(delta) ? 0 : s.fontWheel || 0;
    const steps = Math.trunc((carried + delta) / WHEEL_NOTCH);
    s.fontWheel = carried + delta - steps * WHEEL_NOTCH;
    if (steps) setTerminalFontSize(card, terminalFontSize(card) - steps);
}, { capture: true, passive: false });
viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (!ready) return;
    zoomFromWheel(event);
}, { passive: false });
async function duplicateTerminal(source, { fromBrowser = false } = {}) {
    if (!ready || duplicateBusy || (canvasMutation && !fromBrowser) || document.querySelector('dialog[open]')) return;
    duplicateBusy = true;
    try {
        if (bridge?.remote) {
            const { id, warning, cwd } = await controlTerminal({ action: 'duplicate', id: source.id });
            if (id) showTerminal(id) && sessions.get(id)?.terminal?.focus();
            else if (warning) {
                openLaunch();
                $('#cwd').value = cwd;
                $('#launch-error').textContent = warning;
                $('#launch-error').hidden = false;
            }
            return;
        }
        const canvas = canvasForCard(source.id);
        const current = () => (fromBrowser ? anyCard(source.id) : findCard(source.id)) === source;
        const result = await invoke('duplicate-directory', source);
        if (!current() || document.querySelector('dialog[open]')) return;
        if (result.warning) {
            if (fromBrowser) return result;
            openLaunch('shell', { fontSize: source.fontSize, claudeAccount: source.claudeAccount, color: source.color, theme: source.theme });
            $('#cwd').value = result.cwd;
            $('#launch-error').textContent = result.warning;
            $('#launch-error').hidden = false;
            return;
        }
        const { card } = await invoke('create-card', { profile: 'shell', titleMode: 'automatic', command: '', cwd: result.cwd, x: clampCoordinate(source.x + 40), y: clampCoordinate(source.y + 40) });
        if (!current() || document.querySelector('dialog[open]')) return;
        if (source.fontSize) card.fontSize = source.fontSize;
        if (source.color) card.color = source.color;
        if (source.theme) card.theme = source.theme;
        if (source.claudeAccount) card.claudeAccount = source.claudeAccount;
        canvas.board.cards.push(card); mount(card, canvas); changed(); refresh();
        if (!fromBrowser) {
            select(card.id);
            if (focused) setFocus(card.id);
        }
        await start(card, undefined, undefined, { type: !fromBrowser });
        return { id: card.id };
    } finally { duplicateBusy = false; }
}
// A program asked for a new terminal with `tc-hook new-terminal`: an agent of any kind, a harness, or
// a script. From inside a terminal (`event.id`), it opens beside that terminal, joined to it by an
// arrow. From outside the canvas (`event.external`), it opens beside the named `event.parent`, or in
// view when there is none. The host validated the request; requests open one at a time, in order.
// Every outcome is reported back as `launch-result`, so the program learns the new card's ID (and the
// parent it actually opened beside, if any) or why nothing opened.
let terminalRequests = Promise.resolve();
let markAppReady;
const appReady = new Promise(resolve => { markAppReady = resolve; });
function requestTerminal(event) {
    const report = outcome => { if (event.request) invoke('launch-result', { request: event.request, ...outcome }).catch(() => {}); };
    terminalRequests = terminalRequests.then(async () => {
        try {
            const { card, parent } = await openRequestedTerminal(event);
            report(parent ? { card: card.id, parent: parent.id } : { card: card.id });
        }
        catch (error) { report({ error: error.message }); toast(error.message); }
    });
}
// Returns the started card and the card it opened beside (null when none), or throws why it could not open.
async function openRequestedTerminal(event) {
    await appReady;
    const parentCanvas = canvasForCard(event.external ? event.parent : event.id);
    await whenBoardIdle();
    if (parentCanvas && parentCanvas !== activeCanvas && !switchCanvas(parentCanvas.id)) throw new Error('Finish the current canvas action, then request the terminal again.');
    if (canvasLocked()) throw new Error('Finish the current canvas action, then request the terminal again.');
    canvasMutation = true;
    try {
        let parent = findCard(event.external ? event.parent : event.id) || null;
        const closed = 'The terminal that asked for a new terminal has closed.';
        if (!event.external && !parent) throw new Error(closed);
        const requester = () => parent?.title || 'A program';
        await whenBoardIdle();
        const size = { w: 660, h: 430 };
        const taken = [...workspace.cards, ...workspace.items.filter(item => item.type !== 'line')].map(boundsOf);
        const spot = parent ? Geometry.placeBeside(parent, size, taken) : Geometry.placeNear(viewportCenterWorld(), size, taken);
        const { card } = await invoke('create-card', { profile: event.profile, title: event.title, ...(event.titleMode ? { titleMode: event.titleMode } : {}), cwd: event.cwd, command: event.command, x: clampCoordinate(spot.x), y: clampCoordinate(spot.y) });
        if (parent && !workspace.cards.includes(parent)) {
            if (!event.external) throw new Error(closed);
            parent = null;
        }
        await whenBoardIdle();
        // A terminal opened beside another signs in to Claude as that terminal does.
        if (event.pointer) { if (event.claudeAccount) card.claudeAccount = event.claudeAccount; }
        else if (parent?.claudeAccount) card.claudeAccount = parent.claudeAccount;
        workspace.cards.push(card); mount(card);
        if (parent && workspaceItemCount() < ITEM_LIMIT) {
            recordHistory();
            const arrow = { id: newId(), type: 'line', start: { id: parent.id }, end: { id: card.id }, arrow: true };
            workspace.items.push(arrow); mountLine(arrow);
        }
        renderLines(); select(card.id); changed(); refresh();
        if (focused) setFocus(card.id);
        else if (!Geometry.intersects(visibleWorld(), card)) centerCard(card);
        toast(`${requester()} opened a new terminal: ${card.title}.`);
        await start(card, undefined, event.request);
        return { card, parent };
    } finally { canvasMutation = false; }
}
// Folder review preserves a duplicate's text size, appearance, and account.
let launchFontSize, launchAccount, launchColor, launchTheme, launchPoint;
function openLaunch(profileId = 'shell', { fontSize, claudeAccount, color, theme, point } = {}) {
    if (!ready || (bridge?.remote && !remoteController()) || canvasMutation || document.querySelector('dialog[open]')) return;
    closeCanvasMenu();
    launchFontSize = fontSize; launchAccount = claudeAccount; launchColor = color; launchTheme = theme; launchPoint = point;
    launchTitleEdited = false;
    const profile = profiles.find(p => p.id === profileId);
    $('#profile').value = profile.id; $('#terminal-title').value = profile.name; $('#command').value = profile.command;
    $('#launch-error').hidden = true; $('#launch-dialog').showModal();
}
/* ---------- Claude accounts ---------- */
// Each account is a separate Claude Code configuration folder the host sets as CLAUDE_CONFIG_DIR
// when the card's shell starts. A card without `claudeAccount` uses the shell's usual sign-in.
// `claudeSignedIn` maps an account to the email it signed in with, for display only.
let claudeAccounts = [], claudeSignedIn = {}, accountCard = null, accountBusy = false;
async function loadClaudeAccounts(create) {
    const result = await invoke('claude-accounts', create === undefined ? {} : { create });
    claudeAccounts = Array.isArray(result?.accounts) ? result.accounts.filter(name => typeof name === 'string') : [];
    claudeSignedIn = result?.signedIn && typeof result.signedIn === 'object' ? result.signedIn : {};
    return result || {};
}
function renderAccountStatus() {
    const name = $('#account-select').value, email = name && typeof claudeSignedIn[name] === 'string' ? claudeSignedIn[name] : '';
    $('#account-status').textContent = !name ? 'Uses the sign-in your shell already has.'
        : email ? `Signed in as ${email}.` : 'Not signed in yet. Sign in once with your browser; the sign-in is kept for this account.';
    $('#account-signin').innerHTML = icon('user') + (email ? 'Sign in again' : 'Sign in with browser');
    $('#account-signin').disabled = !name || accountBusy;
}
function accountOption(label, value) {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    return option;
}
function fillAccountSelect(select, value) {
    select.replaceChildren(accountOption('Default (your usual Claude sign-in)', ''));
    const names = [...claudeAccounts];
    if (value && !names.includes(value)) names.push(value);
    for (const name of names) select.append(accountOption(name, name));
    select.value = value || '';
}
// The header icon opens the account dialog; the folder row names the account.
function renderAccount(card) {
    const s = sessions.get(card.id); if (!s) return;
    const button = s.element.querySelector('.card-account');
    button.textContent = `Claude · ${card.claudeAccount || 'Default'}`;
    button.classList.toggle('set', !!card.claudeAccount);
    button.title = `Claude account: ${card.claudeAccount || 'Default'}. Click to change.`;
    button.setAttribute('aria-label', `Claude account: ${card.claudeAccount || 'Default'}`);
    const header = s.element.querySelector('.card-account-icon');
    header.title = `Claude account: ${card.claudeAccount || 'Default'}`;
    header.setAttribute('aria-label', header.title);
    header.classList.toggle('set', !!card.claudeAccount);
}
async function openAccountDialog(card) {
    if (!ready || document.querySelector('dialog[open]')) return;
    try { await loadClaudeAccounts(); } catch (error) { toast(error.message); }
    if (findCard(card.id) !== card || document.querySelector('dialog[open]')) return;
    accountCard = card;
    $('#account-description').textContent = `Choose the Claude Code sign-in “${card.title}” uses.`;
    fillAccountSelect($('#account-select'), card.claudeAccount); renderAccountStatus();
    $('#account-name').value = ''; $('#account-error').hidden = true;
    $('#account-dialog').showModal();
}
function addAccount() {
    const name = $('#account-name').value.trim();
    if (!name || accountBusy) return;
    accountBusy = true; $('#account-add').disabled = true; renderAccountStatus();
    run(async () => {
        try {
            const result = await loadClaudeAccounts(name);
            fillAccountSelect($('#account-select'), result.created || name);
            $('#account-name').value = ''; $('#account-error').hidden = true;
        } catch (error) {
            $('#account-error').textContent = error.message; $('#account-error').hidden = false;
        } finally { accountBusy = false; $('#account-add').disabled = false; renderAccountStatus(); }
    });
}
$('#account-add').onclick = addAccount;
$('#account-name').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addAccount(); } });
$('#account-select').onchange = renderAccountStatus;
// Saves the dialog's choice on its card. Returns the card, or null when it was closed meanwhile.
function applyAccountChoice() {
    const card = accountCard, value = $('#account-select').value;
    accountCard = null; $('#account-dialog').close();
    if (!card || findCard(card.id) !== card) return null;
    if ((card.claudeAccount || '') === value) return card;
    if (value) card.claudeAccount = value; else delete card.claudeAccount;
    renderAccount(card); changed();
    const s = sessions.get(card.id);
    if (['running', 'starting'].includes(s?.status)) toast(`“${card.title}” will use ${value ? `the Claude account “${value}”` : 'the default Claude sign-in'} the next time it starts.`);
    return card;
}
$('#account-form').onsubmit = event => { event.preventDefault(); applyAccountChoice(); };
// Browser sign-in, as Claude Code's own `claude auth login` does it, in a terminal beside the card
// that runs as the account: the sign-in lands in that account's folder and stays there.
$('#account-signin').onclick = () => {
    const name = $('#account-select').value;
    if (!name || accountBusy) return;
    const card = applyAccountChoice();
    run(() => openAccountSignIn(card, name));
};
function openAccountSignIn(beside, name) {
    return openCommandTerminal({
        beside, title: `Sign in · ${name}`, command: 'claude auth login', claudeAccount: name, again: 'sign in again',
        notice: `Finish signing in to “${name}” in your browser. Close the sign-in terminal when it is done.`,
    });
}
// Starts a shell terminal that runs `command`, beside `beside` while it is still on the board and
// otherwise near the middle of the view, then shows `notice`.
async function openCommandTerminal({ beside = null, title, command, claudeAccount = '', again, notice }) {
    await whenBoardIdle();
    if (canvasLocked()) throw new Error(`Finish the current canvas action, then ${again}.`);
    canvasMutation = true;
    try {
        const size = { w: 660, h: 430 };
        const taken = [...workspace.cards, ...workspace.items.filter(item => item.type !== 'line')].map(boundsOf);
        const spot = beside && findCard(beside.id) === beside ? Geometry.placeBeside(beside, size, taken) : Geometry.placeNear(viewportCenterWorld(), size, taken);
        const options = { profile: 'shell', title, command, x: clampCoordinate(spot.x), y: clampCoordinate(spot.y) };
        if (bridge.remote) {
            const { id, warning } = await controlTerminal({ action: 'launch', canvasId: canvasExtended ? activeCanvas.id : null, options, claudeAccount: claudeAccount || null });
            showTerminal(id);
            toast(warning || notice);
            return;
        }
        const { card } = await invoke('create-card', options);
        if (claudeAccount) card.claudeAccount = claudeAccount;
        workspace.cards.push(card); mount(card); select(card.id); changed(); refresh();
        if (focused) setFocus(card.id);
        else if (!Geometry.intersects(visibleWorld(), card)) centerCard(card);
        toast(notice);
        await start(card);
    } finally { canvasMutation = false; }
}
$('#account-dialog').addEventListener('close', () => { accountCard = null; });
// The agent setup installs the Terminal Canvas skill where AI agents load skills for every session.
// The first launch offers it once; Set up agents in the sidebar offers it again at any time.
const AGENT_STATUS = { current: 'INSTALLED', outdated: 'UPDATE', missing: 'NOT INSTALLED' };
let agentChoices = new Map(), agentBusy = false, agentOffer = false;
function renderAgentTargets(targets) {
    agentChoices = new Map();
    const anyDetected = targets.some(target => target.detected.length);
    const rows = targets.map(target => {
        const row = document.createElement('label'); row.className = 'agent-target';
        const box = document.createElement('input'); box.type = 'checkbox'; box.value = target.id;
        // Preselect what this computer uses and does not have yet; with no agent found, everything.
        box.checked = target.status !== 'current' && (!anyDetected || target.detected.length > 0);
        agentChoices.set(target.id, { box, target });
        const copy = document.createElement('span'); copy.className = 'agent-target-copy';
        const name = document.createElement('span'); name.className = 'agent-target-name';
        const title = document.createElement('span'); title.textContent = target.name;
        const status = document.createElement('span'); status.className = `agent-target-status ${target.status}`; status.textContent = AGENT_STATUS[target.status] || '';
        name.append(title, status);
        const found = document.createElement('span'); found.className = 'agent-target-detail';
        found.textContent = target.detected.length ? `Found on this computer: ${target.detected.join(', ')}.` : 'Not found on this computer yet.';
        const folders = document.createElement('span'); folders.className = 'agent-target-detail';
        target.folders.forEach((folder, index) => {
            const code = document.createElement('code'); code.textContent = folder;
            if (index) folders.append(document.createElement('br'));
            folders.append(code);
        });
        copy.append(name, found, folders); row.append(box, copy);
        return row;
    });
    $('#agent-targets').replaceChildren(...rows);
}
async function openAgentSetup({ offer = false } = {}) {
    if (!ready || agentBusy || document.querySelector('dialog[open]')) return;
    const { targets } = await invoke('agent-setup', {});
    if (document.querySelector('dialog[open]')) return;
    agentOffer = offer;
    renderAgentTargets(targets);
    $('#agent-error').hidden = true; $('#agent-install').disabled = false;
    $('#agent-dialog').showModal();
}
// The footer's gear opens the Settings menu; Escape, a click elsewhere, or choosing an item closes it.
function setSettingsMenu(open) {
    $('#settings-menu').hidden = !open;
    $('#settings').setAttribute('aria-expanded', String(open));
    if (open) $('#agent-setup').focus();
}
$('#settings').onclick = () => setSettingsMenu($('#settings-menu').hidden);
$('#settings-menu').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    setSettingsMenu(false); $('#settings').focus();
});
document.addEventListener('pointerdown', event => {
    if (!$('#settings-menu').hidden && !event.target.closest?.('#settings-menu,#settings')) setSettingsMenu(false);
}, true);
$('#agent-setup').onclick = () => { setSettingsMenu(false); run(() => openAgentSetup()); };
// Kept terminals outlive the app (in the host's helper on Windows, in tmux elsewhere). The host
// reports the setting and the cards whose terminals still run; those cards attach again as soon as
// their workspace loads.
let keepEnabled = false;
function showKeep(status) {
    keepEnabled = !!status?.enabled;
    $('#keep-setting').setAttribute('aria-checked', String(keepEnabled));
    $('#keep-state').textContent = keepEnabled ? 'On' : 'Off';
    $('#keep-toggle').setAttribute('aria-pressed', String(keepEnabled));
    $('#keep-toggle-state').textContent = keepEnabled ? 'On' : 'Off';
}
function attachKept(status) {
    showKeep(status);
    if (!keepEnabled || bridge?.remote) return;
    for (const id of status.sessions || []) {
        const s = sessions.get(id);
        if (s?.card && !['running', 'starting'].includes(s.status)) run(() => start(s.card));
    }
}
// The Settings menu item and the footer button both switch it.
async function toggleKeep() {
    const button = $('#keep-toggle');
    if (button.disabled) return;
    button.disabled = true;
    try { showKeep(await invoke('keep-running', { enabled: !keepEnabled })); }
    finally { button.disabled = false; }
    toast(keepEnabled
        ? 'Terminals you start now keep running after you quit, and attach again when you reopen. Stop ends a terminal.'
        : 'Terminals you start now stop when you quit. Terminals already kept running continue until you stop them.');
}
$('#keep-setting').onclick = () => { setSettingsMenu(false); run(toggleKeep); };
$('#keep-toggle').onclick = () => run(toggleKeep);
$('#agent-form').onsubmit = event => {
    event.preventDefault(); if (agentBusy) return;
    const chosen = [...agentChoices.values()].filter(choice => choice.box.checked);
    if (!chosen.length) { $('#agent-dialog').close(); return; }
    agentBusy = true; $('#agent-install').disabled = true;
    run(async () => {
        try {
            await invoke('agent-setup', { install: chosen.map(choice => choice.target.id) });
            agentOffer = false; $('#agent-dialog').close();
            toast(`Terminal Canvas skill installed for ${chosen.map(choice => choice.target.name).join(' and ')}. Agent sessions started from now on can open linked terminals and hand work over.`);
        } catch (error) {
            $('#agent-error').textContent = error.message; $('#agent-error').hidden = false;
        } finally { agentBusy = false; $('#agent-install').disabled = false; }
    });
};
// Closing the first-launch offer without installing declines it, so it is not offered again.
$('#agent-dialog').addEventListener('close', () => {
    if (!agentOffer) return;
    agentOffer = false;
    run(() => invoke('agent-setup', { dismiss: true }));
});
// The tmux setup checks for tmux and installs it with this computer's package manager, in a
// terminal on the canvas where the user follows it and answers its prompts. The first launch
// offers it once, after the agent setup; Settings offers it again at any time.
let tmuxBusy = false, tmuxOffer = false, tmuxPending = false;
function renderTmuxStatus(status) {
    $('#tmux-minimum').textContent = status.minimum;
    const found = status.version ? `tmux ${status.version}` : 'A tmux of unknown version';
    $('#tmux-status').textContent = status.installed ? `tmux ${status.version} is installed: ${status.path}`
        : (status.path ? `${found} is at ${status.path}, but ${status.minimum} or newer is needed.` : 'tmux is not installed.')
            + (status.command ? '' : ` No supported package manager was found. Install tmux ${status.minimum} or newer yourself, then check again here.`);
    $('#tmux-status').classList.toggle('ready', !!status.installed);
    const offer = !status.installed && !!status.command;
    $('#tmux-plan').hidden = !offer; $('#tmux-install').hidden = !offer;
    $('#tmux-command').textContent = status.command || '';
    $('#tmux-manager').textContent = status.manager || '';
    $('#tmux-install').lastChild.textContent = status.path ? 'Update tmux' : 'Install tmux';
    $('#tmux-cancel').textContent = offer ? 'Not now' : 'Close';
}
async function openTmuxSetup({ offer = false } = {}) {
    if (!ready || tmuxBusy || document.querySelector('dialog[open]')) return;
    const status = await invoke('tmux-setup', {});
    if (document.querySelector('dialog[open]')) return;
    tmuxOffer = offer;
    renderTmuxStatus(status);
    $('#tmux-error').hidden = true; $('#tmux-install').disabled = false;
    $('#tmux-dialog').showModal();
}
// The first launch's offer waits for the agent setup's dialog to close.
function offerTmuxSetup() {
    if (!tmuxPending || document.querySelector('dialog[open]')) return;
    tmuxPending = false;
    run(() => openTmuxSetup({ offer: true }));
}
$('#agent-dialog').addEventListener('close', offerTmuxSetup);
$('#tmux-setup').onclick = () => { setSettingsMenu(false); run(() => openTmuxSetup()); };
$('#tmux-form').onsubmit = event => {
    event.preventDefault(); if (tmuxBusy) return;
    tmuxBusy = true; $('#tmux-install').disabled = true;
    run(async () => {
        let command;
        try {
            ({ command } = await invoke('tmux-setup', { install: true }));
            tmuxOffer = false; $('#tmux-dialog').close();
        } catch (error) {
            $('#tmux-error').textContent = error.message; $('#tmux-error').hidden = false;
            return;
        } finally { tmuxBusy = false; $('#tmux-install').disabled = false; }
        await openCommandTerminal({
            title: 'Install tmux', command, again: 'install tmux again from Settings',
            notice: 'tmux is installing in the new terminal. Answer any prompts there; Settings › Install tmux shows when it is ready.',
        });
    });
};
// Closing the first-launch offer without installing declines it, so it is not offered again.
$('#tmux-dialog').addEventListener('close', () => {
    if (!tmuxOffer) return;
    tmuxOffer = false;
    run(() => invoke('tmux-setup', { dismiss: true }));
});
$('#profile').onchange = () => { const p = profiles.find(p => p.id === $('#profile').value); if (!launchTitleEdited) $('#terminal-title').value = p.name; $('#command').value = p.command; };
$('#browse-folder').onclick = () => run(async () => { const result = await invoke('pick-folder', { cwd: $('#cwd').value.trim() }); if (result.path) $('#cwd').value = result.path; });
$('#launch-form').onsubmit = event => {
    event.preventDefault(); if (formBusy) return;
    formBusy = true; $('#launch-submit').disabled = true;
    run(async () => {
        try {
            const { x, y, z } = workspace.camera;
            const count = workspace.cards.length;
            const point = launchPoint || { x: Math.round((60 - x) / z + (count % 4) * 35), y: Math.round((40 - y) / z + (count % 4) * 35) };
            const title = $('#terminal-title').value.trim();
            const options = { profile: $('#profile').value, title, titleMode: launchTitleEdited && title ? 'manual' : 'automatic', cwd: $('#cwd').value.trim(), command: $('#command').value.trim(), ...point };
            if (bridge.remote) {
                const { id, warning } = await controlTerminal({ action: 'launch', canvasId: canvasExtended ? activeCanvas.id : null, options: {
                    ...options, x: clampCoordinate(point.x), y: clampCoordinate(point.y)
                } });
                $('#launch-dialog').close();
                if (showTerminal(id) && sessions.get(id).status === 'running') sessions.get(id).terminal?.focus();
                if (warning) toast(warning);
                return;
            }
            const result = await invoke('create-card', options);
            if (launchFontSize) result.card.fontSize = launchFontSize;
            if (launchColor) result.card.color = launchColor;
            if (launchTheme) result.card.theme = launchTheme;
            if (launchAccount) result.card.claudeAccount = launchAccount;
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

async function runRemoteTerminalRequest(event) {
    // Claim once in the host so a queued action cannot run after revocation or a workspace change.
    const id = event.requestId;
    try { await invoke('remote-terminal-reply', { id }); }
    catch { return; }
    let result;
    try {
        if (event.titleEpoch !== titleEpoch) throw new Error('The workspace changed. Try again from the current canvas.');
        if (canvasLocked()) throw new Error('Finish the current action on the desktop, then try again.');
        canvasMutation = true;
        try {
            const command = event.command;
            if (command.action === 'layout') {
                result = await applyBrowserLayout(command, event.titleEpoch);
            } else if (command.action === 'workspace-action') {
                result = await runBrowserWorkspaceAction(command);
            } else if (command.action === 'new-workspace' || command.action === 'open-workspace') {
                result = command.action === 'new-workspace' ? await invoke('new')
                    : await invoke('remote-workspace-open', { epoch: event.titleEpoch, workspace: command.workspace });
                loadWorkspace(result.workspace, result.titleEpoch); changed(); attachKept(result.keepRunning);
            } else if (command.action === 'launch') {
                const canvas = canvasExtended ? canvasStates.find(canvas => canvas.id === command.canvasId)
                    : command.canvasId === null ? activeCanvas : null;
                if (!canvas) throw new Error('This canvas changed. Choose a canvas and try again.');
                const { card } = await invoke('create-card', command.options);
                if (event.titleEpoch !== titleEpoch || !canvasStates.includes(canvas)) throw new Error('The workspace changed. Try again from the current canvas.');
                if (command.claudeAccount) card.claudeAccount = command.claudeAccount;
                canvas.board.cards.push(card); mount(card, canvas); refresh(); changed();
                result = { id: card.id };
                try { await start(card, undefined, undefined, { type: false }); }
                catch (error) { result.warning = error.message; }
            } else {
                const card = anyCard(command.id);
                if (!card) throw new Error('This terminal is no longer on the canvas.');
                if (command.action === 'start') await start(card, command.fresh ? 'fresh' : undefined, undefined, { type: false });
                if (command.action === 'stop') await stopTerminal(card);
                if (command.action === 'rename') await renameTerminal(card, command.mode, command.title);
                if (command.action === 'close') {
                    await closeTerminal(card);
                    clearTimeout(autosaveTimer);
                    await invoke('autosave', workspace);
                }
                result = command.action === 'duplicate' ? await duplicateTerminal(card, { fromBrowser: true }) : { ok: true };
            }
        } finally { canvasMutation = false; }
    } catch (error) { result = { error: error.message }; }
    await invoke('remote-terminal-reply', { id, result });
}

async function runBrowserWorkspaceAction({ name, payload = {} }) {
    payload ||= {};
    if (name === 'unused-images' || name === 'delete-unused-images') {
        if (imageImports) throw new Error('Wait for images to finish importing on the desktop, then try again.');
        payload.keep = [...new Set([...referencedImages(), ...(Array.isArray(payload.keep) ? payload.keep : [])])];
    }
    if (name !== 'pointer-configure') return invoke(name, payload);
    const result = await invoke(name, { ...payload, workspace: workspaceSnapshot() });
    if (typeof payload.paused === 'boolean') setHooksPaused(payload.paused);
    else {
        const item = anyPointerItem(payload.id);
        if (item && payload.hook) item.hook = payload.hook;
        else if (item) delete item.hook;
        pointerStates.delete(payload.id);
    }
    renderLines(); renderPointerControls(); changed();
    return result;
}

function loadWorkspace(board, epoch) {
    titleEpoch = epoch;
    $('#title-dialog').close(); titleCard = null;
    pointerStates.clear();
    clearTimeout(autosaveTimer);
    if (editing) document.activeElement?.blur();
    workspace = board;
    workspace.items = Array.isArray(board.items) ? board.items : [];
    // The browser preview stores unvalidated layouts, which may still use format 2's single group.
    for (const e of [...workspace.cards, ...workspace.items]) {
        if (e.group && !e.groups) e.groups = [e.group];
        delete e.group;
    }
    for (const id of sessions.keys()) dispose(id);
    for (const id of [...itemViews.keys()]) disposeItem(id);
    topCardZIndex = 0;
    selected = null; focused = null; selection = new Set(); $('#workspace-name').value = board.name;
    canvasExtended = Array.isArray(board.canvases) && board.canvases.length > 0;
    const cards = new Map(board.cards.map(card => [card.id, card])), items = new Map(board.items.map(item => [item.id, item]));
    canvasStates = canvasExtended ? board.canvases.map(canvas => canvasState({ ...canvas,
        cards: canvas.cardIds.map(id => cards.get(id)), items: canvas.itemIds.map(id => items.get(id)) }))
        : [canvasState({ camera: board.camera, cards: board.cards, items: board.items })];
    setWorkspaceTerminalTheme(board.terminalTheme);
    setHooksPaused(!!board.hooksPaused);
    for (const canvas of canvasStates) {
        activeCanvas = canvas; workspace = canvas.board; workspace.name = board.name;
        for (const card of workspace.cards) mount(card);
        workspace.items.forEach(mountItem);
    }
    revealCanvas(canvasStates.find(canvas => canvas.id === board.activeCanvas) || canvasStates[0], { restoreKeyboard: false });
}

// Keep terminal metadata and each client's navigation out of layout conflict checks.
function layoutKey(board) {
    const layout = {
        name: board.name, terminalTheme: board.terminalTheme || 'current',
        cards: board.cards.map(({ id, x, y, w, h, groups, color, fontSize, theme, claudeAccount }) => ({ id, x, y, w, h, groups, color, fontSize, theme, claudeAccount })),
        items: board.items.map(({ hook, ...item }) => item),
        canvases: board.canvases?.map(({ id, name, cardIds, itemIds }) => ({ id, name, cardIds, itemIds }))
    };
    return JSON.stringify(layout, (_, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
async function layoutDigest(key) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
let remoteLayoutBase, remoteLayoutSave, pendingRemoteWorkspace;
async function applyBrowserLayout(command, epoch) {
    const current = workspaceSnapshot();
    const key = layoutKey(current);
    if (command.base !== await layoutDigest(key) || layoutKey(workspaceSnapshot()) !== key || editing || activeDrags) {
        return { workspace: workspaceSnapshot(), titleEpoch: epoch, warning: 'The desktop changed the workspace first. Review its changes and try your edit again.' };
    }
    const board = command.workspace;
    board.camera = current.camera;
    if (Array.isArray(board.canvases) && board.canvases.length) {
        for (const [index, canvas] of board.canvases.entries()) {
            const previous = current.canvases?.find(definition => definition.id === canvas.id);
            canvas.camera = previous?.camera || (!current.canvases && index === 0 ? current.camera : { x: 48, y: 48, z: 1 });
            canvas.selected = canvas.cardIds?.includes(previous?.selected) || canvas.itemIds?.includes(previous?.selected) ? previous.selected : undefined;
            canvas.focused = canvas.cardIds?.includes(previous?.focused) ? previous.focused : undefined;
            canvas.split = previous?.split && previous.split.cardIds.every(id => canvas.cardIds?.includes(id)) ? previous.split : undefined;
        }
        board.activeCanvas = board.canvases.some(canvas => canvas.id === current.activeCanvas) ? current.activeCanvas : board.canvases[0].id;
    }
    const result = await invoke('remote-layout-save', { workspace: board, epoch });
    if (epoch === titleEpoch) {
        clearTimeout(autosaveTimer);
        remoteWorkspace(result.workspace, result.titleEpoch);
        $('#save-state').lastChild.textContent = result.warning ? 'Save failed' : 'Saved locally';
    }
    return result;
}
function receiveRemoteWorkspace(board, epoch) {
    if (epoch === titleEpoch && remoteController() && (remoteLayoutSave || activeDrags || editing || layoutKey(workspaceSnapshot()) !== remoteLayoutBase)) {
        pendingRemoteWorkspace = { board, epoch };
        return;
    }
    pendingRemoteWorkspace = null;
    remoteLayoutBase = layoutKey(board);
    remoteWorkspace(board, epoch);
}
async function saveRemoteLayout() {
    if (!remoteController() || activeDrags || editing) return;
    if (remoteLayoutSave) return remoteLayoutSave;
    const workspace = workspaceSnapshot(), epoch = titleEpoch;
    if (layoutKey(workspace) === remoteLayoutBase) {
        if (pendingRemoteWorkspace) receiveRemoteWorkspace(pendingRemoteWorkspace.board, pendingRemoteWorkspace.epoch);
        return;
    }
    const base = remoteLayoutBase;
    remoteLayoutSave = (async () => {
        $('#save-state').lastChild.textContent = 'Saving…';
        try {
            const command = { action: 'layout', base: await layoutDigest(base), workspace };
            const result = await invoke('remote-terminal', { epoch, command });
            if (titleEpoch === epoch) {
                pendingRemoteWorkspace = null;
                remoteLayoutBase = layoutKey(result.workspace);
                remoteWorkspace(result.workspace, result.titleEpoch);
                $('#save-state').lastChild.textContent = 'Saved on desktop';
            }
            if (result.warning) toast(result.warning);
        } catch (error) {
            $('#save-state').lastChild.textContent = 'Changes unsaved';
            throw error;
        }
    })();
    try { await remoteLayoutSave; }
    finally { remoteLayoutSave = null; }
}

// Update layout without recreating terminal emulators or sharing focus and selection.
function remoteWorkspace(board, epoch) {
    titleEpoch = epoch;
    rememberCanvas();
    const previousCanvas = activeCanvas;
    const present = new Set(board.cards.map(card => card.id));
    for (const id of sessions.keys()) if (!present.has(id)) dispose(id);
    const cards = new Map(board.cards.map(card => {
        const previous = sessions.get(card.id)?.card;
        if (!previous) return [card.id, card];
        for (const key of Object.keys(previous)) delete previous[key];
        Object.assign(previous, card);
        return [card.id, previous];
    }));
    const previousItems = new Map(canvasStates.flatMap(canvas => canvas.board.items).map(item => [item.id, item]));
    const items = new Map(board.items.map(item => {
        const previous = previousItems.get(item.id);
        if (!previous || previous === item) return [item.id, item];
        for (const key of Object.keys(previous)) delete previous[key];
        return [item.id, Object.assign(previous, item)];
    }));
    for (const id of [...itemViews.keys()]) disposeItem(id);
    const wasExtended = canvasExtended;
    canvasExtended = Array.isArray(board.canvases) && board.canvases.length > 0;
    const definitions = canvasExtended ? board.canvases : [{ id: canvasStates[0].id, name: 'Canvas 1', camera: board.camera,
        cardIds: board.cards.map(card => card.id), itemIds: board.items.map(item => item.id) }];
    canvasStates = definitions.map((definition, index) => {
        // Desktop owns membership and geometry; browser navigation remains local to each canvas.
        const canvas = canvasStates.find(canvas => canvas.id === definition.id)
            || (!wasExtended && index === 0 ? canvasStates[0] : canvasState(definition));
        canvas.id = definition.id; canvas.name = definition.name;
        Object.assign(canvas.board, { name: board.name, cards: definition.cardIds.map(id => cards.get(id)),
            items: definition.itemIds.map(id => items.get(id)) });
        const ids = new Set([...canvas.board.cards, ...canvas.board.items].map(item => item.id));
        canvas.selection = new Set([...canvas.selection].filter(id => ids.has(id)));
        if (!ids.has(canvas.selected)) canvas.selected = null;
        if (!canvas.board.cards.some(card => card.id === canvas.focused)) canvas.focused = null;
        canvas.split = canvas.focused ? validSplit(canvas.split, canvas.board.cards) : null;
        return canvas;
    });
    setWorkspaceTerminalTheme(board.terminalTheme);
    setHooksPaused(!!board.hooksPaused);
    for (const canvas of canvasStates) {
        activeCanvas = canvas; workspace = canvas.board;
        for (const card of workspace.cards) {
            const s = sessions.get(card.id);
            if (!s) mount(card);
            else {
                s.canvas = canvas;
                if (s.terminal) s.terminal.options.fontSize = terminalFontSize(card);
                renderCardGeometry(card); recoveryInfo(card); renderAccount(card); renderTerminalAppearance(card);
                s.element.querySelector('.card-title').textContent = card.title;
                s.element.querySelector('.card-title').setAttribute('aria-label', `Rename terminal: ${card.title}`);
            }
        }
        workspace.items.forEach(mountItem);
    }
    $('#workspace-name').value = board.name;
    revealCanvas(canvasStates.find(canvas => canvas.id === previousCanvas.id)
        || canvasStates.find(canvas => canvas.id === board.activeCanvas) || canvasStates[0], { restoreKeyboard: false });
    refresh();
}

function remoteTerminals(terminals) {
    for (const terminal of terminals) {
        const s = sessions.get(terminal.id), card = anyCard(terminal.id);
        if (!s || !card) continue;
        if (s.remoteGeneration !== terminal.generation) {
            s.generation++;
            if (terminal.running) {
                s.terminal?.reset();
                s.canvas.activity = '';
            }
        }
        s.remoteGeneration = terminal.generation;
        s.terminal?.resize(terminal.cols, terminal.rows);
        // Keep desktop columns even when Focus view or a narrower browser would propose another size.
        const screen = s.element.querySelector('.terminal-body .xterm');
        if (screen) screen.style.width = `${Math.ceil(terminal.cols * terminalFontSize(card) * 0.61)}px`;
        if (terminal.running) setStatus(card, 'running');
        else if (s.status === 'running') {
            s.terminal?.writeln('\r\n\x1b[90m[Terminal stopped]\x1b[0m');
            setStatus(card, 'exited');
        }
    }
}
async function canReplace() {
    if (canvasMutation || boardBusy() || imageImports || formBusy || duplicateBusy) return false;
    if (canvasStates.length === 1 && !workspace.cards.length && !workspace.items.length) return true;
    return confirmAction('Replace this workspace?', keepEnabled ? 'Save a workspace file first if you want to keep this layout. Kept terminals keep running and attach again when you reopen this workspace; others stop.' : 'Save a workspace file first if you want to keep this layout. Running terminals will stop; their output will not be saved.', 'Replace workspace');
}
async function save() {
    workspace.name = $('#workspace-name').value.trim() || 'Untitled workspace';
    if (bridge.remote) { if (remoteController()) await downloadWorkspace(false); return; }
    const result = await invoke('save', workspace); if (!result.canceled) toast('Workspace saved. Restoring it will not rerun commands.');
}
$('#save').onclick = () => run(save);
$('#open-workspace').onclick = () => run(async () => {
    if (bridge.remote) {
        if (!remoteController() || boardBusy()) return;
        const file = await chooseBrowserFile('.terminalcanvas,.json');
        if (!file || !await canReplace()) return;
        if (file.size > 64 * 1024 * 1024) throw new Error('Workspace files must be smaller than 64 MB.');
        await controlTerminal({ action: 'open-workspace', workspace: JSON.parse(await file.text()) });
        return;
    }
    if (!await canReplace()) return;
    const result = await invoke('open');
    if (result.workspace) { loadWorkspace(result.workspace, result.titleEpoch); changed(); toast('Workspace restored. Start each terminal when you are ready.'); attachKept(result.keepRunning); }
});
$('#new-workspace').onclick = () => run(async () => {
    if (!await canReplace()) return;
    if (bridge.remote) { await controlTerminal({ action: 'new-workspace' }); return; }
    const result = await invoke('new'); loadWorkspace(result.workspace, result.titleEpoch); changed();
});
$('#workspace-name').oninput = () => { if (!boardBusy()) { workspace.name = $('#workspace-name').value.trim() || 'Untitled workspace'; changed(); } };
$('#canvas-list').onchange = () => { if (!switchCanvas($('#canvas-list').value)) renderCanvases(); };
$('#canvas-add').onclick = () => createCanvas();
$('#canvas-rename').onclick = renameCanvas;
$('#canvas-earlier').onclick = () => reorderCanvas(-1);
$('#canvas-later').onclick = () => reorderCanvas(1);
$('#canvas-delete').onclick = () => run(deleteCanvas);
document.addEventListener('focusin', event => {
    if (activeCanvas && !event.target.closest('.canvas-manager')) activeCanvas.typing = !!event.target.closest('.xterm');
});
$('#canvas-form').onsubmit = event => {
    event.preventDefault();
    const name = $('#canvas-name').value.trim() || 'Untitled canvas';
    if (name.length > 100 || /[\x00-\x1f]/.test(name)) return toast('Invalid canvas name.');
    activeCanvas.name = name; canvasExtended = true;
    $('#canvas-dialog').close(); renderCanvases(); changed();
};
$('#search').oninput = () => { if (ready) refresh(); };
$('#canvas-nav').onclick = () => { if (ready) fitCanvas(); };
$('#add-terminal').onclick = $('#empty-add').onclick = () => openLaunch();
$('#arrange').onclick = () => {
    if (!ready || boardBusy()) return; setFocus(null);
    const columns = Math.max(1, Math.ceil(Math.sqrt(workspace.cards.length)));
    recordChange(() => workspace.cards.forEach((c, i) => { c.x = (i % columns) * 700; c.y = Math.floor(i / columns) * 470; c.w = 660; c.h = 430; renderGeometry(c); }));
    fitCanvas();
};
$('#focus-toggle').onclick = toggleFocus;
$('#exit-focus').onclick = () => setFocus(null);
$('#fit').onclick = () => { if (ready) fitCanvas(); };
$('#zoom-in').onclick = () => { if (ready) zoom(1.15); };
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#zoom-out').onclick = () => { if (ready) zoom(1 / 1.15); };
$('#zoom-reset').onclick = () => { if (ready) zoom(1 / workspace.camera.z); };
function chooseBrowserFile(accept) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = accept; input.hidden = true;
        const finish = file => { input.remove(); resolve(file); };
        input.onchange = () => finish(input.files[0]);
        input.oncancel = () => finish(null);
        document.body.append(input); input.click();
    });
}
async function downloadWorkspace(portable) {
    await saveRemoteLayout();
    const { name, text, missing } = await invoke('workspace-copy', { portable });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (missing) toast(`Downloaded the workspace. ${missing} image${missing === 1 ? ' was' : 's were'} unavailable.`);
}
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
    if (bridge.remote) {
        if (!remoteController() || boardBusy()) return;
        const file = await chooseBrowserFile('image/png,image/jpeg,image/gif,image/webp');
        if (file) await importImageFiles([file], viewportCenterWorld());
        return;
    }
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
    if (bridge.remote) { if (remoteController()) await downloadWorkspace(true); return; }
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
$('#help').onclick = () => info('A workspace that moves with you.', '<p class="info-copy">Launch a terminal for each task or AI agent. Drag its header to move it, pull the bottom-right corner to resize, and use Focus for uninterrupted work.</p><div class="help-grid"><span>New terminal</span><kbd>Ctrl Shift N</kbd><span>New / rename / delete canvas</span><kbd>Ctrl Shift K / R / Delete</kbd><span>Previous / next canvas</span><kbd>Ctrl Shift PageUp / PageDown</kbd><span>Reorder current canvas</span><kbd>Ctrl Alt Shift PageUp / PageDown</kbd><span>Duplicate selected terminal (fresh shell)</span><kbd>Ctrl Shift D</kbd><span>Save / open workspace</span><kbd>Ctrl S / Ctrl O</kbd><span>Toggle focused terminal</span><kbd>Ctrl Shift F</kbd><span>Split view of 2 to 4 selected terminals / resize panes</span><kbd>Ctrl Shift F / drag or arrow keys on a divider</kbd><span>Hide / show sidebar</span><kbd>Ctrl/Cmd Shift B</kbd><span>Reveal sidebar search</span><kbd>/</kbd><span>Find terminal (Command on macOS)</span><kbd>Ctrl Shift P</kbd><span>Choose / reveal / cancel in the switcher</span><kbd>↑ ↓ / Enter / Esc</kbd><span>Select the nearest terminal in a direction</span><kbd>Alt + arrow keys</kbd><span>Type in the selected terminal / back to the canvas</span><kbd>Enter / Ctrl Shift E</kbd><span>Copy selected terminal text</span><kbd>Ctrl C / Ctrl Shift C</kbd><span>Paste terminal text</span><kbd>Ctrl V / Ctrl Shift V</kbd><span>Interrupt (clear text selection first)</span><kbd>Ctrl C</kbd><span>Select / hand / text / note</span><kbd>V / H / T / N</kbd><span>Rectangle / ellipse / frame</span><kbd>R / O / F</kbd><span>Line / arrow (drag between items to connect)</span><kbd>L / A</kbd><span>Add to selection / select area</span><kbd>Shift click / Shift drag</kbd><span>Group / ungroup (groups can nest)</span><kbd>Ctrl G / Ctrl Shift G</kbd><span>Undo / redo board changes</span><kbd>Ctrl Z / Ctrl Shift Z</kbd><span>Copy / cut / paste / duplicate items</span><kbd>Ctrl C / X / V / D</kbd><span>Edit text / delete items</span><kbd>Double-click / Delete</kbd><span>Add an image</span><kbd>Paste or drop a file</kbd><span>Pan the canvas</span><kbd>Drag background / middle-drag</kbd><span>Zoom at pointer over empty canvas</span><kbd>Scroll / two-finger scroll</kbd><span>Zoom at pointer elsewhere</span><kbd>Ctrl / Cmd + scroll</kbd><span>Terminal text size: over the selected terminal or in Focus / reset</span><kbd>Ctrl + scroll / Ctrl 0</kbd></div><p class="info-note">Scroll or two-finger scroll over empty canvas to zoom at the pointer. Plain scrolling over terminals, board items, and controls keeps its usual behavior. Horizontal-only scrolling and plain scrolling in Focus view do not zoom. A scroll gesture stays with its starting area; pause before scrolling a different area.</p><p class="info-note">Sidebar search and Alt + arrow keys apply to the current canvas. Alt + arrow keys select a terminal without typing in it, so they work while the canvas has the keyboard; inside a terminal they reach the program. Press Ctrl Shift E to leave a terminal, then Enter to type in the one you chose. A terminal that is not running gets its Start button instead. In Focus view, Alt + arrow keys change the focused terminal.</p><p class="info-note">Terminal shortcuts work in canvas and fullscreen Focus views. Ctrl C copies selected text and interrupts the shell when no text is selected. Click inside the terminal to clear a text selection before interrupting. On macOS, Command C/V also copy/paste; Ctrl C still interrupts without a selection.</p><p class="info-note">Workspaces save layouts, folders, launch commands, and board items. Images stay in this app&rsquo;s data folder; use Export portable copy to embed them in a file you can move to another computer. Terminal output and running processes are not restored. Commands only run when you start a terminal.</p>');
$('#plugins').onclick = () => info('One canvas. More possibilities.', '<p class="info-copy">Terminal Canvas starts with a terminal card type and a desktop host API. This is the foundation for bringing other tools into the workspace.</p><p class="info-note"><strong>WebCanvas · Planned</strong><br>Browser cards alongside AI terminals, using isolated browser views. Plugin loading and browser integration are not implemented in this version.</p>');
document.addEventListener('keydown', event => {
    if (!ready || event.isComposing || document.querySelector('dialog[open]')) return;
    if (!$('#canvas-menu').hidden) {
        if (event.key === 'Tab') { closeCanvasMenu({ restoreFocus: true }); return; }
        event.preventDefault();
        if (event.key === 'Escape') closeCanvasMenu({ restoreFocus: true });
        else if (event.key === 'ArrowDown') focusCanvasMenu(canvasMenuIndex + 1);
        else if (event.key === 'ArrowUp') focusCanvasMenu(canvasMenuIndex - 1);
        else if (event.key === 'Home') focusCanvasMenu(0);
        else if (event.key === 'End') focusCanvasMenu(canvasMenuButtons().length - 1);
        else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) canvasMenuButtons()[canvasMenuIndex].click();
        return;
    }
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && !event.ctrlKey && !event.metaKey && !event.altKey && emptyCanvasTarget(event.target)) {
        if (openCanvasMenu(canvasKeyboardPoint())) event.preventDefault();
        return;
    }
    if (canvasShortcut(event)) return;
    // A held Enter never presses a terminal's buttons: Enter on the board moves focus to a stopped
    // terminal's Start or Resume button, and only a separate press may start it.
    if (event.key === 'Enter' && event.repeat && event.target.closest('.terminal-card button')) { event.preventDefault(); return; }
    if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === 'p' && event.shiftKey && !event.altKey && !event.isComposing) {
            event.preventDefault(); if (!event.repeat) openTerminalSwitcher(); return;
        }
        if (key === 'b' && event.shiftKey && !event.altKey) {
            event.preventDefault();
            if (!event.repeat) $('#sidebar-toggle').click();
            return;
        }
        if (key === 's') { event.preventDefault(); run(save); }
        if (key === 'o') { event.preventDefault(); $('#open-workspace').click(); }
        if (key === 'd' && event.shiftKey && !event.altKey && !event.repeat && !event.target.closest('input,select,textarea:not(.xterm-helper-textarea),[contenteditable="true"]')) {
            const card = findCard(event.target.closest('.terminal-card')?.dataset.id || selected);
            if (card) { event.preventDefault(); run(() => duplicateTerminal(card)); }
        }
        if (key === 'n' && event.shiftKey) { event.preventDefault(); openLaunch(); }
        if (key === 'f' && event.shiftKey) { event.preventDefault(); toggleFocus(); }
        if (key === 'e' && event.shiftKey && !event.altKey) { event.preventDefault(); leaveToBoard(event.target); }
        const onBoard = !focused && !event.target.closest('input,textarea,select,.xterm');
        if (key === 'g' && onBoard) { event.preventDefault(); event.shiftKey ? ungroupSelection() : groupSelection(); }
        if (((key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)) && onBoard) { event.preventDefault(); redo(); }
        else if (key === 'z' && onBoard) { event.preventDefault(); undo(); }
        // Ctrl+V arrives as a paste event, which also carries images from other apps.
        if (!event.shiftKey && onBoard && (key === 'c' || key === 'x') && copySelection({ cut: key === 'x' })) event.preventDefault();
        if (!event.shiftKey && onBoard && key === 'd') { event.preventDefault(); duplicateSelection(); }
        return;
    }
    // Alt+Arrow inside a terminal or text field stays there; the minimap handles its own arrow keys first.
    const direction = NAV_DIRECTIONS[event.key];
    if (direction && event.altKey && !event.shiftKey && !event.target.closest('input,textarea,select,.xterm,[contenteditable="true"]')) {
        event.preventDefault(); navigateTerminals(direction); return;
    }
    if (event.altKey || event.target.closest('input,textarea,select,.xterm,[contenteditable="true"]')) return;
    if (event.key === '/') {
        event.preventDefault();
        sidebarPreferences.outline = false;
        setSidebarCollapsed(false);
        $('#search').focus(); return;
    }
    // A focused button, link, or the minimap keeps Enter for itself.
    if (event.key === 'Enter' && !event.shiftKey && !event.repeat && !event.target.closest('button,a[href],[contenteditable="true"],#minimap-map')) {
        if (findCard(focused || selected)) { event.preventDefault(); enterTerminal(focused || selected); }
        return;
    }
    if (focused) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
    if (event.key === 'Escape') { if (activeTool !== 'select') setTool('select'); else setSelection([]); return; }
    const shortcut = { v: 'select', h: 'hand', t: 'text', n: 'note', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', f: 'frame' }[event.key.toLowerCase()];
    if (shortcut && !event.shiftKey) { event.preventDefault(); setTool(shortcut); }
});
// The Rust host reports its version and any update it found in the GitHub releases; Electron sends none.
let offeredUpdate = null;
function showUpdate(event) {
    if (event.current) $('#app-version').textContent = `v${event.current}`;
    offeredUpdate = event.update || null;
    const button = $('#update');
    button.hidden = !offeredUpdate;
    if (!offeredUpdate) return;
    const { version, notes, installable } = offeredUpdate;
    button.disabled = false;
    button.innerHTML = `${icon(installable ? 'package' : 'arrow-up-right')}${installable ? 'Restart to update' : 'Update available'}`;
    button.title = (installable ? `Terminal Canvas ${version} is ready. Restart to install it.` : `Terminal Canvas ${version} is available. Open its release page to download it.`) + (notes ? `\n\n${notes.slice(0, 500)}` : '');
}
$('#update').onclick = () => run(async () => {
    const update = offeredUpdate;
    if (!update || !ready) return;
    if (!update.installable) { await invoke('open-link', update.url); return; }
    const running = [...sessions.values()].filter(s => ['running', 'starting'].includes(s.status)).length;
    if (running && !await confirmAction('Restart and update?', `Terminal Canvas ${update.version} is ready. ${running} running terminal${running === 1 ? '' : 's'} will stop. Your layout will be saved; terminal output will not.`, 'Restart and update')) return;
    $('#update').disabled = true;
    try { await invoke('update-install'); } catch (error) { $('#update').disabled = false; throw error; }
    clearTimeout(autosaveTimer); await invoke('close', workspace);
});
window.addEventListener('resize', () => { if (ready) { renderCamera(); renderFocus(); } });
installPointerControls();

// Output is acknowledged once xterm has parsed it, which paces the program writing it. xterm parses
// on timers, and a minimized or covered window throttles them to as little as one a minute, which
// would stall the program at the host's high watermark. While the window is hidden, output is
// acknowledged as it arrives instead, leaving at most this many UTF-16 units waiting to be parsed.
const HIDDEN_PARSE_BACKLOG = 4_000_000;
// The host ignores a larger acknowledgment.
const ACK_CHUNK = 1024 * 1024;
async function captureRemoteScreens(event) {
    const encoder = new TextEncoder();
    let remaining = 2 * 1024 * 1024;
    const screens = Object.create(null);
    await Promise.all(event.ids.map(id => {
        const s = sessions.get(id);
        if (!s?.terminal || s.status !== 'running') return;
        const generation = s.generation;
        // This barrier runs after PTY writes before the host's capture event and before later writes.
        return new Promise((resolve, reject) => s.terminal.write('', () => {
            if (sessions.get(id) !== s || s.status !== 'running' || s.generation !== generation) return resolve();
            const addon = new window.SerializeAddon.SerializeAddon();
            s.terminal.loadAddon(addon);
            try {
                let screen = addon.serialize({ scrollback: 0 });
                if (s.terminal.buffer.active.type === 'alternate') {
                    // The addon emits the normal screen first, followed by DECSET 1049 and the alternate screen.
                    const start = screen.indexOf('\x1b[?1049h');
                    screen = start < 0 ? '' : screen.slice(start);
                }
                // xterm 6's serializer omits DECTCEM. Preserve it so focusing a browser copy
                // cannot draw a block cursor over a cell where the desktop hides the cursor.
                if (s.terminal._core?.coreService?.isCursorHidden) screen += '\x1b[?25l';
                const bytes = encoder.encode(screen).length;
                if (bytes <= remaining) { screens[id] = screen; remaining -= bytes; }
                resolve();
            } catch (error) { reject(error); }
            finally { addon.dispose(); }
        }));
    }));
    await invoke('remote-snapshot', { requestId: event.requestId, screens });
}

function writeOutput(s, id, data) {
    s.ackId = id;
    s.unacknowledged = (s.unacknowledged || 0) + data.length;
    s.unparsed = (s.unparsed || 0) + data.length;
    s.terminal.write(data, () => { s.unparsed -= data.length; acknowledgeOutput(s); });
    acknowledgeOutput(s);
}
function acknowledgeOutput(s) {
    const held = document.hidden ? Math.max(0, s.unparsed - HIDDEN_PARSE_BACKLOG) : s.unparsed;
    for (let amount = s.unacknowledged - held; amount > 0; amount -= ACK_CHUNK) {
        const part = Math.min(amount, ACK_CHUNK);
        s.unacknowledged -= part;
        bridge.acknowledge(s.ackId, part);
    }
}
// Output already waiting when the window is hidden would otherwise hold the terminal paused.
document.addEventListener('visibilitychange', () => { for (const s of sessions.values()) if (s.unacknowledged) acknowledgeOutput(s); });
if (bridge) {
    bridge.onEvent(event => {
        if (!bridge.remote && event.type === 'remote-capture') {
            captureRemoteScreens(event).catch(error => toast(error.message));
        }
        if (!bridge.remote && event.type === 'remote-terminal-request') run(() => runRemoteTerminalRequest(event));
        if (bridge.remote && event.type === 'remote-workspace' && ready) receiveRemoteWorkspace(event.workspace, event.titleEpoch);
        if (bridge.remote && event.type === 'remote-terminals' && ready) remoteTerminals(event.terminals);
        if (bridge.remote && event.type === 'remote-disconnected') {
            document.body.classList.remove('remote-controller');
            $('#workspace-name').readOnly = true;
            for (const s of sessions.values()) if (s.terminal) s.terminal.options.disableStdin = true;
            const banner = $('#remote-banner');
            if (banner) banner.textContent = event.message;
            toast(event.message);
        }
        const s = sessions.get(event.id);
        if (event.type === 'title' && s && event.titleEpoch === titleEpoch) {
            if (s.namingPending) {
                if (Number.isSafeInteger(event.titleRevision) && event.titleRevision > (s.deferredTitle?.titleRevision || 0)) s.deferredTitle = event;
            } else applyTitleEvent(event);
        }
        if (event.type === 'metadata') {
            const card = anyCard(event.id);
            if (card) {
                if (s) s.metadataRevision++;
                if (s && !event.initial && event.cwd !== card.cwd) s.cwd = event.cwd;
                card.cwd = event.cwd;
                if (event.session) card.session = event.session;
                recoveryInfo(card); changed(); refresh();
            }
        }
        if (event.type === 'data') {
            markCanvasActivity(s, 'New output');
            if (s?.status === 'starting') {
                const output = (s.startupQueryTail || '') + event.data;
                s.startupCursorQueries += [...output.matchAll(/\x1b\[6n/g)].length;
                s.startupQueryTail = output.slice(-3);
            }
            if (s?.terminal) writeOutput(s, event.id, event.data);
            else bridge.acknowledge(event.id, event.data.length);
        }
        if (event.type === 'cwd' && s) showDirectory(s, event.cwd);
        if (event.type === 'recovered' && s && event.exitCode !== undefined) {
            s.terminal?.writeln(`\x1b[?1049l\x1b[!p\r\n\x1b[90m[Shell exited · code ${event.exitCode}. Started a fresh shell.]\x1b[0m`);
            markCanvasActivity(s, 'New output');
        }
        if (event.type === 'exit' && s) { s.terminal?.writeln(`\r\n\x1b[90m[Process exited · code ${event.exitCode}]\x1b[0m`); markCanvasActivity(s, 'Exited'); setStatus(s.card, 'exited'); }
        if (event.type === 'error') toast(event.message);
        if (event.type === 'update') showUpdate(event);
        if (event.type === 'launch') requestTerminal(event);
        if (event.type === 'pointer') pointerEvent(event);
        if (event.type === 'keep-status') showKeep(event.status);
        if (event.type === 'pointers-paused') { setHooksPaused(true); renderLines(); renderPointerControls(); toast(event.message); }
        if (event.type === 'closing') run(async () => {
            if (event.running && !await confirmAction('Close Terminal Canvas?', keepEnabled ? `Kept terminals keep running and attach again when you reopen; others stop. Your layout will be saved.` : `${event.running} running terminal${event.running === 1 ? '' : 's'} will stop. Your layout will be saved; terminal output will not.`, 'Close app')) return;
            clearTimeout(autosaveTimer); await invoke('close', workspace);
        });
    });
    run(async () => {
        const initial = await invoke('initialize'); profiles = initial.profiles;
        pointerPlatform = initial.platform;
        $('#platform-chrome').media = initial.platform === 'darwin' ? 'all' : 'not all';
        for (const p of profiles) {
            const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; $('#profile').append(option);
            const button = document.createElement('button'); button.className = 'profile-button'; button.append(mark(p));
            const label = document.createElement('span'); label.textContent = p.name; button.append(label);
            const arrow = document.createElement('span'); arrow.className = 'launch-arrow'; arrow.innerHTML = icon('plus'); button.append(arrow);
            button.onclick = () => openLaunch(p.id); $('#profile-list').append(button);
            const menuButton = document.createElement('button');
            menuButton.type = 'button'; menuButton.setAttribute('role', 'menuitem'); menuButton.tabIndex = -1;
            const menuLabel = document.createElement('span'); menuLabel.textContent = p.name;
            menuButton.append(mark(p), menuLabel);
            menuButton.onclick = () => { const point = canvasMenuPoint; openLaunch(p.id, { point }); };
            $('#canvas-menu-profiles').append(menuButton);
        }
        $('#cwd').value = initial.home; $('#runtime-label').textContent = initial.preview ? 'Browser preview · shells unavailable' : initial.platform === 'win32' ? 'Windows · ConPTY' : 'Local · PTY';
        loadWorkspace(initial.workspace, initial.titleEpoch); ready = true; markAppReady(); renderStyleToolbar();
        if (bridge.remote) {
            document.body.classList.add('remote-client');
            document.body.classList.toggle('remote-controller', remoteController());
            remoteLayoutBase = layoutKey(initial.workspace);
            $('#workspace-name').readOnly = !remoteController();
            $('#save-state').lastChild.textContent = remoteController() ? 'Saved on desktop' : 'Read-only viewer';
            $('#runtime-label').textContent = `Browser · ${initial.role === 'control' ? 'Controller' : 'Read-only viewer'}`;
            const banner = document.createElement('div'); banner.id = 'remote-banner'; banner.className = 'remote-banner';
            banner.setAttribute('role', 'status');
            banner.textContent = initial.role === 'control' ? 'Controller · create and manage terminals.' : 'Read-only viewer';
            document.body.append(banner);
            remoteTerminals(initial.terminals || []);
            for (const [id, output] of Object.entries(initial.output || {})) {
                const s = sessions.get(id);
                if (s?.terminal) { s.replaying = true; s.terminal.write(output, () => { s.replaying = false; }); }
            }
        }
        if (initial.warning) toast(initial.warning);
        tmuxPending = !!initial.tmuxSetup;
        attachKept(initial.keepRunning);
        if (initial.agentSetup) await openAgentSetup({ offer: true });
        offerTmuxSetup();
    });
} else toast('Desktop bridge unavailable. Run cargo run -p terminal-canvas.');
