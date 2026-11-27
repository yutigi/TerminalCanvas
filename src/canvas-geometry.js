/* Pure canvas geometry shared by the renderer and dependency-free tests. */
(function (root) {
    'use strict';
    const center = b => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    function rectFromPoints(a, b) {
        return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    }
    const containsPoint = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const containsRect = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
    // The point where a ray from the element's center toward `toward` leaves its rectangle or ellipse.
    function clipToBounds(b, toward, ellipse = false) {
        const c = center(b), dx = toward.x - c.x, dy = toward.y - c.y;
        const rx = b.w / 2, ry = b.h / 2;
        if ((!dx && !dy) || !rx || !ry) return c;
        const t = ellipse
            ? 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
            : Math.min(dx ? rx / Math.abs(dx) : Infinity, dy ? ry / Math.abs(dy) : Infinity);
        if (t >= 1) return c; // `toward` lies inside the element; keep the connector visible from the center.
        return { x: c.x + dx * t, y: c.y + dy * t };
    }
    // `lookup(id)` returns `{ bounds, ellipse }` for an attachable element, or null when it is gone.
    function resolveLine(line, lookup) {
        const target = end => (end.id ? lookup(end.id) : null);
        const start = target(line.start), end = target(line.end);
        const anchor = (shape, raw) => (shape ? center(shape.bounds) : { x: raw.x, y: raw.y });
        const a = anchor(start, line.start), b = anchor(end, line.end);
        return {
            start: start ? clipToBounds(start.bounds, b, start.ellipse) : a,
            end: end ? clipToBounds(end.bounds, a, end.ellipse) : b
        };
    }
    function boundsOfPoints(points) {
        const xs = points.map(p => p.x), ys = points.map(p => p.y);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    function unionBounds(list) {
        if (!list.length) return null;
        return boundsOfPoints(list.flatMap(b => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
    }
    // `elements` are `{ id, groups?, bounds?, z? }`, with `groups` listed outermost first.
    // Grouped elements always select together as their outermost group.
    const outerGroup = e => e.groups?.[0];
    function expandGroups(ids, elements) {
        const groups = new Set(elements.filter(e => ids.has(e.id) && outerGroup(e)).map(outerGroup));
        const result = new Set(ids);
        for (const e of elements) if (groups.has(outerGroup(e))) result.add(e.id);
        return result;
    }
    // The units a selection is made of: each outermost group once, plus every ungrouped element.
    function selectionUnits(elements) {
        return new Set(elements.map(e => outerGroup(e) ?? `element:${e.id}`));
    }
    // Wrapping whole units in a new outermost group keeps the nesting a tree.
    function groupPaths(elements, group) {
        return elements.map(e => [group, ...(e.groups || [])]);
    }
    function ungroupPaths(elements) {
        return elements.map(e => (e.groups || []).slice(1));
    }
    // A group needs at least two direct parts: inner groups or elements. One that holds a single
    // element, or only wraps one inner group, no longer groups anything and is removed.
    function pruneGroupPaths(elements) {
        const parts = new Map();
        for (const e of elements) {
            (e.groups || []).forEach((group, index) => {
                if (!parts.has(group)) parts.set(group, new Set());
                parts.get(group).add(e.groups[index + 1] ?? `element:${e.id}`);
            });
        }
        return elements.map(e => (e.groups || []).filter(group => parts.get(group).size > 1));
    }
    // Everything fully inside a frame travels with it, including nested frames and their contents.
    function frameContents(frame, elements) {
        return elements.filter(e => e.id !== frame.id && e.bounds && containsRect(frame.bounds, e.bounds)).map(e => e.id);
    }
    function marquee(rect, elements) {
        return elements.filter(e => e.bounds && containsRect(rect, e.bounds)).map(e => e.id);
    }
    function topmostAt(point, elements) {
        return [...elements].filter(e => e.bounds && containsPoint(e.bounds, point)).sort((a, b) => (b.z || 0) - (a.z || 0))[0] || null;
    }
    // A free spot of `size` beside `parent`, `gap` clear of every rectangle in `taken`. Tries the
    // column to the right first (level with the parent, then below, then above), then the row below.
    function placeBeside(parent, size, taken, gap = 80) {
        const padded = b => ({ x: b.x - gap / 2, y: b.y - gap / 2, w: b.w + gap, h: b.h + gap });
        const free = spot => !taken.some(b => intersects(padded(b), spot));
        const right = parent.x + parent.w + gap, below = parent.y + parent.h + gap;
        const candidates = [];
        for (let step = 0; step < 8; step++) {
            const offset = Math.ceil(step / 2) * (size.h + gap) * (step % 2 ? 1 : -1);
            candidates.push({ x: right, y: parent.y + offset });
        }
        for (let step = 0; step < 4; step++) candidates.push({ x: parent.x + step * (size.w + gap), y: below });
        return candidates.find(spot => free({ ...spot, ...size })) || { x: right, y: parent.y };
    }
    // A free spot of `size` centered on `point` if possible, else the nearest free cell of a grid
    // around it, ring by ring. Falls back to `point` itself when nothing nearby is free.
    function placeNear(point, size, taken, gap = 80) {
        const padded = b => ({ x: b.x - gap / 2, y: b.y - gap / 2, w: b.w + gap, h: b.h + gap });
        const origin = { x: point.x - size.w / 2, y: point.y - size.h / 2 };
        for (let ring = 0; ring <= 4; ring++) {
            for (let row = -ring; row <= ring; row++) {
                for (let col = -ring; col <= ring; col++) {
                    if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
                    const spot = { x: origin.x + col * (size.w + gap), y: origin.y + row * (size.h + gap) };
                    if (!taken.some(b => intersects(padded(b), { ...spot, ...size }))) return spot;
                }
            }
        }
        return origin;
    }
    // Keyboard navigation between terminals. `candidates` are `{ id, bounds }`; the result is an ID or null.
    // Results never depend on the order of `candidates`: every tie ends at the top-left card, then the
    // lower ID, so the same layout always answers the same way.
    const compareKeys = (a, b) => {
        for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const best = ranked => (ranked.length ? ranked.sort(compareKeys)[0].id : null);
    const AXES = { left: ['x', -1], right: ['x', 1], up: ['y', -1], down: ['y', 1] };
    const SIZE = { x: 'w', y: 'h' };
    // How far `b` lies outside `a`'s span on `axis`: zero when the spans overlap or touch.
    const spanGap = (a, b, axis) => Math.max(0, b[axis] - (a[axis] + a[SIZE[axis]]), a[axis] - (b[axis] + b[SIZE[axis]]));
    // The nearest candidate in `direction` ('left', 'right', 'up', 'down') from the rectangle `from`.
    // A candidate counts when its center lies past `from`'s center in that direction and it either
    // overlaps `from`'s span across the direction (its "beam") or sits within 45 degrees of it, so a
    // card one column over and far below is not "right". Candidates rank by the gap along the
    // direction plus twice the gap across it, then by how far their centers are off the line of
    // travel, then by how far along it they are. Overlapping and oversized cards have zero gaps, so
    // a card partly under another is still reachable. A card with exactly `from`'s center lies in no
    // direction, so the pair is ordered instead: the one nearer the top left, then the one with the lower
    // ID (`fromId` is `from`'s), comes first and is reached with left and up; the other with right and down.
    function nearestInDirection(from, direction, candidates, fromId) {
        const axes = AXES[direction];
        if (!from || !axes) return null;
        const [major, sign] = axes, minor = major === 'x' ? 'y' : 'x', origin = center(from);
        const ranked = [];
        for (const { id, bounds: b } of candidates) {
            const c = center(b), along = (c[major] - origin[major]) * sign, across = Math.abs(c[minor] - origin[minor]);
            if (along < 0) continue;
            if (along === 0) {
                if (c[minor] !== origin[minor]) continue;
                const order = b.y - from.y || b.x - from.x || (id < fromId ? -1 : id > fromId ? 1 : 0);
                if (order * sign <= 0) continue;
            }
            const offBeam = spanGap(from, b, minor);
            if (offBeam > 0 && across > along) continue;
            const ahead = Math.max(0, sign > 0 ? b[major] - (from[major] + from[SIZE[major]]) : from[major] - (b[major] + b[SIZE[major]]));
            ranked.push({ id, key: [ahead + 2 * offBeam, across, along, b.y, b.x] });
        }
        return best(ranked);
    }
    // With nothing to move from, the candidate nearest `point`: zero for every card under it, then the
    // closest center.
    function nearestToPoint(point, candidates) {
        return best(candidates.map(({ id, bounds: b }) => {
            const dx = Math.max(0, b.x - point.x, point.x - (b.x + b.w)), dy = Math.max(0, b.y - point.y, point.y - (b.y + b.h));
            const c = center(b);
            return { id, key: [Math.hypot(dx, dy), Math.hypot(c.x - point.x, c.y - point.y), b.y, b.x] };
        }));
    }
    // The camera that shows `bounds` inside the viewport, kept `inset` clear of its edges, moving as
    // little as possible and never zooming. Something already in view stays put. Something larger
    // than the view on an axis has its top or left edge, and so its header, brought into view.
    // `avoid` lists rectangles in view coordinates that cover the canvas, such as toolbars and the
    // minimap. The card is also kept beside, above, or below each one, whichever moves least; when no
    // placement clears them all, it is shown within `inset` alone.
    function revealCamera(camera, bounds, view, inset = {}, avoid = []) {
        const { z } = camera;
        const axis = (position, start, size, length, before = 0, after = 0) => {
            let low = before, high = length - after;
            if (high - low < 1) { low = 0; high = length; }
            const near = position + start * z, far = near + size * z;
            if (far - near > high - low || near < low) return position + low - near;
            if (far > high) return position + high - far;
            return position;
        };
        const clamp = n => Math.max(-100000, Math.min(100000, n));
        const place = edges => ({
            x: clamp(axis(camera.x, bounds.x, bounds.w, view.width, edges.left, edges.right)),
            y: clamp(axis(camera.y, bounds.y, bounds.h, view.height, edges.top, edges.bottom)), z
        });
        const shown = c => ({ x: c.x + bounds.x * z, y: c.y + bounds.y * z, w: bounds.w * z, h: bounds.h * z });
        const moved = c => Math.abs(c.x - camera.x) + Math.abs(c.y - camera.y);
        // Widened insets must still hold the whole card; otherwise it would only clear the overlays by
        // running off the far edge of the view.
        const fits = ({ left = 0, top = 0, right = 0, bottom = 0 }) =>
            bounds.w * z <= view.width - left - right && bounds.h * z <= view.height - top - bottom;
        let found = null;
        // Each overlay the card still covers is cleared from one of its four sides by widening that inset;
        // a side that leaves no room for the card is skipped. There are only a few overlays, so trying
        // every combination stays cheap.
        const search = (edges, depth) => {
            if (depth > 0 && !fits(edges)) return;
            const next = place(edges), box = avoid.find(b => intersects(shown(next), b));
            if (!box) { if (!found || moved(next) < moved(found)) found = next; return; }
            if (depth >= avoid.length) return;
            const { left = 0, top = 0, right = 0, bottom = 0 } = edges;
            for (const side of [
                { left: Math.max(left, box.x + box.w) }, { right: Math.max(right, view.width - box.x) },
                { top: Math.max(top, box.y + box.h) }, { bottom: Math.max(bottom, view.height - box.y) }
            ]) {
                const wider = { left, top, right, bottom, ...side };
                if (view.width - wider.left - wider.right >= 1 && view.height - wider.top - wider.bottom >= 1) search(wider, depth + 1);
            }
        };
        search(inset, 0);
        return found || place(inset);
    }
    // Split view. `sizes` are each pane's share of the room, scaled to fill `area` side by side
    // (`orientation: 'row'`) or stacked ('column'), with `gap` pixels between panes for the dividers.
    function splitLayout(area, { orientation, sizes }, gap = 0) {
        const row = orientation === 'row', total = sizes.reduce((sum, size) => sum + size, 0) || 1;
        const room = Math.max(0, (row ? area.w : area.h) - gap * (sizes.length - 1));
        const panes = [], dividers = [];
        let offset = row ? area.x : area.y;
        sizes.forEach((size, index) => {
            const extent = room * size / total;
            panes.push(row ? { x: offset, y: area.y, w: extent, h: area.h } : { x: area.x, y: offset, w: area.w, h: extent });
            offset += extent;
            if (index === sizes.length - 1) return;
            dividers.push(row ? { x: offset, y: area.y, w: gap, h: area.h } : { x: area.x, y: offset, w: area.w, h: gap });
            offset += gap;
        });
        return { panes, dividers };
    }
    // Shares after moving the divider behind pane `index` by `delta` pixels of a `room` pixels long.
    // Only its two neighbours change; each keeps `min` pixels and 2% of the room, or half of what the
    // two have together if that is less. The result sums to 1.
    function moveSplitDivider(sizes, index, delta, room, min = 0) {
        const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
        const shares = sizes.map(size => size / total);
        if (!(room > 0) || index < 0 || index >= shares.length - 1) return shares;
        const pair = shares[index] + shares[index + 1], floor = Math.min(Math.max(min / room, .02), pair / 2);
        const first = Math.max(floor, Math.min(pair - floor, shares[index] + delta / room));
        shares[index] = first; shares[index + 1] = pair - first;
        return shares;
    }
    // The dock: terminals pinned beside the canvas in nested splits. A node is a pinned terminal
    // `{ cardId }` or a split `{ orientation: 'row' | 'column', children, sizes }` of two or more nodes
    // sharing its room, as in `splitLayout`. Nesting stops at DOCK_DEPTH splits.
    const DOCK_DEPTH = 32;
    const dockLeaves = node => (!node ? [] : node.cardId ? [node.cardId] : node.children.flatMap(dockLeaves));
    const dockDepth = node => (!node || node.cardId ? 0 : 1 + Math.max(...node.children.map(dockDepth)));
    const shares = sizes => { const total = sizes.reduce((sum, size) => sum + size, 0) || 1; return sizes.map(size => size / total); };
    // A split never holds a split of its own orientation: those children join it, keeping their room.
    function dockFlatten(node) {
        if (!node || node.cardId) return node;
        const children = [], sizes = [];
        node.children.map(dockFlatten).forEach((child, index) => {
            const share = shares(node.sizes)[index];
            if (child.cardId || child.orientation !== node.orientation) { children.push(child); sizes.push(share); return; }
            shares(child.sizes).forEach((inner, at) => { children.push(child.children[at]); sizes.push(share * inner); });
        });
        return { orientation: node.orientation, children, sizes };
    }
    // Every pinned terminal's rectangle (`panes`, by card ID) and every divider: its rectangle, the
    // path of child indexes to its split, the child before it, and the length of the split's room.
    function dockLayout(node, area, gap = 0) {
        const panes = new Map(), dividers = [];
        const visit = (node, area, path) => {
            if (node.cardId) { panes.set(node.cardId, area); return; }
            const { panes: rects, dividers: lines } = splitLayout(area, node, gap);
            const room = Math.max(0, (node.orientation === 'row' ? area.w : area.h) - gap * (node.children.length - 1));
            node.children.forEach((child, index) => visit(child, rects[index], [...path, index]));
            lines.forEach((rect, index) => dividers.push({ rect, path, index, orientation: node.orientation, room }));
        };
        if (node) visit(node, area, []);
        return { panes, dividers };
    }
    // `tree` with `cardId` pinned on `side` ('left', 'right', 'top', 'bottom') of the pane of `target`,
    // which gives it half its room; without a target that is in the tree, beside the whole dock.
    function dockInsert(tree, cardId, target = null, side = 'bottom') {
        const leaf = { cardId };
        tree = dockRemove(tree, cardId);
        if (!tree) return leaf;
        const orientation = side === 'left' || side === 'right' ? 'row' : 'column', first = side === 'left' || side === 'top';
        const beside = node => ({ orientation, children: first ? [leaf, node] : [node, leaf], sizes: [.5, .5] });
        if (target === null || !dockLeaves(tree).includes(target)) {
            // Beside the whole dock, the newcomer takes an equal share of a split of its orientation.
            if (tree.cardId || tree.orientation !== orientation) return beside(tree);
            const count = tree.children.length + 1, rest = shares(tree.sizes).map(size => size * (count - 1) / count);
            return { ...tree, children: first ? [leaf, ...tree.children] : [...tree.children, leaf], sizes: first ? [1 / count, ...rest] : [...rest, 1 / count] };
        }
        const visit = node => (node.cardId ? (node.cardId === target ? beside(node) : node) : { ...node, children: node.children.map(visit) });
        return dockFlatten(visit(tree));
    }
    // `tree` without `cardId`. A split left with one child gives way to it, and the other children
    // share the freed room in proportion. Null when no terminal is left.
    function dockRemove(tree, cardId) {
        if (!tree) return null;
        if (tree.cardId) return tree.cardId === cardId ? null : tree;
        const kept = tree.children.map((child, index) => [dockRemove(child, cardId), tree.sizes[index]]).filter(([child]) => child);
        if (!kept.length) return null;
        if (kept.length === 1) return kept[0][0];
        return dockFlatten({ orientation: tree.orientation, children: kept.map(([child]) => child), sizes: shares(kept.map(([, size]) => size)) });
    }
    // `tree` after moving the divider behind child `index` of the split at `path`, as `moveSplitDivider`.
    function dockResize(tree, path, index, delta, room, min = 0) {
        const visit = (node, depth) => (depth === path.length
            ? { ...node, sizes: moveSplitDivider(node.sizes, index, delta, room, min) }
            : { ...node, children: node.children.map((child, at) => (at === path[depth] ? visit(child, depth + 1) : child)) });
        return tree && !tree.cardId ? visit(tree, 0) : tree;
    }
    // The side of `rect` that `point` is nearest to, relative to the rectangle's size.
    function dropSide(rect, point) {
        const distances = {
            left: (point.x - rect.x) / rect.w, right: (rect.x + rect.w - point.x) / rect.w,
            top: (point.y - rect.y) / rect.h, bottom: (rect.y + rect.h - point.y) / rect.h
        };
        return Object.keys(distances).reduce((best, side) => (distances[side] < distances[best] ? side : best));
    }
    // A dock as stored: `{ width, layout }`, with `width` its share of the room beside the canvas, from
    // 0.05 to 0.95, and every terminal of `cardIds` at most once. Returns a copy, or null when invalid.
    function validDock(dock, cardIds) {
        const allowed = new Set(cardIds), seen = new Set();
        const node = (value, depth) => {
            if (!value || typeof value !== 'object') return null;
            if ('cardId' in value) return allowed.has(value.cardId) && !seen.has(value.cardId) && seen.add(value.cardId) ? { cardId: value.cardId } : null;
            const { orientation, children, sizes } = value;
            // `depth` splits enclose this one.
            if (depth >= DOCK_DEPTH || !['row', 'column'].includes(orientation) || !Array.isArray(children) || children.length < 2 || !Array.isArray(sizes)
                || sizes.length !== children.length || !sizes.every(size => typeof size === 'number' && size > 0 && size <= 1)) return null;
            const nodes = children.map(child => node(child, depth + 1));
            return nodes.every(Boolean) ? { orientation, children: nodes, sizes: [...sizes] } : null;
        };
        const width = dock?.width, layout = typeof width === 'number' && width >= .05 && width <= .95 ? node(dock.layout, 0) : null;
        return layout ? { width, layout } : null;
    }
    const geometry = {
        center, rectFromPoints, containsPoint, containsRect, intersects, clipToBounds, resolveLine, boundsOfPoints, unionBounds,
        outerGroup, expandGroups, selectionUnits, groupPaths, ungroupPaths, pruneGroupPaths, frameContents, marquee, topmostAt,
        placeBeside, placeNear, nearestInDirection, nearestToPoint, revealCamera, splitLayout, moveSplitDivider,
        DOCK_DEPTH, dockLeaves, dockDepth, dockFlatten, dockLayout, dockInsert, dockRemove, dockResize, dropSide, validDock
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = geometry;
    else root.TerminalCanvasGeometry = geometry;
})(typeof window === 'undefined' ? globalThis : window);
