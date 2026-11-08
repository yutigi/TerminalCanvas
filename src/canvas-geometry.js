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
    const geometry = {
        center, rectFromPoints, containsPoint, containsRect, intersects, clipToBounds, resolveLine, boundsOfPoints, unionBounds,
        outerGroup, expandGroups, selectionUnits, groupPaths, ungroupPaths, pruneGroupPaths, frameContents, marquee, topmostAt
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = geometry;
    else root.TerminalCanvasGeometry = geometry;
})(typeof window === 'undefined' ? globalThis : window);
