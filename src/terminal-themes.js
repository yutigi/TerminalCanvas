/* Complete xterm palettes. Current preserves the original theme, including its subdued black.
   Theme IDs are shared with host validation through item-styles.js and its Rust parity test. */
(function (root) {
    'use strict';
    const themes = Object.freeze({
        current: Object.freeze({
            background: '#15191f', foreground: '#c8d1dc', cursor: '#c8ecb5', selectionBackground: '#52694e80',
            black: '#29313d', red: '#e59a91', green: '#b5d69a', yellow: '#dfc68c', blue: '#94b5e8', magenta: '#baa0da', cyan: '#91cbc7', white: '#d5dce5',
            brightBlack: '#667486', brightRed: '#f0b2a9', brightGreen: '#c8ecb5', brightYellow: '#f1dbab', brightBlue: '#b2cdff', brightMagenta: '#d8bcf6', brightCyan: '#b1e4df', brightWhite: '#f0f4fa'
        }),
        midnight: Object.freeze({
            background: '#101827', foreground: '#dae4f2', cursor: '#b7d5ff', cursorAccent: '#101827', selectionBackground: '#334d73', selectionForeground: '#ffffff',
            black: '#7c899e', red: '#ff9eaa', green: '#9ddbb1', yellow: '#efcf90', blue: '#9fc5ff', magenta: '#d4b3ff', cyan: '#8fd9e5', white: '#d6dfec',
            brightBlack: '#94a3b8', brightRed: '#ffb9c2', brightGreen: '#b8ebc7', brightYellow: '#ffe2a7', brightBlue: '#bdd8ff', brightMagenta: '#e6ceff', brightCyan: '#b3edf5', brightWhite: '#f4f7ff'
        }),
        paper: Object.freeze({
            background: '#faf7f0', foreground: '#252c36', cursor: '#174b83', cursorAccent: '#faf7f0', selectionBackground: '#c6d9ee', selectionForeground: '#252c36',
            black: '#27313e', red: '#a02e39', green: '#286139', yellow: '#725311', blue: '#245791', magenta: '#78418d', cyan: '#21616b', white: '#525c69',
            brightBlack: '#5a626e', brightRed: '#ad3241', brightGreen: '#316c40', brightYellow: '#795818', brightBlue: '#2b60a0', brightMagenta: '#874a9b', brightCyan: '#286b75', brightWhite: '#495464'
        })
    });
    if (typeof module !== 'undefined' && module.exports) module.exports = themes;
    else root.TerminalCanvasThemes = themes;
})(typeof window === 'undefined' ? globalThis : window);
