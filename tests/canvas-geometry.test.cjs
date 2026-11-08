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

test('groups expand to every member and leave ungrouped elements alone', () => {
    const elements = [{ id: 'a', group: 'g1' }, { id: 'b', group: 'g1' }, { id: 'c' }, { id: 'd', group: 'g2' }];
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
