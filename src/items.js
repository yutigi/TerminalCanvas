/* Board items: text labels, sticky notes, shapes, frames, images, and lines/connectors.
   Loaded before renderer.js. Only declarations live here; functions read renderer state when called. */
'use strict';
const Geometry = window.TerminalCanvasGeometry;
const itemViews = new Map();
const SVG_NS = 'http://www.w3.org/2000/svg';
const ITEM_LIMIT = 1000;
const GROUP_DEPTH = 8;
const CREATION_TOOLS = Object.freeze(['text', 'note', 'rect', 'ellipse', 'frame', 'line', 'arrow']);
const ITEM_DEFAULTS = Object.freeze({
    text: { w: 220, h: 40, min: [40, 24] },
    note: { w: 200, h: 200, min: [80, 80] },
    rect: { w: 180, h: 110, min: [20, 20] },
    ellipse: { w: 150, h: 150, min: [20, 20] },
    frame: { w: 720, h: 460, min: [120, 80] },
    image: { w: 320, h: 240, min: [24, 24] }
});
// Fixed palettes; an absent `color` or `fontSize` is the default look.
const ITEM_COLORS = Object.freeze(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']);
const ITEM_FONT_SIZES = Object.freeze(['small', 'large', 'huge']);
const COLORED_TYPES = Object.freeze(['text', 'note', 'shape', 'frame', 'line']);
const TEXT_TYPES = Object.freeze(['text', 'note', 'shape']);
const itemKind = item => (item.type === 'shape' ? item.shape : item.type);
const clampCoordinate = n => Math.max(-100000, Math.min(100000, n));
const clampSize = (n, min) => Math.max(min, Math.min(8000, n));
const newId = () => crypto.randomUUID();
const assetUrl = name => `tc-asset://images/${encodeURIComponent(name)}`;
const findItem = id => workspace.items.find(item => item.id === id);
const findCard = id => workspace.cards.find(card => card.id === id);
const findElement = id => findCard(id) || findItem(id);
const elementNode = id => sessions.get(id)?.element || itemViews.get(id)?.element;
const zOf = id => Number(elementNode(id)?.style.zIndex) || 0;
function attachTarget(id) {
    const e = findElement(id);
    if (!e || e.type === 'line') return null;
    return { bounds: { x: e.x, y: e.y, w: e.w, h: e.h }, ellipse: e.type === 'shape' && e.shape === 'ellipse' };
}
const linePoints = line => Geometry.resolveLine(line, attachTarget);
function boundsOf(e) {
    if (e.type !== 'line') return { x: e.x, y: e.y, w: e.w, h: e.h };
    const { start, end } = linePoints(e);
    return Geometry.boundsOfPoints([start, end]);
}
function elementRecords() {
    return [...workspace.cards, ...workspace.items].map(e => ({ id: e.id, groups: e.groups, bounds: boundsOf(e), z: zOf(e.id), line: e.type === 'line' }));
}
function setGroups(e, path) {
    if (path.length) e.groups = path;
    else delete e.groups;
}
// Removing elements can leave a group with one member; such a group no longer groups anything.
function pruneGroups() {
    const elements = [...workspace.cards, ...workspace.items];
    Geometry.pruneGroupPaths(elements).forEach((path, index) => setGroups(elements[index], path));
}
function attachableAt(point, exclude) {
    return Geometry.topmostAt(point, elementRecords().filter(r => !r.line && r.id !== exclude))?.id || null;
}
function toWorld(event) {
    const rect = viewport.getBoundingClientRect(), { x, y, z } = workspace.camera;
    return { x: clampCoordinate((event.clientX - rect.left - x) / z), y: clampCoordinate((event.clientY - rect.top - y) / z) };
}
function viewportCenterWorld() {
    const { x, y, z } = workspace.camera;
    return { x: (viewport.clientWidth / 2 - x) / z, y: (viewport.clientHeight / 2 - y) / z };
}
function svgNode(tag, className) {
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute('class', className);
    return node;
}
function mountItem(item) {
    if (item.type === 'line') return mountLine(item);
    const el = document.createElement('div');
    el.className = `canvas-item item-${item.type}${item.type === 'shape' ? ` shape-${item.shape}` : ''}`;
    el.dataset.id = item.id;
    const view = { element: el };
    if (item.type === 'frame') {
        view.title = document.createElement('div'); view.title.className = 'frame-title';
        el.append(view.title);
    } else if (item.type === 'image') {
        const img = document.createElement('img');
        img.alt = ''; img.draggable = false;
        img.addEventListener('error', () => el.classList.add('missing'));
        img.src = assetUrl(item.asset);
        const missing = document.createElement('span'); missing.className = 'image-missing'; missing.textContent = 'Image unavailable';
        el.append(img, missing);
    } else {
        view.text = document.createElement('div'); view.text.className = 'item-body';
        el.append(view.text);
    }
    const resize = document.createElement('div');
    resize.className = 'item-resize'; resize.title = 'Drag to resize';
    el.append(resize);
    itemViews.set(item.id, view);
    if (item.type !== 'frame') el.style.zIndex = String(++topCardZIndex);
    world.append(el);
    renderItem(item);
    // Frames are grabbed by their title so the empty area inside them still pans the canvas.
    const grab = view.title || el;
    grab.addEventListener('pointerdown', event => pointerOnElement(event, item.id, grab));
    grab.addEventListener('dblclick', () => { if (item.type === 'frame') editFrameTitle(item); else if (view.text) startEditing(item.id); });
    resize.addEventListener('pointerdown', event => { event.stopPropagation(); resizeItem(event, item, resize); });
    return view;
}
function mountLine(item) {
    const group = svgNode('g', 'canvas-line');
    group.dataset.id = item.id;
    const hit = svgNode('path', 'line-hit'), stroke = svgNode('path', 'line-stroke');
    const handles = ['start', 'end'].map(end => {
        const handle = svgNode('circle', 'line-handle');
        handle.setAttribute('r', '6'); handle.dataset.end = end;
        handle.addEventListener('pointerdown', event => { event.stopPropagation(); dragEndpoint(event, item, end, handle); });
        return handle;
    });
    group.append(hit, stroke, ...handles);
    $('#line-layer').append(group);
    const view = { element: group, hit, stroke, handles };
    itemViews.set(item.id, view);
    hit.addEventListener('pointerdown', event => pointerOnElement(event, item.id, hit));
    renderLine(item);
    return view;
}
function applyItemStyle(item, element) {
    element.classList.toggle('colored', !!item.color);
    for (const color of ITEM_COLORS) element.classList.toggle(`color-${color}`, item.color === color);
    for (const size of ITEM_FONT_SIZES) element.classList.toggle(`size-${size}`, item.fontSize === size);
}
function renderItem(item) {
    const view = itemViews.get(item.id);
    if (!view) return;
    if (item.type === 'line') return renderLine(item);
    applyItemStyle(item, view.element);
    Object.assign(view.element.style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` });
    // Larger frames sit further back so a frame drawn around smaller ones never hides them.
    if (item.type === 'frame') { view.element.style.zIndex = String(-1 - Math.round(item.w * item.h / 100)); view.title.textContent = item.title; }
    else if (view.text && !view.editor) view.text.textContent = item.text;
}
function renderLine(item) {
    const view = itemViews.get(item.id);
    if (!view) return;
    const { start, end } = linePoints(item);
    applyItemStyle(item, view.element);
    const path = `M${start.x} ${start.y}L${end.x} ${end.y}`;
    view.hit.setAttribute('d', path);
    view.stroke.setAttribute('d', path);
    if (item.arrow) view.stroke.setAttribute('marker-end', 'url(#arrowhead)');
    else view.stroke.removeAttribute('marker-end');
    view.element.classList.toggle('attached', !!(item.start.id || item.end.id));
    [start, end].forEach((point, index) => { view.handles[index].setAttribute('cx', String(point.x)); view.handles[index].setAttribute('cy', String(point.y)); });
}
function renderLines() { for (const item of workspace.items) if (item.type === 'line') renderLine(item); }
function placeElement(e) { if (e.type === 'terminal') renderCardGeometry(e); else renderItem(e); }
function disposeItem(id) {
    const view = itemViews.get(id);
    if (!view) return;
    view.element.remove();
    itemViews.delete(id);
}
// Connectors keep their last drawn position when the element they point at is removed.
function detachConnectors(ids) {
    const removed = new Set(ids);
    for (const line of workspace.items) {
        if (line.type !== 'line' || removed.has(line.id)) continue;
        const points = linePoints(line);
        if (removed.has(line.start.id)) line.start = points.start;
        if (removed.has(line.end.id)) line.end = points.end;
    }
}
function removeItems(ids) {
    const targets = ids.filter(id => findItem(id));
    if (!targets.length) return;
    detachConnectors(targets);
    for (const id of targets) { disposeItem(id); selection.delete(id); }
    workspace.items = workspace.items.filter(item => !targets.includes(item.id));
    pruneGroups();
    if (targets.includes(selected)) selected = [...selection].at(-1) ?? null;
    applySelection(); renderLines(); changed();
}
// Adds items as one undoable step and selects them. `edit` opens a single new item for typing.
function addItems(list, { edit = false } = {}) {
    if (workspace.items.length + list.length > ITEM_LIMIT) { toast('A workspace can contain up to 1,000 canvas items.'); return null; }
    const before = snapshotBoard();
    commitHistory(before);
    workspace.items.push(...list);
    list.forEach(mountItem);
    if (list.length === 1) select(list[0].id);
    else setSelection(list.map(item => item.id));
    renderLines(); changed();
    if (edit && list.length === 1) startEditing(list[0].id, { created: before });
    return list;
}
function addItem(item, options) { return addItems([item], options)?.[0] ?? null; }
function makeItem(kind, rect) {
    const item = { id: newId(), x: clampCoordinate(rect.x), y: clampCoordinate(rect.y), w: rect.w, h: rect.h };
    if (kind === 'rect' || kind === 'ellipse') return { ...item, type: 'shape', shape: kind, text: '' };
    if (kind === 'frame') return { ...item, type: 'frame', title: `Frame ${workspace.items.filter(i => i.type === 'frame').length + 1}` };
    return { ...item, type: kind, text: '' };
}
// Creation tools: click for a default size, or drag to draw. Lines attach to whatever they start or end on.
function beginCreate(event) {
    const kind = activeTool, start = toWorld(event);
    if (workspace.items.length >= ITEM_LIMIT) return toast('A workspace can contain up to 1,000 canvas items.');
    if (kind === 'line' || kind === 'arrow') {
        const from = attachableAt(start);
        recordHistory();
        const line = { id: newId(), type: 'line', start: from ? { id: from } : start, end: { ...start }, arrow: kind === 'arrow' };
        workspace.items.push(line);
        mountLine(line);
        beginDrag(viewport, event, (_dx, _dy, e) => { line.end = toWorld(e); renderLine(line); }, (moved, e) => {
            if (!moved) line.end = { x: clampCoordinate(start.x + 160), y: start.y };
            else { const to = attachableAt(toWorld(e), from); if (to) line.end = { id: to }; }
            setTool('select'); select(line.id); renderMinimap(); changed();
        });
        return;
    }
    const draft = $('#draft'), defaults = ITEM_DEFAULTS[kind];
    const place = rect => Object.assign(draft.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    draft.hidden = false; place({ ...start, w: 0, h: 0 });
    beginDrag(viewport, event, (_dx, _dy, e) => place(Geometry.rectFromPoints(start, toWorld(e))), (moved, e) => {
        draft.hidden = true;
        const rect = moved ? Geometry.rectFromPoints(start, toWorld(e))
            : kind === 'text' ? { x: start.x, y: start.y - defaults.h / 2, w: defaults.w, h: defaults.h }
            : { x: start.x - defaults.w / 2, y: start.y - defaults.h / 2, w: defaults.w, h: defaults.h };
        rect.w = clampSize(rect.w, defaults.min[0]); rect.h = clampSize(rect.h, defaults.min[1]);
        setTool('select');
        addItem(makeItem(kind, rect), { edit: kind === 'text' || kind === 'note' });
    });
}
function resizeItem(event, item, handle) {
    if (event.button !== 0 || focused) return;
    if (!selection.has(item.id)) select(item.id);
    const { min } = ITEM_DEFAULTS[itemKind(item)], start = { w: item.w, h: item.h }, ratio = item.w / item.h, z = workspace.camera.z;
    beginDrag(handle, event, (dx, dy) => {
        item.w = clampSize(start.w + dx / z, min[0]);
        item.h = item.type === 'image' ? clampSize(item.w / ratio, min[1]) : clampSize(start.h + dy / z, min[1]);
        renderItem(item); renderLines(); renderSelectionBox();
    }, moved => { if (moved) { renderMinimap(); changed(); } }, { history: true });
}
function dragEndpoint(event, line, which, handle) {
    if (event.button !== 0 || focused) return;
    const other = which === 'start' ? 'end' : 'start';
    const original = line[which];
    beginDrag(handle, event, (_dx, _dy, e) => { line[which] = toWorld(e); renderLine(line); renderSelectionBox(); }, (moved, e) => {
        if (!moved) { line[which] = original; renderLine(line); return; }
        const target = attachableAt(toWorld(e), line[other].id);
        if (target) line[which] = { id: target };
        renderLine(line); renderSelectionBox(); renderMinimap(); changed();
    }, { history: true });
}
// Text, note, and shape content is plain text edited in place; empty text labels are removed.
// `created` is the history step that added a new item, so typing its first text is part of that step.
function startEditing(id, { created = null } = {}) {
    const item = findItem(id), view = itemViews.get(id);
    if (!item || !view?.text || editing) return;
    editing = id;
    view.session = { created, before: created ? null : snapshotBoard() };
    const editor = document.createElement('textarea');
    editor.className = 'item-editor'; editor.value = item.text; editor.maxLength = 10000;
    editor.setAttribute('aria-label', item.type === 'note' ? 'Sticky note text' : item.type === 'shape' ? 'Shape text' : 'Text label');
    view.editor = editor; view.text.hidden = true;
    view.element.classList.add('editing');
    view.element.append(editor);
    editor.addEventListener('pointerdown', event => event.stopPropagation());
    editor.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) { event.preventDefault(); editor.blur(); }
    });
    editor.addEventListener('input', () => { if (item.type === 'text') fitTextHeight(item, editor); });
    editor.addEventListener('blur', () => finishEditing(id), { once: true });
    editor.focus(); editor.select();
}
// A text label's height follows its content when its text size changes.
function fitTextLabel(item) {
    const element = itemViews.get(item.id)?.element;
    if (!element || item.type !== 'text') return;
    element.style.height = 'auto';
    const height = element.offsetHeight;
    if (height) item.h = clampSize(Math.ceil(height), ITEM_DEFAULTS.text.min[1]);
    renderItem(item);
}
function fitTextHeight(item, editor) {
    editor.style.height = '0px';
    const height = editor.scrollHeight;
    editor.style.height = '';
    if (height) { item.h = clampSize(Math.ceil(height) + 2, ITEM_DEFAULTS.text.min[1]); renderItem(item); renderLines(); renderSelectionBox(); }
}
function finishEditing(id) {
    const item = findItem(id), view = itemViews.get(id);
    editing = null;
    if (!item || !view?.editor) return;
    const session = view.session || {};
    view.session = null;
    const text = view.editor.value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '');
    const edited = text !== item.text;
    item.text = text;
    if (item.type === 'text') fitTextHeight(item, view.editor);
    view.editor.remove(); view.editor = null;
    view.text.hidden = false; view.element.classList.remove('editing');
    if (item.type === 'text' && !item.text.trim()) {
        if (session.created) discardHistory(session.created);
        else if (session.before) commitHistory(session.before);
        return removeItems([id]);
    }
    if (edited && session.before) commitHistory(session.before);
    renderItem(item); changed();
}
function editFrameTitle(item) {
    const view = itemViews.get(item.id);
    if (!view || editing) return;
    editing = item.id;
    const before = snapshotBoard();
    const input = document.createElement('input');
    input.className = 'frame-title-editor'; input.value = item.title; input.maxLength = 100;
    input.setAttribute('aria-label', 'Frame title');
    view.title.hidden = true; view.element.append(input);
    input.addEventListener('pointerdown', event => event.stopPropagation());
    input.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); input.blur(); } });
    input.addEventListener('blur', () => {
        editing = null;
        const title = input.value.replace(/[\x00-\x1f]/g, ' ').trim() || 'Frame';
        if (title !== item.title) commitHistory(before);
        item.title = title;
        input.remove(); view.title.hidden = false;
        renderItem(item); changed();
    }, { once: true });
    input.focus(); input.select();
}
function placeImage(asset, point) {
    return new Promise(resolve => {
        const probe = new Image();
        const finish = (width, height) => {
            const scale = Math.min(1, 480 / Math.max(width, height));
            const w = clampSize(Math.round(width * scale), ITEM_DEFAULTS.image.min[0]), h = clampSize(Math.round(height * scale), ITEM_DEFAULTS.image.min[1]);
            resolve(addItem({ id: newId(), type: 'image', asset, x: clampCoordinate(point.x - w / 2), y: clampCoordinate(point.y - h / 2), w, h }));
        };
        probe.onload = () => finish(probe.naturalWidth || ITEM_DEFAULTS.image.w, probe.naturalHeight || ITEM_DEFAULTS.image.h);
        probe.onerror = () => finish(ITEM_DEFAULTS.image.w, ITEM_DEFAULTS.image.h);
        probe.src = assetUrl(asset);
    });
}
// Counts imports between storing an image and placing it, when cleanup would see it as unused.
let imageImports = 0;
async function importing(task) {
    imageImports++;
    try { return await task(); } finally { imageImports--; }
}
// Image bytes go to the desktop host, which validates and stores them; the workspace keeps only the name.
function importImageFiles(files, point) {
    return importing(async () => {
        const images = [...files].filter(file => /^image\//.test(file.type));
        for (const [index, file] of images.entries()) {
            if (file.size > 15 * 1024 * 1024) { toast(`${file.name || 'Image'} is larger than 15 MB.`); continue; }
            const { asset } = await invoke('import-image', { bytes: new Uint8Array(await file.arrayBuffer()) });
            await placeImage(asset, { x: point.x + index * 24, y: point.y + index * 24 });
        }
        return images.length;
    });
}
// Images still in use: the workspace, its undo and redo steps, and copied items waiting to be pasted.
function referencedImages() {
    const names = new Set();
    const add = items => { for (const item of items) if (item.type === 'image') names.add(item.asset); };
    add(workspace.items);
    for (const step of [...boardHistory.undo, ...boardHistory.redo]) add(step.items);
    if (boardClipboard) add(boardClipboard.items);
    return [...names];
}
const formatBytes = bytes => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
async function cleanUpImages() {
    if (imageImports) return toast('Wait for images to finish importing, then try again.');
    const { count, bytes } = await invoke('unused-images', { keep: referencedImages() });
    if (!count) return toast('No unused images to delete.');
    const plural = count === 1 ? '' : 's';
    if (!await confirmAction(`Delete ${count} unused image${plural}?`,
        `This frees ${formatBytes(bytes)}. They are not used by this workspace, its undo history, or copied items. Workspace files you saved earlier, other than portable copies, will show them as unavailable.`,
        `Delete image${plural}`)) return;
    if (imageImports) return toast('Wait for images to finish importing, then try again.');
    const result = await invoke('delete-unused-images', { keep: referencedImages() });
    toast(`Deleted ${result.deleted} unused image${result.deleted === 1 ? '' : 's'} (${formatBytes(result.bytes)}).`);
}
// The style toolbar edits the color of selected items and the text size of those that hold text.
const selectedItems = types => [...selection].map(findItem).filter(item => item && types.includes(item.type));
function renderStyleToolbar() {
    const bar = $('#style-toolbar');
    const colored = ready && !focused ? selectedItems(COLORED_TYPES) : [];
    const texts = colored.filter(item => TEXT_TYPES.includes(item.type));
    bar.hidden = !colored.length;
    $('#style-sizes').hidden = $('#style-divider').hidden = !texts.length;
    if (bar.hidden) return;
    const shared = (list, key, fallback) => (list.every(item => (item[key] || fallback) === (list[0][key] || fallback)) ? list[0][key] || fallback : null);
    const color = shared(colored, 'color', 'default'), size = texts.length ? shared(texts, 'fontSize', 'medium') : null;
    bar.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.color === color)));
    bar.querySelectorAll('[data-font-size]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fontSize === size)));
}
function setItemColor(color) {
    if (boardBusy()) return;
    const items = selectedItems(COLORED_TYPES);
    if (!items.length || (color !== 'default' && !ITEM_COLORS.includes(color))) return;
    recordHistory();
    for (const item of items) {
        if (color === 'default') delete item.color;
        else item.color = color;
        renderItem(item);
    }
    renderStyleToolbar(); changed();
}
function setItemFontSize(size) {
    if (boardBusy()) return;
    const items = selectedItems(TEXT_TYPES);
    if (!items.length || (size !== 'medium' && !ITEM_FONT_SIZES.includes(size))) return;
    recordHistory();
    for (const item of items) {
        if (size === 'medium') delete item.fontSize;
        else item.fontSize = size;
        renderItem(item);
        fitTextLabel(item);
    }
    renderLines(); renderSelectionBox(); renderStyleToolbar(); renderMinimap(); changed();
}
