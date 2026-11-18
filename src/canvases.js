/* Optional format-3 canvas metadata. `workspace` is the visible board; snapshots flatten
   every board for host recovery, portable assets, and the existing renderer/host API. */
'use strict';
let canvasStates = [], activeCanvas = null, canvasExtended = false, canvasMutation = false;
function canvasState({ id = newId(), name = 'Canvas 1', camera = { x: 48, y: 48, z: 1 }, cards = [], items = [], selected, focused } = {}) {
    return { id, name, board: { version: 3, name: '', camera, cards, items }, selected, focused,
        selection: new Set(selected ? [selected] : []), history: { undo: [], redo: [] },
        clearedRedo: { step: null, redo: [] }, sharedItemJson: new Map(), activity: '', typing: false, focusSidebarRevealed: false };
}
function rememberCanvas() {
    if (!activeCanvas) return;
    Object.assign(activeCanvas, { selected, focused, selection, keyboardCurrent, revealOnReturn, focusSidebarRevealed,
        history: { undo: boardHistory.undo, redo: boardHistory.redo }, clearedRedo, sharedItemJson,
        typing: document.activeElement?.closest?.('.canvas-manager') ? activeCanvas.typing : !!document.activeElement?.closest?.('.xterm') });
}
function workspaceSnapshot() {
    rememberCanvas();
    const snapshot = { version: 3, name: workspace.name, camera: workspace.camera,
        cards: canvasStates.flatMap(canvas => canvas.board.cards), items: canvasStates.flatMap(canvas => canvas.board.items) };
    if (workspace.terminalTheme) snapshot.terminalTheme = workspace.terminalTheme;
    if (canvasExtended) {
        snapshot.canvases = canvasStates.map(canvas => ({ id: canvas.id, name: canvas.name, camera: canvas.board.camera,
            cardIds: canvas.board.cards.map(card => card.id), itemIds: canvas.board.items.map(item => item.id),
            ...(canvas.selected && [...canvas.board.cards, ...canvas.board.items].some(item => item.id === canvas.selected) ? { selected: canvas.selected } : {}),
            ...(canvas.focused && canvas.board.cards.some(card => card.id === canvas.focused) ? { focused: canvas.focused } : {}) }));
        snapshot.activeCanvas = activeCanvas.id;
    }
    return snapshot;
}
function canvasForCard(id) { return canvasStates.find(canvas => canvas.board.cards.some(card => card.id === id)); }
function anyCard(id) { return canvasForCard(id)?.board.cards.find(card => card.id === id); }
function workspaceItemCount() { return canvasStates.reduce((count, canvas) => count + canvas.board.items.length, 0); }
function canvasLocked() {
    return !ready || boardBusy() || imageImports > 0 || formBusy || duplicateBusy || canvasMutation
        || [...sessions.values()].some(s => s.closing) || !!document.querySelector('dialog[open]');
}
function renderCanvases() {
    const list = $('#canvas-list');
    // Only update a label on output; do not rebuild the controls for each background chunk.
    if (list.children.length !== canvasStates.length || [...list.children].some((option, index) => option.value !== canvasStates[index].id)) {
        list.replaceChildren(...canvasStates.map(canvas => {
            const option = document.createElement('option'); option.value = canvas.id; return option;
        }));
    }
    for (const [index, canvas] of canvasStates.entries()) {
        const text = canvas.name + (canvas.activity ? ` · ${canvas.activity}` : '');
        if (list.children[index].textContent !== text) list.children[index].textContent = text;
    }
    list.value = activeCanvas?.id || '';
    $('#canvas-earlier').disabled = canvasStates.indexOf(activeCanvas) <= 0;
    $('#canvas-later').disabled = canvasStates.indexOf(activeCanvas) === canvasStates.length - 1;
    $('#canvas-delete').disabled = canvasStates.length <= 1;
    const unread = canvasStates.filter(canvas => canvas !== activeCanvas && canvas.activity);
    const activity = $('#canvas-activity');
    activity.hidden = !unread.length;
    activity.textContent = unread.map(canvas => `${canvas.name}: ${canvas.activity}`).join(' · ');
}
function markCanvasActivity(s, activity) {
    if (!s || s.canvas === activeCanvas || s.canvas.activity === 'Exited' || s.canvas.activity === activity
        || (s.canvas.activity === 'Bell' && activity === 'New output')) return;
    s.canvas.activity = activity;
    renderCanvases();
}
function revealCanvas(canvas, { restoreKeyboard = true } = {}) {
    const typing = canvas.typing;
    activeCanvas = canvas; workspace = canvas.board; canvas.activity = '';
    selected = canvas.selected || null; selection = canvas.selection; keyboardCurrent = canvas.keyboardCurrent || null;
    revealOnReturn = canvas.revealOnReturn || null;
    boardHistory.undo = canvas.history.undo; boardHistory.redo = canvas.history.redo;
    clearedRedo = canvas.clearedRedo; sharedItemJson = canvas.sharedItemJson;
    for (const s of sessions.values()) s.element.hidden = s.canvas !== canvas;
    const visibleItems = new Set(workspace.items.map(item => item.id));
    for (const [id, view] of itemViews) view.element.style.display = visibleItems.has(id) ? '' : 'none';
    focused = canvas.focused || null;
    focusSidebarRevealed = canvas.focusSidebarRevealed;
    viewport.classList.toggle('focus-mode', !!focused); $('#exit-focus').hidden = !focused;
    for (const [id, s] of sessions) s.element.classList.toggle('focused', s.canvas === canvas && id === focused);
    // The saved camera already belongs to this canvas's Focus/sidebar state. Reapplying
    // the chrome must not compensate it again on every trip between canvases.
    renderSidebar({ preserveCenter: false });
    renderCamera(); renderLines(); applySelection(false); renderHistoryButtons(); renderCanvases(); renderThemeControls();
    if (restoreKeyboard) {
        if (typing && sessions.get(focused || selected)?.status === 'running') sessions.get(focused || selected).terminal?.focus();
        else viewport.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => {
        if (activeCanvas !== canvas) return;
        for (const card of workspace.cards) fitTerminal(sessions.get(card.id));
    });
}
function switchCanvas(id) {
    const canvas = canvasStates.find(canvas => canvas.id === id);
    if (!canvas || canvas === activeCanvas) return !!canvas;
    if (canvasLocked()) return false;
    if (editing) document.activeElement?.blur();
    rememberCanvas(); canvas.board.name = workspace.name;
    setTool('select'); revealCanvas(canvas); changed();
    return true;
}
function createCanvas(name = `Canvas ${canvasStates.length + 1}`) {
    if (canvasLocked()) return false;
    const canvas = canvasState({ name });
    canvasExtended = true; canvasStates.push(canvas); setWorkspaceTerminalTheme(workspace.terminalTheme); switchCanvas(canvas.id);
    return canvas;
}
function reorderCanvas(delta) {
    if (canvasLocked()) return;
    const from = canvasStates.indexOf(activeCanvas), to = from + delta;
    if (to < 0 || to >= canvasStates.length) return;
    canvasStates.splice(from, 1); canvasStates.splice(to, 0, activeCanvas);
    canvasExtended = true; renderCanvases(); changed();
}
function renameCanvas() {
    if (canvasLocked()) return;
    $('#canvas-name').value = activeCanvas.name;
    $('#canvas-dialog').showModal(); $('#canvas-name').focus(); $('#canvas-name').select();
}
async function deleteCanvas() {
    if (canvasLocked() || canvasStates.length <= 1) return;
    const canvas = activeCanvas;
    const running = canvas.board.cards.filter(card => ['running', 'starting'].includes(sessions.get(card.id)?.status)).length;
    if (!await confirmAction(`Delete “${canvas.name}”?`,
        `Its terminals and board items will be removed. ${running ? `${running} running terminal${running === 1 ? '' : 's'} and their child processes will stop. ` : ''}This cannot be undone.`, 'Delete canvas')) return;
    if (activeCanvas !== canvas || boardBusy() || imageImports || formBusy || duplicateBusy) return;
    canvasMutation = true;
    try {
        // Preserve the canvas if a stop fails; never dispose a view with its process still alive.
        for (const card of canvas.board.cards) await invoke('stop', { id: card.id });
        const index = canvasStates.indexOf(canvas), next = canvasStates[index - 1] || canvasStates[index + 1];
        if (editing) document.activeElement?.blur();
        for (const card of canvas.board.cards) dispose(card.id);
        for (const item of canvas.board.items) disposeItem(item.id);
        next.board.name = workspace.name;
        canvasStates.splice(index, 1); canvasExtended = true; revealCanvas(next); changed();
    } finally { canvasMutation = false; }
}
function canvasShortcut(event, { detect = false } = {}) {
    const key = event.key.toLowerCase();
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return false;
    if (!['pageup', 'pagedown', 'k', 'r', 'delete'].includes(key) || (event.altKey && !key.startsWith('page'))) return false;
    if (detect) return true;
    event.preventDefault();
    if (event.repeat || canvasLocked()) return true;
    if (key === 'k') createCanvas();
    if (key === 'r') renameCanvas();
    if (key === 'delete') run(deleteCanvas);
    if (key.startsWith('page')) {
        const delta = key === 'pageup' ? -1 : 1;
        if (event.altKey) reorderCanvas(delta);
        else switchCanvas(canvasStates[(canvasStates.indexOf(activeCanvas) + delta + canvasStates.length) % canvasStates.length].id);
    }
    return true;
}
