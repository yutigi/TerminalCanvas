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

// A 3 x 2 grid of 660 x 430 cards, 40 px apart.
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

// Arrange: cards `{ id, x, y, w, h }`, links `{ from, to }`. Results are `{ id, x, y }` in card order.
const GAP = G.ARRANGE_GAP;
const card = (id, w = 660, h = 430, x = 0, y = 0) => ({ id, x, y, w, h });
const links = pairs => pairs.map(([from, to]) => ({ from, to }));
const arranged = (cards, list = [], obstacles = []) => {
    const placed = G.arrangeCards(cards, list, obstacles);
    return { placed, at: id => placed.find(p => p.id === id) };
};
const noOverlaps = (cards, placed) => {
    const boxes = placed.map((p, i) => ({ id: p.id, x: p.x, y: p.y, w: cards[i].w, h: cards[i].h }));
    for (const a of boxes) for (const b of boxes) if (a !== b) assert.equal(G.intersects(a, b), false, `${a.id} overlaps ${b.id}`);
};
// Arranges, then arranges the result again, which must change nothing.
const rerun = (cards, list, obstacles = []) => {
    const first = G.arrangeCards(cards, list, obstacles);
    const moved = cards.map((c, i) => ({ ...c, x: first[i].x, y: first[i].y }));
    assert.deepEqual(G.arrangeCards(moved, list, obstacles), first, 'arranging the result again changes nothing');
    return first;
};

test('a chain of mixed sizes reads left to right on one row, keeping the top-left corner', () => {
    const cards = [card('c', 500, 300, 900, 900), card('a', 660, 430, 120, 80), card('b', 800, 600, 400, 2000)];
    const { placed, at } = arranged(cards, links([['a', 'b'], ['b', 'c']]));
    assert.deepEqual(placed.map(p => p.id), ['c', 'a', 'b'], 'results follow card order');
    assert.deepEqual(at('a'), { id: 'a', x: 120, y: 80 });
    assert.deepEqual(at('b'), { id: 'b', x: 120 + 660 + GAP.column, y: 80 });
    assert.deepEqual(at('c'), { id: 'c', x: 120 + 660 + GAP.column + 800 + GAP.column, y: 80 });
    noOverlaps(cards, placed);
});

test('branches stack below the first branch in card order, and a merge lands right of both parents', () => {
    // a -> b, a -> c, b -> d, c -> d, c -> e: a diamond with an extra branch from c.
    const cards = ['a', 'b', 'c', 'd', 'e'].map(id => card(id, 400, id === 'b' ? 500 : 300));
    const { placed, at } = arranged(cards, links([['c', 'e'], ['a', 'c'], ['b', 'd'], ['a', 'b'], ['c', 'd']]));
    const column = n => n * (400 + GAP.column);
    assert.deepEqual(at('a'), { id: 'a', x: column(0), y: 0 });
    assert.deepEqual(at('b'), { id: 'b', x: column(1), y: 0 }, 'the first branch continues the row');
    assert.deepEqual(at('d'), { id: 'd', x: column(2), y: 0 }, 'd is reached first through b and sits right of both parents');
    assert.deepEqual(at('c'), { id: 'c', x: column(1), y: 500 + GAP.branch }, 'the second branch starts below the first');
    assert.deepEqual(at('e'), { id: 'e', x: column(2), y: 500 + GAP.branch });
    noOverlaps(cards, placed);
});

test('cycles and self-links are laid out once, from the first card of a cycle with no way in', () => {
    const cards = ['b', 'a', 'c'].map(id => card(id, 300, 200));
    const list = links([['a', 'b'], ['b', 'c'], ['c', 'a'], ['a', 'a'], ['c', 'c']]);
    const { at } = arranged(cards, list);
    const column = n => n * (300 + GAP.column);
    assert.deepEqual([at('b'), at('c'), at('a')].map(p => [p.x, p.y]), [[column(0), 0], [column(1), 0], [column(2), 0]],
        'b is first in card order, then c, and a closes the cycle');
    // A flow that enters a cycle starts from its source instead.
    const entered = arranged([...cards, card('s', 300, 200)], [...list, { from: 's', to: 'a' }]);
    assert.deepEqual(['s', 'a', 'b', 'c'].map(id => entered.at(id).x), [0, 1, 2, 3].map(column));
    assert.deepEqual(arranged([card('x', 300, 200, 5, 5)], links([['x', 'x']])).at('x'), { id: 'x', x: 5, y: 5 },
        'a self-link alone leaves the card unconnected');
    rerun(cards, list);
});

test('separate flows stack in order of their first card, with unconnected cards in a grid below', () => {
    const cards = [card('loose1', 300, 200), card('f2a', 500, 250), card('f1a', 400, 300), card('loose2', 600, 100),
        card('f1b', 400, 350), card('f2b', 450, 250), card('loose3', 200, 400), card('loose4', 300, 150)];
    const list = links([['f1a', 'f1b'], ['f2a', 'f2b']]);
    const { placed, at } = arranged(cards, list);
    assert.deepEqual(at('f2a'), { id: 'f2a', x: 0, y: 0 }, 'f2a comes first in card order');
    assert.deepEqual(at('f2b'), { id: 'f2b', x: 500 + GAP.column, y: 0 });
    const second = 250 + GAP.section;
    assert.deepEqual(at('f1a'), { id: 'f1a', x: 0, y: second });
    assert.deepEqual(at('f1b'), { id: 'f1b', x: 400 + GAP.column, y: second });
    // Two columns as wide as their widest card, and two rows as tall as their tallest card.
    const grid = second + 350 + GAP.section, left = 300 + GAP.grid, lower = grid + 200 + GAP.grid;
    assert.deepEqual(['loose1', 'loose2', 'loose3', 'loose4'].map(id => [at(id).x, at(id).y]),
        [[0, grid], [left, grid], [0, lower], [left, lower]]);
    noOverlaps(cards, placed);
    rerun(cards, list);
});

test('without connectors Arrange is a grid in card order', () => {
    // Columns are as wide as their widest card (a and c), rows as tall as their tallest (a and b).
    const cards = [card('a', 660, 430, 50, 60), card('b', 300, 800, -400, 900), card('c', 900, 200, 10, 10)];
    assert.deepEqual(G.arrangeCards(cards), [{ id: 'a', x: -400, y: 10 }, { id: 'b', x: -400 + 900 + GAP.grid, y: 10 },
        { id: 'c', x: -400, y: 10 + 800 + GAP.grid }]);
    assert.deepEqual(G.arrangeCards([], links([['a', 'b']])), []);
});

test('Arrange ignores link order, links to other items, and duplicate links', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id, i) => card(id, 300 + i * 50, 200 + i * 40));
    const list = links([['a', 'b'], ['a', 'c'], ['c', 'd'], ['b', 'd']]);
    const expected = G.arrangeCards(cards, list);
    assert.deepEqual(G.arrangeCards(cards, [...list].reverse()), expected);
    assert.deepEqual(G.arrangeCards(cards, [...list, ...list, { from: 'a', to: 'gone' }, { from: 'note', to: 'b' }]), expected);
});

test('mixed sizes never overlap and repeated runs are stable, from any starting corner', () => {
    // A deterministic pseudo-random board: sizes, positions, and links vary, including cycles and self-links.
    let seed = 7;
    const next = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 40; round++) {
        const cards = Array.from({ length: 3 + next(14) }, (_, i) => card(`t${i}`, 280 + next(900), 180 + next(700),
            next(5000) - 2500 + .5, next(5000) - 2500 + .25));
        const list = Array.from({ length: next(cards.length * 2) }, () => ({ from: `t${next(cards.length)}`, to: `t${next(cards.length)}` }));
        const placed = rerun(cards, list);
        noOverlaps(cards, placed);
        assert.deepEqual([Math.min(...placed.map(p => p.x)), Math.min(...placed.map(p => p.y))],
            [Math.round(Math.min(...cards.map(c => c.x))), Math.round(Math.min(...cards.map(c => c.y)))]);
    }
});

test('the arranged cards move down clear of other items and stay there on the next run', () => {
    const cards = [card('a', 400, 300, 100, 100), card('b', 400, 300, 2000, 100), card('c', 400, 300, 0, 0)];
    const list = links([['a', 'b']]);
    // A note inside the flow's row, and a label below it where c would land after the first move.
    const note = { x: 700, y: 150, w: 200, h: 200 }, label = { x: 0, y: 900, w: 100, h: 20.5 };
    const placed = rerun(cards, list, [note, label]);
    for (const [i, p] of placed.entries()) for (const item of [note, label]) {
        const padded = { x: item.x - GAP.clear, y: item.y - GAP.clear, w: item.w + GAP.clear * 2, h: item.h + GAP.clear * 2 };
        assert.equal(G.intersects({ ...p, w: cards[i].w, h: cards[i].h }, padded), false, `${p.id} covers an item`);
    }
    assert.equal(Math.min(...placed.map(p => p.x)), 0, 'the layout keeps its left edge');
    assert.ok(Number.isInteger(Math.min(...placed.map(p => p.y))), 'the moved corner stays on whole pixels');
    assert.deepEqual(G.arrangeCards(cards, list, [{ x: 5000, y: 5000, w: 10, h: 10 }]), G.arrangeCards(cards, list),
        'an item away from the cards changes nothing');
});
