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
    // Snapping. Rectangles, `threshold` (a fixed screen distance divided by the zoom), and `grid`
    // (0 for none) are in world units. Each axis snaps on its own: to the nearest target line within
    // `threshold`, otherwise to the grid. A rectangle's lines on an axis are its two edges and its
    // middle; edges snap to edges and middles to middles. A tie goes to the smaller move, then the
    // move toward lower coordinates, so the order of `targets` never matters.
    const SNAP_AXES = { x: { start: 'x', size: 'w', across: 'y', depth: 'h' }, y: { start: 'y', size: 'h', across: 'x', depth: 'w' } };
    const SNAP_EPSILON = 1e-6;
    const snapLines = (r, axis) => { const { start, size } = SNAP_AXES[axis]; return [r[start], r[start] + r[size] / 2, r[start] + r[size]]; };
    const closer = (offset, best) => !best || Math.abs(offset) < Math.abs(best.offset) || (Math.abs(offset) === Math.abs(best.offset) && offset < best.offset);
    // Adding zero turns a rounded -0 into 0.
    const toGrid = (value, grid) => Math.round(value / grid) * grid + 0;
    // Where a moved rectangle lands: `{ x, y, guides }`.
    function snapMove(rect, targets, { threshold = 0, grid = 0 } = {}) {
        const result = { ...rect };
        for (const axis of ['x', 'y']) {
            const { start, size } = SNAP_AXES[axis], own = snapLines(rect, axis);
            let best = null;
            for (const target of targets) {
                snapLines(target, axis).forEach((line, j) => own.forEach((mine, i) => {
                    const offset = line - mine;
                    if ((i === 1) === (j === 1) && Math.abs(offset) <= threshold && closer(offset, best)) best = { offset, line, i };
                }));
            }
            if (best) result[start] = best.line - best.i * rect[size] / 2;
            else if (grid > 0) result[start] = toGrid(rect[start], grid);
        }
        return { x: result.x, y: result.y, guides: snapGuides(result, targets) };
    }
    // The size a rectangle resized from its bottom-right corner snaps to: `{ w, h, guides }`. Its right
    // and bottom edges snap to target edges, and its width and height to target sizes, on the listed
    // `axes`. A size outside `min`..`max` is never chosen; the caller still clamps the result.
    // `gap` places the markers that show a matched size, beside the two rectangles' edges.
    function snapResize(rect, targets, { threshold = 0, grid = 0, axes = ['x', 'y'], min = {}, max = {}, gap = 0 } = {}) {
        const result = { ...rect };
        for (const axis of axes) {
            const { start, size } = SNAP_AXES[axis];
            const fits = value => value >= (min[size] ?? 0) && value <= (max[size] ?? Infinity);
            let best = null;
            const consider = value => {
                const offset = value - rect[size];
                if (fits(value) && Math.abs(offset) <= threshold && closer(offset, best)) best = { offset, value };
            };
            for (const target of targets) {
                consider(target[start] - rect[start]);
                consider(target[start] + target[size] - rect[start]);
                consider(target[size]);
            }
            if (best) result[size] = best.value;
            else if (grid > 0) {
                const end = rect[start] + rect[size];
                const sizes = [toGrid(end, grid), Math.floor(end / grid) * grid, Math.ceil(end / grid) * grid].map(line => line - rect[start]).filter(fits);
                if (sizes.length) result[size] = sizes.reduce((a, b) => (Math.abs(b - rect[size]) < Math.abs(a - rect[size]) ? b : a));
            }
        }
        return { w: result.w, h: result.h, guides: snapGuides(result, targets, { sizes: axes, gap }) };
    }
    // The guides for `rect` where it now lies: `{ x1, y1, x2, y2 }` segments, one along each line it
    // shares with a target, spanning both. For each axis in `sizes`, the nearest target of the same
    // width (x) or height (y) gets a marker beside its top or left edge, and so does `rect`; markers
    // carry `size: true`.
    function snapGuides(rect, targets, { sizes = [], gap = 0 } = {}) {
        const guides = [];
        for (const axis of ['x', 'y']) {
            const { across, depth } = SNAP_AXES[axis], own = snapLines(rect, axis), spans = new Map();
            for (const target of targets) {
                snapLines(target, axis).forEach((line, j) => own.forEach((mine, i) => {
                    if ((i === 1) !== (j === 1) || Math.abs(line - mine) > SNAP_EPSILON) return;
                    const [from, to] = spans.get(mine) || [rect[across], rect[across] + rect[depth]];
                    spans.set(mine, [Math.min(from, target[across]), Math.max(to, target[across] + target[depth])]);
                }));
            }
            for (const [at, [from, to]] of [...spans].sort((a, b) => a[0] - b[0])) {
                guides.push(axis === 'x' ? { x1: at, y1: from, x2: at, y2: to } : { x1: from, y1: at, x2: to, y2: at });
            }
        }
        const c = center(rect), distance = b => Math.hypot(center(b).x - c.x, center(b).y - c.y);
        const nearer = (a, b) => distance(b) < distance(a) || (distance(b) === distance(a) && (b.y - a.y || b.x - a.x) < 0);
        for (const axis of sizes) {
            const { size } = SNAP_AXES[axis];
            const same = targets.filter(target => Math.abs(target[size] - rect[size]) <= SNAP_EPSILON);
            if (!same.length) continue;
            for (const r of [rect, same.reduce((a, b) => (nearer(a, b) ? b : a))]) {
                guides.push(axis === 'x' ? { x1: r.x, y1: r.y - gap, x2: r.x + r.w, y2: r.y - gap, size: true }
                    : { x1: r.x - gap, y1: r.y, x2: r.x - gap, y2: r.y + r.h, size: true });
            }
        }
        return guides;
    }
    const geometry = {
        center, rectFromPoints, containsPoint, containsRect, intersects, clipToBounds, resolveLine, boundsOfPoints, unionBounds,
        outerGroup, expandGroups, selectionUnits, groupPaths, ungroupPaths, pruneGroupPaths, frameContents, marquee, topmostAt,
        placeBeside, placeNear, nearestInDirection, nearestToPoint, revealCamera, snapMove, snapResize, snapGuides
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = geometry;
    else root.TerminalCanvasGeometry = geometry;
})(typeof window === 'undefined' ? globalThis : window);
