/* Assertions over actual browser styles and screenshot pixels, not the renderer's fake DOM. */
const close = (a, b) => a?.length === 4 && b?.length === 4 && a.every((value, index) => Math.abs(value - b[index]) <= 8);

function arrowPaintFailures(scene, name, { requirePath = true } = {}) {
    const failures = [], lines = scene.lines || [];
    if (lines.length !== 6) return [`${name}: missing connector/arrow fixtures`];
    if (lines.filter(line => line.selected).length !== 2) failures.push(`${name}: multi-selection was not restored`);
    for (const line of lines) {
        if (!line.arrow) {
            if (line.pathHead && line.headVisible) failures.push(`${name} ${line.id}: a plain line has a visible arrowhead`);
            continue;
        }
        if (!close(line.stroke, line.expected)) failures.push(`${name} ${line.id}: stroke lost its normal/colored/selected color`);
        if (line.strokeWidth !== 2) failures.push(`${name} ${line.id}: update arrow geometry with the stroke-width contract`);
        if (requirePath && !line.pathHead) failures.push(`${name} ${line.id}: direct arrowhead path is missing`);
        if (!line.headVisible || (line.pathHead && line.headFill === 'none')) failures.push(`${name} ${line.id}: arrowhead fill is hidden`);
        const pixel = scene.pixels?.find(pixel => pixel.id === line.id);
        if (!close(pixel?.rgba, line.expected)) {
            failures.push(`${name} ${line.id}: arrowhead pixel ${JSON.stringify(pixel?.rgba)} differs from ${JSON.stringify(line.expected)}`);
        }
    }
    return failures;
}

function reportArrowFailures(report, options) {
    return Object.entries(report.scenes).filter(([key]) => key.endsWith('-board'))
        .flatMap(([key, scene]) => arrowPaintFailures(scene, key, options));
}

function forcedColorsFailures(report) {
    const failures = [], scenes = Object.entries(report.forcedColors || {});
    if (!scenes.length) return ['Chromium forced-colors scenes are missing'];
    for (const [name, scene] of scenes) {
        if (!scene.forcedColorsActive) failures.push(`${name}: forced-colors emulation was not active`);
        failures.push(...arrowPaintFailures(scene, `${name} forced-colors`));
    }
    return failures;
}

module.exports = { arrowPaintFailures, reportArrowFailures, forcedColorsFailures };
