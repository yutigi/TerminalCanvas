const test = require('node:test');
const assert = require('node:assert/strict');
const { layout, cameraAtPoint } = require('../src/minimap.js');

test('minimap fits negative and distant cards plus the viewport at every supported zoom', () => {
    const cards = [{ id: 'left', x: -100000, y: -100000, w: 400, h: 280 }, { id: 'right', x: 100000, y: 100000, w: 2400, h: 1800 }];
    for (const z of [.35, 1, 1.5]) {
        const map = layout(cards, { x: 48, y: -120, z }, { width: 1100, height: 720 }, 198, 120);
        for (const rect of [...map.cards, map.viewport]) {
            assert.ok(rect.x >= 10 - 1e-8 && rect.y >= 10 - 1e-8);
            assert.ok(rect.x + rect.w <= 188 + 1e-8 && rect.y + rect.h <= 110 + 1e-8);
            assert.ok(rect.w > 0 && rect.h > 0);
        }
        assert.ok(Math.abs(map.cards[0].w / map.cards[0].h - 400 / 280) < 1e-8);
    }
});

test('minimap projection round trips the viewport center and centers navigation on a card', () => {
    const viewport = { width: 1100, height: 720 }, camera = { x: -1234, y: 987, z: .65 };
    const card = { id: 'terminal', x: -3000, y: 2400, w: 660, h: 430 };
    const map = layout([card], camera, viewport, 198, 120);
    const center = rect => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
    const restored = cameraAtPoint(center(map.viewport), map, viewport, camera.z);
    assert.ok(Math.abs(restored.x - camera.x) < 1e-8 && Math.abs(restored.y - camera.y) < 1e-8);
    const next = cameraAtPoint(center(map.cards[0]), map, viewport, camera.z);
    assert.ok(Math.abs((card.x + card.w / 2) * next.z + next.x - viewport.width / 2) < 1e-8);
    assert.ok(Math.abs((card.y + card.h / 2) * next.z + next.y - viewport.height / 2) < 1e-8);
});

test('empty and zero-size viewports produce finite minimap geometry', () => {
    for (const viewport of [{ width: 0, height: 0 }, { width: 1100, height: 720 }]) {
        const map = layout([], { x: 48, y: 48, z: 1 }, viewport, 198, 120);
        assert.ok(Number.isFinite(map.scale) && map.scale > 0);
        assert.ok(Object.values(map.viewport).every(Number.isFinite));
    }
});
