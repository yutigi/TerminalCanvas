/* Shared geometry for the renderer and dependency-free tests. */
(function (root) {
    'use strict';
    function layout(cards, camera, viewport, width, height) {
        const visible = { x: -camera.x / camera.z, y: -camera.y / camera.z, w: viewport.width / camera.z, h: viewport.height / camera.z };
        const left = Math.min(visible.x, ...cards.map(card => card.x));
        const top = Math.min(visible.y, ...cards.map(card => card.y));
        const right = Math.max(visible.x + visible.w, ...cards.map(card => card.x + card.w));
        const bottom = Math.max(visible.y + visible.h, ...cards.map(card => card.y + card.h));
        const scale = Math.min((width - 20) / Math.max(1, right - left), (height - 20) / Math.max(1, bottom - top));
        const offsetX = (width - (right - left) * scale) / 2 - left * scale;
        const offsetY = (height - (bottom - top) * scale) / 2 - top * scale;
        const project = rect => ({ x: rect.x * scale + offsetX, y: rect.y * scale + offsetY, w: rect.w * scale, h: rect.h * scale });
        return { scale, offsetX, offsetY, viewport: project(visible), cards: cards.map(card => ({ id: card.id, ...project(card) })) };
    }
    function cameraAtPoint(point, map, viewport, z) {
        return {
            x: Math.max(-100000, Math.min(100000, viewport.width / 2 - (point.x - map.offsetX) / map.scale * z)),
            y: Math.max(-100000, Math.min(100000, viewport.height / 2 - (point.y - map.offsetY) / map.scale * z)), z
        };
    }
    const geometry = { layout, cameraAtPoint };
    if (typeof module !== 'undefined' && module.exports) module.exports = geometry;
    else root.TerminalCanvasMinimap = geometry;
})(typeof window === 'undefined' ? globalThis : window);
