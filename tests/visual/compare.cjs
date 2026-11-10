const assert = require('node:assert/strict');

function compare(expected, actual, tolerance, { colors = true } = {}) {
    const failures = [];
    assert.deepEqual(Object.keys(actual.scenes).sort(), Object.keys(expected.scenes).sort(), 'Layout scenes');
    for (const [scene, before] of Object.entries(expected.scenes)) {
        const after = actual.scenes[scene];
        assert.equal(after.width, before.width, `${scene}: viewport width`);
        assert.equal(after.height, before.height, `${scene}: viewport height`);
        assert.deepEqual(Object.keys(after.elements).sort(), Object.keys(before.elements).sort(), `${scene}: visible controls`);
        for (const [selector, old] of Object.entries(before.elements)) {
            const current = after.elements[selector];
            const check = (a, b, field) => {
                if (a.some((value, index) => Math.abs(value - b[index]) > tolerance)) {
                    failures.push(`${scene} ${selector} ${field}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
                }
            };
            check(old.rect, current.rect, 'bounds');
            assert.equal(current.icons.length, old.icons.length, `${scene} ${selector}: icons`);
            old.icons.forEach((icon, index) => check(icon, current.icons[index], `icon ${index}`));
            if (colors && (old.background !== current.background || old.color !== current.color)) {
                failures.push(`${scene} ${selector}: control colors changed`);
            }
        }
    }
    return failures;
}

module.exports = { compare };
