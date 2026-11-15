const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/canvas-geometry.js');

const near = (actual, expected) => {
    for (const axis of ['x', 'y']) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-9, `${axis}: ${actual[axis]} != ${expected[axis]}`);
};

test('connectors leave rectangles and ellipses at their borders, or the center when the target is inside', () => {
    const box = { x: 0, y: 0, w: 200, h: 100 };
    near(G.clipToBounds(box, { x: 500, y: 50 }), { x: 200, y: 50 });
    near(G.clipToBounds(box, { x: 100, y: -400 }), { x: 100, y: 0 });
    near(G.clipToBounds(box, { x: 120, y: 60 }), { x: 100, y: 50 });
    const circle = { x: 0, y: 0, w: 100, h: 100 };
    near(G.clipToBounds(circle, { x: 50 + 300, y: 50 + 300 }, true), { x: 50 + 50 / Math.SQRT2, y: 50 + 50 / Math.SQRT2 });
    near(G.clipToBounds({ x: 0, y: 0, w: 0, h: 50 }, { x: 10, y: 10 }), { x: 0, y: 25 });
});

test('lines resolve free points and attached elements', () => {
    const shapes = { a: { bounds: { x: 0, y: 0, w: 100, h: 100 } }, b: { bounds: { x: 300, y: 0, w: 100, h: 100 }, ellipse: true } };
    const lookup = id => shapes[id] || null;
    const both = G.resolveLine({ start: { id: 'a' }, end: { id: 'b' } }, lookup);
    near(both.start, { x: 100, y: 50 });
    near(both.end, { x: 300, y: 50 });
    const free = G.resolveLine({ start: { x: -5, y: 7 }, end: { id: 'a' } }, lookup);
    near(free.start, { x: -5, y: 7 });
    near(free.end, G.clipToBounds(shapes.a.bounds, { x: -5, y: 7 }));
    assert.equal(free.end.x, 0, 'attached end sits on the border facing the free point');
});

test('nested groups select as their outermost group and unwrap one level at a time', () => {
    const elements = [{ id: 'a', groups: ['outer', 'inner'] }, { id: 'b', groups: ['outer', 'inner'] }, { id: 'c', groups: ['outer'] }, { id: 'd' }];
    assert.deepEqual([...G.expandGroups(new Set(['a']), elements)].sort(), ['a', 'b', 'c'], 'an inner member selects the whole outer group');
    assert.deepEqual([...G.selectionUnits(elements)].sort(), ['element:d', 'outer']);
    assert.deepEqual(G.groupPaths(elements, 'top'), [['top', 'outer', 'inner'], ['top', 'outer', 'inner'], ['top', 'outer'], ['top']]);
    assert.deepEqual(G.ungroupPaths(elements), [['inner'], ['inner'], [], []]);
    const afterUngroup = elements.map((e, i) => ({ ...e, groups: G.ungroupPaths(elements)[i] }));
    assert.deepEqual([...G.expandGroups(new Set(['a']), afterUngroup)].sort(), ['a', 'b'], 'the inner group survives');
    assert.deepEqual(G.pruneGroupPaths([{ id: 'a', groups: ['g', 'solo'] }, { id: 'b', groups: ['g'] }, { id: 'c', groups: ['lonely'] }]), [['g'], ['g'], []]);
    const wrapper = [{ id: 'a', groups: ['outer', 'inner'] }, { id: 'b', groups: ['outer', 'inner'] }];
    assert.deepEqual(G.pruneGroupPaths(wrapper), [['inner'], ['inner']], 'a group that only wraps one inner group is removed');
    const chain = [{ id: 'a', groups: ['x', 'y', 'z'] }, { id: 'b', groups: ['x', 'y', 'z'] }, { id: 'c', groups: ['x'] }];
    assert.deepEqual(G.pruneGroupPaths(chain), [['x', 'z'], ['x', 'z'], ['x']], 'a redundant middle level is removed');
});

test('groups expand to every member and leave ungrouped elements alone', () => {
    const elements = [{ id: 'a', groups: ['g1'] }, { id: 'b', groups: ['g1'] }, { id: 'c' }, { id: 'd', groups: ['g2'] }];
    assert.deepEqual([...G.expandGroups(new Set(['a']), elements)].sort(), ['a', 'b']);
    assert.deepEqual([...G.expandGroups(new Set(['c']), elements)], ['c']);
    assert.deepEqual([...G.expandGroups(new Set(['b', 'd']), elements)].sort(), ['a', 'b', 'd']);
});

test('frames contain fully enclosed elements, including nested frames, but not overlapping ones', () => {
    const frame = { id: 'frame', bounds: { x: 0, y: 0, w: 500, h: 400 } };
    const elements = [
        frame,
        { id: 'inner-frame', bounds: { x: 20, y: 20, w: 200, h: 200 } },
        { id: 'nested-note', bounds: { x: 40, y: 40, w: 50, h: 50 } },
        { id: 'edge', bounds: { x: 450, y: 10, w: 100, h: 50 } },
        { id: 'outside', bounds: { x: 900, y: 0, w: 10, h: 10 } }
    ];
    assert.deepEqual(G.frameContents(frame, elements), ['inner-frame', 'nested-note']);
    assert.deepEqual(G.marquee({ x: 30, y: 30, w: 100, h: 100 }, elements), ['nested-note']);
});

test('hit testing prefers the highest element and normalizes dragged rectangles', () => {
    const elements = [{ id: 'frame', z: -500, bounds: { x: 0, y: 0, w: 500, h: 500 } }, { id: 'note', z: 3, bounds: { x: 10, y: 10, w: 50, h: 50 } }];
    assert.equal(G.topmostAt({ x: 20, y: 20 }, elements).id, 'note');
    assert.equal(G.topmostAt({ x: 200, y: 200 }, elements).id, 'frame');
    assert.equal(G.topmostAt({ x: 900, y: 900 }, elements), null);
    assert.deepEqual(G.rectFromPoints({ x: 10, y: 50 }, { x: -10, y: 20 }), { x: -10, y: 20, w: 20, h: 30 });
    assert.deepEqual(G.unionBounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: -5, y: 20, w: 5, h: 5 }]), { x: -5, y: 0, w: 15, h: 25 });
    assert.equal(G.unionBounds([]), null);
});

test('rectangles intersect only when they overlap', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    assert.equal(G.intersects(a, { x: 5, y: 5, w: 10, h: 10 }), true);
    assert.equal(G.intersects(a, { x: 10, y: 0, w: 5, h: 5 }), false, 'touching edges do not overlap');
    assert.equal(G.intersects(a, { x: -20, y: -20, w: 5, h: 5 }), false);
});

test('requested terminals open to the right of their parent, then in the next free spot', () => {
    const parent = { x: 0, y: 0, w: 660, h: 430 }, size = { w: 660, h: 430 };
    assert.deepEqual(G.placeBeside(parent, size, [parent]), { x: 740, y: 0 });
    const right = { x: 740, y: 0, w: 660, h: 430 };
    assert.deepEqual(G.placeBeside(parent, size, [parent, right]), { x: 740, y: 510 }, 'below the first sibling');
    const below = { x: 740, y: 510, w: 660, h: 430 };
    assert.deepEqual(G.placeBeside(parent, size, [parent, right, below]), { x: 740, y: -510 }, 'then above');
    const wall = { x: 700, y: -100000, w: 800, h: 200000 };
    assert.deepEqual(G.placeBeside(parent, size, [parent, wall]), { x: 0, y: 510 }, 'the row below when the column is full');
    const everywhere = { x: -100000, y: -100000, w: 200000, h: 200000 };
    assert.deepEqual(G.placeBeside(parent, size, [everywhere]), { x: 740, y: 0 }, 'beside the parent when nothing is free');
});

test('terminals requested from outside open centered in view, or in the nearest free grid cell', () => {
    const size = { w: 600, h: 400 }, center = { x: 1000, y: 500 };
    assert.deepEqual(G.placeNear(center, size, []), { x: 700, y: 300 });
    const middle = { x: 700, y: 300, w: 600, h: 400 };
    const spot = G.placeNear(center, size, [middle]);
    assert.equal(G.intersects({ ...spot, ...size }, middle), false);
    assert.equal(Math.max(Math.abs(spot.x - 700) / 680, Math.abs(spot.y - 300) / 480), 1, 'the first ring around the center');
    const everywhere = { x: -100000, y: -100000, w: 200000, h: 200000 };
    assert.deepEqual(G.placeNear(center, size, [everywhere]), { x: 700, y: 300 });
});
