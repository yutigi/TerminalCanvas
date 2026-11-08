/* Item style palettes and the group nesting limit, shared by the renderer and the desktop host's
   workspace validation so the two can never disagree. An absent `color` or `fontSize` is the default. */
(function (root) {
    'use strict';
    const styles = Object.freeze({
        COLORS: Object.freeze(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']),
        FONT_SIZES: Object.freeze(['small', 'large', 'huge']),
        COLORED_TYPES: Object.freeze(['text', 'note', 'shape', 'frame', 'line']),
        TEXT_TYPES: Object.freeze(['text', 'note', 'shape']),
        GROUP_DEPTH: 8
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = styles;
    else root.TerminalCanvasItemStyles = styles;
})(typeof window === 'undefined' ? globalThis : window);
