const test = require('node:test');
const assert = require('node:assert/strict');
const themes = require('../src/terminal-themes.js');
const styles = require('../src/item-styles.js');
const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const rgb = hex => hex.slice(1, 7).match(/../g).map(part => parseInt(part, 16) / 255);
const luminance = hex => rgb(hex).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const blend = (a, b, weight) => '#' + rgb(a).map((v, i) => Math.round((v * weight + rgb(b)[i] * (1 - weight)) * 255).toString(16).padStart(2, '0')).join('');

test('every offered theme has a full palette and readable text, cursor, and ANSI colors', () => {
    assert.deepEqual(Object.keys(themes), styles.TERMINAL_THEMES);
    for (const [id, theme] of Object.entries(themes)) {
        for (const key of ['background', 'foreground', 'cursor', 'selectionBackground', ...ansi]) {
            assert.match(theme[key], /^#[0-9a-f]{6}([0-9a-f]{2})?$/i, `${id}.${key}`);
        }
        for (const key of ['foreground', 'cursor', ...ansi]) {
            // Preserve Current exactly: black and brightBlack are its original subdued colors.
            const minimum = id === 'current' && key === 'black' ? 1.3 : id === 'current' && key === 'brightBlack' ? 3.7 : 4.5;
            assert.ok(contrast(theme[key], theme.background) >= minimum, `${id}.${key}: ${contrast(theme[key], theme.background).toFixed(2)}`);
        }
        const selection = theme.selectionBackground.length === 9
            ? blend(theme.selectionBackground, theme.background, parseInt(theme.selectionBackground.slice(7), 16) / 255)
            : theme.selectionBackground;
        assert.ok(contrast(theme.selectionForeground || theme.foreground, selection) >= 4.5, `${id} selection`);
        if (theme.cursorAccent) assert.ok(contrast(theme.cursorAccent, theme.cursor) >= 4.5);
    }
});

test('titles and action/status colors remain legible on each tinted title bar', () => {
    const palette = ['#e59a91', '#e8b07a', '#dfc68c', '#b5d69a', '#94b5e8', '#baa0da', '#9ca3b1'];
    for (const color of palette) {
        const background = blend(color, '#242a32', .2);
        assert.ok(contrast('#f0f4fa', background) >= 4.5, color);
        assert.ok(contrast('#8d98a9', background) >= 3, `action icons on ${color}`);
        assert.ok(contrast('#c8d1dc', background) >= 4.5, `idle status on ${color}`);
        assert.ok(contrast('#c8ecb5', background) >= 4.5, `running status on ${color}`);
    }
});
