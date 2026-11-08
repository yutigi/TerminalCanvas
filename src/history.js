/* Undo and redo for the board. Loaded after items.js; functions read renderer state when called.
   A step restores board items plus terminal geometry and groups. Terminals are never created or
   closed by undo, because that would start or stop processes. */
'use strict';
const HISTORY_LIMIT = 100;
const boardHistory = { undo: [], redo: [] };
const cloneData = value => JSON.parse(JSON.stringify(value));
// The redo steps a commit cleared, so discarding that commit can bring them back.
const clearedRedo = new WeakMap();
// Board commands wait for a drag to finish, so the drag's undo step and theirs cannot interleave.
const boardBusy = () => activeDrags > 0;
// Steps store each item as JSON text. An unchanged item reuses the previous step's string, so a step
// only costs memory for the items that changed.
let sharedItemJson = new Map();
function snapshotBoard() {
    const items = workspace.items.map(item => {
        const json = JSON.stringify(item), previous = sharedItemJson.get(item.id);
        return previous === json ? previous : json;
    });
    sharedItemJson = new Map(workspace.items.map((item, index) => [item.id, items[index]]));
    const stacked = [...workspace.cards, ...workspace.items].filter(e => e.type !== 'line');
    return {
        cards: workspace.cards.map(({ id, x, y, w, h, groups }) => cloneData({ id, x, y, w, h, groups })),
        items,
        // Stacking order, so undoing a deletion returns items to their depth instead of on top.
        z: Object.fromEntries(stacked.map(e => [e.id, zOf(e.id)])),
        // Image names the step needs, so cleanup keeps them without parsing every step.
        assets: [...new Set(workspace.items.filter(item => item.type === 'image').map(item => item.asset))],
        selection: [...selection]
    };
}
const sameBoard = (a, b) => a.items.length === b.items.length && a.items.every((json, index) => json === b.items[index])
    && JSON.stringify(a.cards) === JSON.stringify(b.cards);
// Work that must not land inside a drag, such as an image whose import just finished, waits for it.
let idleWaiters = [];
function whenBoardIdle() { return boardBusy() ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }
function notifyBoardIdle() {
    if (boardBusy()) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
}
function renderHistoryButtons() {
    $('#undo').disabled = !boardHistory.undo.length;
    $('#redo').disabled = !boardHistory.redo.length;
}
// Call with a snapshot taken before a change, once the change is known to have happened.
function commitHistory(snapshot) {
    clearedRedo.set(snapshot, boardHistory.redo);
    boardHistory.undo.push(snapshot);
    if (boardHistory.undo.length > HISTORY_LIMIT) boardHistory.undo.shift();
    boardHistory.redo = [];
    renderHistoryButtons();
}
function recordHistory() { commitHistory(snapshotBoard()); }
// Runs `change` and records it as a step only if it altered the board, so repeating it adds nothing.
function recordChange(change) {
    const before = snapshotBoard();
    const result = change();
    if (!sameBoard(before, snapshotBoard())) commitHistory(before);
    return result;
}
// Drops a step that turned out to change nothing, such as an empty text label that was removed,
// and restores the redo steps that recording it cleared.
function discardHistory(snapshot) {
    if (snapshot && boardHistory.undo.at(-1) === snapshot) {
        boardHistory.undo.pop();
        boardHistory.redo = clearedRedo.get(snapshot) || [];
    }
    renderHistoryButtons();
}
function clearHistory() {
    boardHistory.undo = []; boardHistory.redo = [];
    renderHistoryButtons();
}
const canStepHistory = () => ready && !focused && !editing && !activeDrags;
function undo() { if (canStepHistory()) stepHistory(boardHistory.undo, boardHistory.redo); }
function redo() { if (canStepHistory()) stepHistory(boardHistory.redo, boardHistory.undo); }
function stepHistory(from, to) {
    if (!from.length) return;
    const target = from.pop();
    to.push(snapshotBoard());
    restoreBoard(target);
    renderHistoryButtons();
}
// Items are updated in place so their views and event handlers stay attached.
function restoreBoard(snapshot) {
    const savedItems = snapshot.items.map(json => JSON.parse(json));
    const remembered = new Map([...snapshot.cards, ...savedItems.filter(item => item.type !== 'line')].map(e => [e.id, e]));
    for (const saved of snapshot.cards) {
        const card = findCard(saved.id);
        if (!card) continue;
        Object.assign(card, { x: saved.x, y: saved.y, w: saved.w, h: saved.h });
        setGroups(card, saved.groups ? [...saved.groups] : []);
        renderCardGeometry(card);
    }
    const current = new Map(workspace.items.map(item => [item.id, item]));
    const next = savedItems.map(saved => {
        const item = current.get(saved.id);
        if (!item) return saved;
        for (const key of Object.keys(item)) delete item[key];
        return Object.assign(item, saved);
    });
    const kept = new Set(next.map(item => item.id));
    for (const id of current.keys()) if (!kept.has(id)) disposeItem(id);
    workspace.items = next;
    // A terminal closed since the snapshot leaves its connectors with free ends where it was.
    const lookup = id => attachGeometry(findElement(id) || remembered.get(id));
    for (const line of next.filter(item => item.type === 'line')) {
        const lost = ['start', 'end'].filter(end => line[end].id && !findElement(line[end].id));
        if (!lost.length) continue;
        const points = Geometry.resolveLine(line, lookup);
        for (const end of lost) line[end] = { x: clampCoordinate(points[end].x), y: clampCoordinate(points[end].y) };
    }
    for (const item of next) if (itemViews.has(item.id)) renderItem(item); else mountItem(item);
    for (const [id, z] of Object.entries(snapshot.z)) {
        const node = elementNode(id);
        if (node && findElement(id)?.type !== 'frame') node.style.zIndex = String(z);
    }
    pruneGroups();
    setSelection(snapshot.selection.filter(id => findElement(id)));
    renderLines(); renderMinimap(); refresh(); changed();
}
