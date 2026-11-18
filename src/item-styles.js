/* Item style palettes, terminal theme IDs, the group nesting limit, and terminal text sizes, shared by the
   renderer and the desktop host's workspace validation so the two can never disagree. An absent
   `color` or `fontSize` is the default. A terminal card's `fontSize` is in whole CSS pixels. */
(function (root) {
    'use strict';
    const styles = Object.freeze({
        COLORS: Object.freeze(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']),
        FONT_SIZES: Object.freeze(['small', 'large', 'huge']),
        COLORED_TYPES: Object.freeze(['text', 'note', 'shape', 'frame', 'line', 'terminal']),
        TERMINAL_THEMES: Object.freeze(['current', 'midnight', 'paper']),
        TEXT_TYPES: Object.freeze(['text', 'note', 'shape']),
        GROUP_DEPTH: 8,
        TERMINAL_FONT_SIZE: Object.freeze({ MIN: 8, DEFAULT: 12, MAX: 32 })
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = styles;
    else root.TerminalCanvasItemStyles = styles;
})(typeof window === 'undefined' ? globalThis : window);
