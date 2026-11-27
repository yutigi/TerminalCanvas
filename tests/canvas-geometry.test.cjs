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

// A 3 x 2 grid as Arrange lays it out: 660 x 430 cards, 40 px apart.
const grid = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, bounds: { x: (i % 3) * 700, y: Math.floor(i / 3) * 470, w: 660, h: 430 } }));
const from = (list, id) => list.find(c => c.id === id).bounds;
const others = (list, id) => list.filter(c => c.id !== id);
const go = (list, id, direction) => G.nearestInDirection(from(list, id), direction, others(list, id));

test('directional navigation moves along rows and columns and stops at the edges', () => {
    assert.equal(go(grid, 'a', 'right'), 'b');
    assert.equal(go(grid, 'b', 'right'), 'c');
    assert.equal(go(grid, 'c', 'right'), null);
    assert.equal(go(grid, 'a', 'left'), null);
    assert.equal(go(grid, 'a', 'up'), null);
    assert.equal(go(grid, 'b', 'down'), 'e');
    assert.equal(go(grid, 'e', 'up'), 'b');
    assert.equal(go(grid, 'f', 'left'), 'e');
    assert.equal(G.nearestInDirection(from(grid, 'a'), 'sideways', others(grid, 'a')), null);
    assert.equal(G.nearestInDirection(null, 'right', grid), null);
    assert.equal(G.nearestInDirection(from(grid, 'a'), 'right', []), null);
});

test('a missing neighbor in the beam falls back to the nearest diagonal, never to one far off-axis', () => {
    // Only the diagonal is left to the right of `a`; it lies within 45 degrees (700 along, 470 across).
    const sparse = grid.filter(c => ['a', 'e', 'd'].includes(c.id));
    assert.equal(go(sparse, 'a', 'right'), 'e');
    // From `d`, `a` is straight up; the diagonal `e` is not up at all.
    assert.equal(go(sparse, 'd', 'up'), 'a');
    // A column with small offsets: the card below is never "right" of the one above.
    const column = [{ id: 'top', bounds: { x: 0, y: 0, w: 600, h: 400 } }, { id: 'below', bounds: { x: 30, y: 440, w: 600, h: 400 } }];
    assert.equal(go(column, 'top', 'right'), null);
    assert.equal(go(column, 'top', 'down'), 'below');
    // A nearby diagonal beats a beam card far away; the gap across counts double.
    const mixed = [{ id: 'o', bounds: { x: 0, y: 0, w: 100, h: 100 } }, { id: 'far', bounds: { x: 2000, y: 0, w: 100, h: 100 } }, { id: 'near', bounds: { x: 150, y: 120, w: 100, h: 100 } }];
    assert.equal(go(mixed, 'o', 'right'), 'near');
});

test('ties break by alignment, distance, then top-left and ID, independent of input order', () => {
    const origin = { id: 'o', bounds: { x: 0, y: 200, w: 100, h: 100 } };
    // Two cards at the same gap overlapping the beam: the one better aligned with the line of travel wins.
    const aligned = [origin, { id: 'high', bounds: { x: 200, y: 120, w: 100, h: 100 } }, { id: 'level', bounds: { x: 200, y: 210, w: 100, h: 100 } }];
    assert.equal(go(aligned, 'o', 'right'), 'level');
    // Mirror images above and below tie on every distance; the upper one wins either way round.
    const mirrored = [origin, { id: 'z-below', bounds: { x: 200, y: 260, w: 100, h: 100 } }, { id: 'z-above', bounds: { x: 200, y: 140, w: 100, h: 100 } }];
    assert.equal(go(mirrored, 'o', 'right'), 'z-above');
    assert.equal(G.nearestInDirection(origin.bounds, 'right', others(mirrored, 'o').reverse()), 'z-above');
    // Identical rectangles fall back to the ID.
    const same = { x: 200, y: 200, w: 100, h: 100 };
    const twins = [origin, { id: 'b', bounds: { ...same } }, { id: 'a', bounds: { ...same } }];
    assert.equal(go(twins, 'o', 'right'), 'a');
    assert.equal(G.nearestInDirection(origin.bounds, 'right', others(twins, 'o').reverse()), 'a');
});

test('oversized and overlapping cards stay reachable in both directions', () => {
    const cards = [
        { id: 'huge', bounds: { x: 0, y: 0, w: 2400, h: 1800 } },
        { id: 'inside', bounds: { x: 1800, y: 600, w: 400, h: 300 } },
        { id: 'beside', bounds: { x: 2500, y: 0, w: 660, h: 430 } }
    ];
    assert.equal(go(cards, 'huge', 'right'), 'inside');
    assert.equal(go(cards, 'inside', 'left'), 'huge');
    assert.equal(go(cards, 'inside', 'right'), 'beside');
    // The oversized card's edge is 100 px away and overlaps the beam; the small one is further and lower.
    assert.equal(go(cards, 'beside', 'left'), 'huge');
    assert.equal(go(cards, 'huge', 'down'), null);
});

test('cards with exactly the same center are ordered so each reaches the other', () => {
    // Concentric: the larger card's corner is nearer the top left, so it comes first.
    const nested = [{ id: 'outer', bounds: { x: -200, y: -200, w: 1060, h: 830 } }, { id: 'inner', bounds: { x: 0, y: 0, w: 660, h: 430 } }];
    const reach = (list, id, direction) => G.nearestInDirection(from(list, id), direction, others(list, id), id);
    assert.deepEqual(['left', 'up', 'right', 'down'].map(d => reach(nested, 'inner', d)), ['outer', 'outer', null, null]);
    assert.deepEqual(['left', 'up', 'right', 'down'].map(d => reach(nested, 'outer', d)), [null, null, 'inner', 'inner']);
    // Identical rectangles fall back to the ID of the card moved from.
    const same = { x: 100, y: 100, w: 400, h: 300 };
    const stacked = [{ id: 'a', bounds: { ...same } }, { id: 'b', bounds: { ...same } }];
    assert.equal(reach(stacked, 'a', 'right'), 'b');
    assert.equal(reach(stacked, 'a', 'left'), null);
    assert.equal(reach(stacked, 'b', 'left'), 'a');
    assert.equal(reach(stacked, 'b', 'down'), null);
    // A card on the same line but off to the side is not "ahead" when the centers differ.
    const level = [{ id: 'o', bounds: { x: 0, y: 0, w: 100, h: 100 } }, { id: 'side', bounds: { x: 0, y: 300, w: 100, h: 100 } }];
    assert.equal(reach(level, 'o', 'right'), null);
});

test('with nothing to move from, the card under or nearest the point is chosen deterministically', () => {
    assert.equal(G.nearestToPoint({ x: 1000, y: 200 }, grid), 'b');
    assert.equal(G.nearestToPoint({ x: -500, y: 2000 }, grid), 'd');
    // A point between two cards picks the nearer edge, then the top-left one on an exact tie.
    assert.equal(G.nearestToPoint({ x: 680, y: 200 }, grid), 'a');
    assert.equal(G.nearestToPoint({ x: 680, y: 200 }, [...grid].reverse()), 'a');
    assert.equal(G.nearestToPoint({ x: 0, y: 0 }, []), null);
});

test('revealing a card pans as little as possible, keeps zoom, and shows the header of oversized cards', () => {
    const view = { width: 1000, height: 700 }, inset = { left: 72, top: 24, right: 24, bottom: 88 };
    const card = { x: 0, y: 0, w: 400, h: 300 };
    // Already in view: nothing moves.
    assert.deepEqual(G.revealCamera({ x: 100, y: 100, z: 1 }, card, view, inset), { x: 100, y: 100, z: 1 });
    // Off to the right and below: its far edges come to the insets.
    assert.deepEqual(G.revealCamera({ x: 900, y: 600, z: 1 }, card, view, inset), { x: 1000 - 24 - 400, y: 700 - 88 - 300, z: 1 });
    // Off to the left and above at half zoom: its near edges come to the insets.
    assert.deepEqual(G.revealCamera({ x: -500, y: -500, z: .5 }, card, view, inset), { x: 72, y: 24, z: .5 });
    // Larger than the view: its top-left corner, with the header, is shown.
    const huge = { x: 1000, y: 1000, w: 2400, h: 1800 };
    assert.deepEqual(G.revealCamera({ x: 0, y: 0, z: 1 }, huge, view, inset), { x: 72 - 1000, y: 24 - 1000, z: 1 });
    assert.deepEqual(G.revealCamera({ x: 72 - 1000, y: 24 - 1000, z: 1 }, huge, view, inset), { x: 72 - 1000, y: 24 - 1000, z: 1 });
    // The camera stays inside the canvas bounds, and a tiny view ignores the insets.
    assert.deepEqual(G.revealCamera({ x: 0, y: 0, z: 1.5 }, { x: 100000, y: -100000, w: 400, h: 300 }, view, inset), { x: -100000, y: 100000, z: 1.5 });
    assert.deepEqual(G.revealCamera({ x: 500, y: 0, z: 1 }, card, { width: 50, height: 700 }, inset), { x: 0, y: 24, z: 1 });
});

test('revealing a card also clears the overlays over the canvas, moving as little as possible', () => {
    const view = { width: 1000, height: 700 }, inset = { left: 24, top: 24, right: 24, bottom: 24 };
    const minimap = { x: 740, y: 480, w: 260, h: 220 }, tools = { x: 0, y: 200, w: 70, h: 300 };
    const card = { x: 0, y: 0, w: 400, h: 300 };
    const onScreen = camera => ({ x: camera.x + card.x * camera.z, y: camera.y + card.y * camera.z, w: card.w * camera.z, h: card.h * camera.z });
    // Off to the lower right, the plain reveal would put it under the minimap; it stops just above it,
    // which moves less than stopping to its left.
    const lowerRight = G.revealCamera({ x: 900, y: 600, z: 1 }, card, view, inset, [minimap, tools]);
    assert.deepEqual(lowerRight, { x: 1000 - 24 - 400, y: 480 - 300, z: 1 });
    assert.equal(G.intersects(onScreen(lowerRight), minimap), false);
    // Already in view but partly under the minimap: it moves out from under it.
    assert.deepEqual(G.revealCamera({ x: 500, y: 300, z: 1 }, card, view, inset, [minimap]), { x: 500, y: 180, z: 1 });
    // Already clear: nothing moves.
    assert.deepEqual(G.revealCamera({ x: 200, y: 100, z: 1 }, card, view, inset, [minimap, tools]), { x: 200, y: 100, z: 1 });
    // Off to the left beside the left toolbar: it stops to the toolbar's right.
    assert.deepEqual(G.revealCamera({ x: -900, y: 250, z: 1 }, card, view, inset, [minimap, tools]), { x: 70, y: 250, z: 1 });
    // Too large to clear them all: it is shown within the insets alone, header first.
    const huge = { x: 0, y: 0, w: 2400, h: 1800 };
    assert.deepEqual(G.revealCamera({ x: 500, y: 500, z: 1 }, huge, view, inset, [minimap, tools]), { x: 24, y: 24, z: 1 });
});

test('clearing an overlay never pushes the card past the edge of a small view', () => {
    // The Windows CI window: going below the minimap leaves too little height, so stopping to its left wins
    // even though it moves farther.
    const view = { width: 786, height: 523 }, inset = { left: 24, top: 24, right: 24, bottom: 24 };
    const tools = { x: 0, y: 94, w: 77, h: 336 }, toolbar = { x: 205, y: 439, w: 375, h: 76 }, minimap = { x: 535, y: 260, w: 252, h: 194 };
    const card = { x: 2200, y: 0, w: 660, h: 430 };
    const camera = G.revealCamera({ x: 120, y: 60, z: .65 }, card, view, inset, [tools, toolbar, minimap]);
    const shown = { x: camera.x + card.x * camera.z, y: camera.y + card.y * camera.z, w: card.w * camera.z, h: card.h * camera.z };
    assert.equal(camera.z, .65);
    assert.ok(shown.x >= 0 && shown.y >= 0 && shown.x + shown.w <= view.width && shown.y + shown.h <= view.height, JSON.stringify(shown));
    for (const box of [tools, toolbar, minimap]) assert.equal(G.intersects(shown, box), false);
});

test('split panes share the room side by side or stacked, with gaps for the dividers', () => {
    const area = { x: 18, y: 60, w: 1010, h: 610 };
    assert.deepEqual(G.splitLayout(area, { orientation: 'row', sizes: [.5, .5] }, 10), {
        panes: [{ x: 18, y: 60, w: 500, h: 610 }, { x: 528, y: 60, w: 500, h: 610 }],
        dividers: [{ x: 518, y: 60, w: 10, h: 610 }]
    });
    // Shares are scaled to fill the room, whatever they add up to.
    const stacked = G.splitLayout(area, { orientation: 'column', sizes: [.5, .25, .25] }, 5);
    assert.deepEqual(stacked.panes.map(pane => [pane.y, pane.h]), [[60, 300], [365, 150], [520, 150]]);
    assert.deepEqual(stacked.dividers.map(divider => [divider.y, divider.h, divider.w]), [[360, 5, 1010], [515, 5, 1010]]);
    assert.deepEqual(G.splitLayout(area, { orientation: 'row', sizes: [.01, .01] }, 10).panes.map(pane => pane.w), [500, 500]);
});

test('moving a divider changes only its two panes, which keep a minimum size', () => {
    const near = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${actual} != ${expected}`));
    near(G.moveSplitDivider([.25, .25, .5], 0, 100, 1000), [.35, .15, .5]);
    near(G.moveSplitDivider([1, 1], 0, -100, 1000), [.4, .6], 'shares come back normalized');
    // Neither neighbour goes below `min` pixels, or 2% of the room when that is more.
    near(G.moveSplitDivider([.5, .5], 0, -900, 1000, 120), [.12, .88]);
    near(G.moveSplitDivider([.5, .5], 0, 9000, 10000, 120), [.98, .02]);
    // Two panes smaller together than twice the minimum share what they have equally.
    near(G.moveSplitDivider([.9, .06, .04], 1, 50, 1000, 120), [.9, .05, .05]);
    near(G.moveSplitDivider([.5, .5], 1, 50, 1000), [.5, .5], 'no divider after the last pane');
    near(G.moveSplitDivider([.5, .5], 0, 50, 0), [.5, .5], 'no room, no change');
});

const leaf = cardId => ({ cardId });
test('pinning builds nested splits: beside the whole dock, or sharing one pane\'s room', () => {
    let dock = null;
    for (const id of ['a', 'b', 'c']) dock = G.dockInsert(dock, id);
    assert.deepEqual(dock, { orientation: 'column', children: [leaf('a'), leaf('b'), leaf('c')], sizes: [1 / 3, 1 / 3, 1 / 3] });
    dock = G.dockInsert(dock, 'd', 'b', 'right');
    assert.deepEqual(dock.children[1], { orientation: 'row', children: [leaf('b'), leaf('d')], sizes: [.5, .5] });
    // Splitting a pane in its parent's direction adds a sibling instead of nesting.
    dock = G.dockInsert(dock, 'e', 'b', 'left');
    assert.deepEqual(dock.children[1], { orientation: 'row', children: [leaf('e'), leaf('b'), leaf('d')], sizes: [.25, .25, .5] });
    assert.equal(G.dockDepth(dock), 2);
    // Pinning a pinned terminal again moves it.
    dock = G.dockInsert(dock, 'a', 'd', 'top');
    assert.deepEqual(G.dockLeaves(dock), ['e', 'b', 'a', 'd', 'c']);
    assert.deepEqual(dock.sizes.map(size => Math.round(size * 1000) / 1000), [.5, .5]);
    assert.deepEqual(G.dockInsert(null, 'x', 'missing', 'left'), leaf('x'));
    assert.deepEqual(G.dockInsert(leaf('a'), 'b', null, 'right'), { orientation: 'row', children: [leaf('a'), leaf('b')], sizes: [.5, .5] });
    assert.deepEqual(G.dockInsert(leaf('a'), 'b', 'a', 'top'), { orientation: 'column', children: [leaf('b'), leaf('a')], sizes: [.5, .5] });
});

test('unpinning collapses splits and lets the rest share the room', () => {
    const dock = { orientation: 'row', sizes: [.2, .8], children: [leaf('a'), { orientation: 'column', sizes: [.5, .5], children: [leaf('b'), { orientation: 'row', sizes: [.5, .5], children: [leaf('c'), leaf('d')] }] }] };
    // Removing b leaves the row c|d in the outer row, so it joins it with its share of the room.
    assert.deepEqual(G.dockRemove(dock, 'b'), { orientation: 'row', children: [leaf('a'), leaf('c'), leaf('d')], sizes: [.2, .4, .4] });
    assert.deepEqual(G.dockRemove(dock, 'a'), dock.children[1]);
    assert.equal(G.dockRemove(leaf('a'), 'a'), null);
    assert.deepEqual(G.dockRemove(dock, 'missing'), G.dockFlatten(dock));
    assert.equal(G.dockRemove(null, 'a'), null);
});

test('the dock lays out every pane and divider, and a divider moves within its own split', () => {
    const dock = { orientation: 'column', sizes: [.5, .5], children: [leaf('a'), { orientation: 'row', sizes: [.5, .5], children: [leaf('b'), leaf('c')] }] };
    const { panes, dividers } = G.dockLayout(dock, { x: 8, y: 8, w: 408, h: 708 }, 8);
    assert.deepEqual(Object.fromEntries(panes), { a: { x: 8, y: 8, w: 408, h: 350 }, b: { x: 8, y: 366, w: 200, h: 350 }, c: { x: 216, y: 366, w: 200, h: 350 } });
    assert.deepEqual(dividers, [
        { rect: { x: 208, y: 366, w: 8, h: 350 }, path: [1], index: 0, orientation: 'row', room: 400 },
        { rect: { x: 8, y: 358, w: 408, h: 8 }, path: [], index: 0, orientation: 'column', room: 700 }
    ]);
    const resized = G.dockResize(dock, [1], 0, 100, 400);
    assert.deepEqual(resized.children[1].sizes, [.75, .25]);
    assert.deepEqual(resized.sizes, [.5, .5], 'other splits keep their shares');
    assert.deepEqual(G.dockResize(leaf('a'), [], 0, 10, 100), leaf('a'));
    assert.deepEqual(G.dockLayout(null, { x: 0, y: 0, w: 1, h: 1 }), { panes: new Map(), dividers: [] });
});

test('a drop lands on the side of a pane nearest the pointer, relative to its size', () => {
    const rect = { x: 0, y: 0, w: 400, h: 100 };
    assert.equal(G.dropSide(rect, { x: 10, y: 50 }), 'left');
    assert.equal(G.dropSide(rect, { x: 380, y: 50 }), 'right');
    assert.equal(G.dropSide(rect, { x: 200, y: 20 }), 'top');
    assert.equal(G.dropSide(rect, { x: 120, y: 80 }), 'bottom');
});

test('stored docks keep their shape only when every part is valid', () => {
    const ids = ['a', 'b', 'c'];
    const dock = { width: .35, layout: { orientation: 'row', children: [leaf('a'), leaf('b')], sizes: [1, .25] } };
    assert.deepEqual(G.validDock(dock, ids), dock);
    for (const broken of [
        { ...dock, width: .96 }, { ...dock, width: .04 }, { width: .3 }, { ...dock, layout: leaf('z') },
        { ...dock, layout: { ...dock.layout, children: [leaf('a'), leaf('a')] } },
        { ...dock, layout: { ...dock.layout, orientation: 'grid' } },
        { ...dock, layout: { ...dock.layout, children: [leaf('a')], sizes: [1] } },
        { ...dock, layout: { ...dock.layout, sizes: [0, 1] } }, { ...dock, layout: { ...dock.layout, sizes: [1.5, 1] } }, null
    ]) assert.equal(G.validDock(broken, ids), null, JSON.stringify(broken));
    const nest = depth => (depth ? { orientation: 'row', children: [leaf(`n${depth}`), nest(depth - 1)], sizes: [.5, .5] } : leaf('n0'));
    const many = Array.from({ length: G.DOCK_DEPTH + 2 }, (_, index) => `n${index}`);
    assert.ok(G.validDock({ width: .5, layout: nest(G.DOCK_DEPTH) }, many));
    assert.equal(G.validDock({ width: .5, layout: nest(G.DOCK_DEPTH + 1) }, many), null);
});
