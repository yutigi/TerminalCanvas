/*
 * Maps mouse coordinates into scaled terminals before xterm.js reads them.
 *
 * The canvas zooms with a CSS `scale()` transform. xterm.js converts a mouse event to a cell by
 * subtracting the screen element's on-screen rectangle from `clientX`/`clientY` and dividing by
 * its unscaled cell size, so at any zoom other than 100% the selection and mouse reports drift
 * away from the pointer. Every xterm pointer calculation (selection, mouse reporting, links,
 * right-click) is relative to the `.xterm-screen` element, so rewriting the event coordinates
 * relative to that element's top-left corner gives xterm the unscaled offsets it expects.
 */
(function (root) {
    'use strict';
    const EVENTS = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'];
    const EPSILON = 1e-4;

    // Rendered size divided by layout size; 1 when either is unknown or the element is hidden.
    function scaleOf(rect, layoutWidth, layoutHeight) {
        const x = rect.width > 0 && layoutWidth > 0 ? rect.width / layoutWidth : 1;
        const y = rect.height > 0 && layoutHeight > 0 ? rect.height / layoutHeight : 1;
        return { x, y };
    }
    const isScaled = scale => Math.abs(scale.x - 1) > EPSILON || Math.abs(scale.y - 1) > EPSILON;

    // The client point whose offset from `rect`'s corner equals the unscaled offset of `point`.
    function unscalePoint(point, rect, scale) {
        return { x: rect.left + (point.x - rect.left) / scale.x, y: rect.top + (point.y - rect.top) / scale.y };
    }

    function install(win) {
        // The screen of the terminal where a button was pressed; drags keep mapping into it.
        let dragScreen = null;
        const screenFor = target => target?.closest?.('.xterm')?.querySelector('.xterm-screen') || null;
        function layoutSize(element) {
            const style = win.getComputedStyle(element);
            const width = parseFloat(style.width), height = parseFloat(style.height);
            return { width: width > 0 ? width : element.offsetWidth, height: height > 0 ? height : element.offsetHeight };
        }
        function correct(event) {
            if (event.type === 'mousedown') dragScreen = screenFor(event.target);
            else if (event.type === 'mousemove' && dragScreen && !event.buttons) dragScreen = null;
            const screen = dragScreen || screenFor(event.target);
            if (event.type === 'mouseup') dragScreen = null;
            if (!screen?.isConnected) return;
            const rect = screen.getBoundingClientRect(), size = layoutSize(screen);
            const scale = scaleOf(rect, size.width, size.height);
            if (!isScaled(scale)) return;
            const point = unscalePoint({ x: event.clientX, y: event.clientY }, rect, scale);
            for (const [name, value] of [['clientX', point.x], ['x', point.x], ['clientY', point.y], ['y', point.y]]) {
                Object.defineProperty(event, name, { value, configurable: true });
            }
        }
        // Window capture runs before xterm's element and document listeners.
        for (const type of EVENTS) win.addEventListener(type, correct, { capture: true, passive: true });
        return () => { for (const type of EVENTS) win.removeEventListener(type, correct, { capture: true }); dragScreen = null; };
    }

    const pointer = { scaleOf, isScaled, unscalePoint, install };
    if (typeof module !== 'undefined' && module.exports) module.exports = pointer;
    else root.TerminalCanvasPointer = pointer;
})(typeof window === 'undefined' ? globalThis : window);
