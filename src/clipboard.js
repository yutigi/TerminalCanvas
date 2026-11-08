/* Copy, cut, paste, and duplicate for board items. Loaded after history.js; functions read renderer
   state when called. Terminals are not copied, because each one owns a shell process. */
'use strict';
const PASTE_OFFSET = 24;
const CLIPBOARD_TEXT_LIMIT = 10000;
// `marker` is the text written to the system clipboard. Pasting uses these items only while that text
// is still on the clipboard, so copying something else in another app takes precedence.
let boardClipboard = null;
const normalizeClipboardText = text => String(text ?? '').replace(/\r\n?/g, '\n').trim();
// Selected items, everything inside selected frames, and whole groups, in stacking order.
function copyableItems() {
    const records = elementRecords();
    let ids = new Set([...selection].filter(id => findItem(id)));
    for (const id of [...ids]) {
        const frame = findItem(id);
        if (frame.type === 'frame') Geometry.frameContents({ id, bounds: boundsOf(frame) }, records).forEach(key => ids.add(key));
    }
    ids = Geometry.expandGroups(ids, records);
    return workspace.items.filter(item => ids.has(item.id));
}
// Self-contained copies: connector ends attached outside the copied set become free points.
function clipboardItems() {
    const items = copyableItems(), inside = new Set(items.map(item => item.id));
    return items.map(item => {
        const copy = cloneData(item);
        if (copy.type === 'line') {
            const points = linePoints(item);
            for (const end of ['start', 'end']) if (copy[end].id && !inside.has(copy[end].id)) copy[end] = { ...points[end] };
        }
        return copy;
    });
}
function clipboardBounds(items) {
    const lookup = id => {
        const e = items.find(item => item.id === id);
        return e ? { bounds: { x: e.x, y: e.y, w: e.w, h: e.h }, ellipse: e.type === 'shape' && e.shape === 'ellipse' } : null;
    };
    return Geometry.unionBounds(items.map(item => {
        if (item.type !== 'line') return { x: item.x, y: item.y, w: item.w, h: item.h };
        const { start, end } = Geometry.resolveLine(item, lookup);
        return Geometry.boundsOfPoints([start, end]);
    }));
}
// New IDs and groups for every paste; groups that lost members outside the copied set are dropped.
function cloneItems(items, dx, dy) {
    const ids = new Map(items.map(item => [item.id, newId()])), groups = new Map();
    const group = id => { if (!groups.has(id)) groups.set(id, newId()); return groups.get(id); };
    const shift = point => ({ x: clampCoordinate(point.x + dx), y: clampCoordinate(point.y + dy) });
    const clones = cloneData(items).map(item => {
        item.id = ids.get(item.id);
        if (item.groups) item.groups = item.groups.map(group);
        if (item.type !== 'line') return Object.assign(item, shift(item));
        for (const end of ['start', 'end']) item[end] = item[end].id ? { id: ids.get(item[end].id) } : shift(item[end]);
        return item;
    });
    Geometry.pruneGroupPaths(clones).forEach((path, index) => setGroups(clones[index], path));
    return clones;
}
function clipboardSummary(items) {
    const text = items.map(item => item.text ?? item.title ?? '').filter(value => value.trim()).join('\n\n');
    return (text || `${items.length} canvas item${items.length === 1 ? '' : 's'}`).slice(0, CLIPBOARD_TEXT_LIMIT);
}
function copySelection({ cut = false } = {}) {
    const items = clipboardItems();
    if (!items.length) {
        if (selection.size) toast('Terminals cannot be copied. Start a new terminal instead.');
        return false;
    }
    const clip = { items, bounds: clipboardBounds(items), marker: clipboardSummary(items), pastes: 0 };
    boardClipboard = clip;
    // Without a system clipboard (the browser preview), the next paste uses these items regardless.
    invoke('clipboard-write', clip.marker).catch(() => { clip.marker = null; });
    if (cut) { recordHistory(); removeItems(items.map(item => item.id)); }
    return true;
}
function visibleWorld() {
    const { x, y, z } = workspace.camera;
    return { x: -x / z, y: -y / z, w: viewport.clientWidth / z, h: viewport.clientHeight / z };
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
// Each paste lands a step further from the original; out-of-sight copies land in the middle of the view.
function pasteBoardItems() {
    if (!boardClipboard || focused) return false;
    const { items, bounds } = boardClipboard;
    let dx = PASTE_OFFSET * (boardClipboard.pastes + 1), dy = dx;
    if (!overlaps({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, visibleWorld())) {
        const center = viewportCenterWorld();
        dx = Math.round(center.x - (bounds.x + bounds.w / 2));
        dy = Math.round(center.y - (bounds.y + bounds.h / 2));
    }
    if (!addItems(cloneItems(items, dx, dy))) return false;
    boardClipboard.pastes++;
    return true;
}
function duplicateSelection() {
    if (focused) return false;
    const items = clipboardItems();
    if (!items.length) {
        if (selection.size) toast('Terminals cannot be duplicated. Start a new terminal instead.');
        return false;
    }
    return !!addItems(cloneItems(items, PASTE_OFFSET, PASTE_OFFSET));
}
// Handles a paste on the board: images first, then items copied in this app.
function pasteFromClipboard(data) {
    const files = [...(data?.files || [])];
    if (files.some(file => /^image\//.test(file.type))) {
        run(() => importImageFiles(files, viewportCenterWorld()));
        return true;
    }
    if (!boardClipboard) return false;
    const { marker } = boardClipboard;
    if (marker !== null && normalizeClipboardText(data?.getData?.('text/plain')) !== normalizeClipboardText(marker)) return false;
    return pasteBoardItems();
}
