const assert = require('node:assert/strict');

// `intended` lists deliberate differences from `expected`, by scene name without its viewport
// (`card` covers `1000x680-card`): controls `added` since, and `resized` controls with the exact
// [x, y, width, height] change. Everything else must still match within `tolerance`.
function compare(expected, actual, tolerance, { colors = true, intended = {} } = {}) {
    const failures = [];
    assert.deepEqual(Object.keys(actual.scenes).sort(), Object.keys(expected.scenes).sort(), 'Layout scenes');
    for (const [scene, before] of Object.entries(expected.scenes)) {
        const after = actual.scenes[scene];
        const change = intended[scene.replace(/^\d+x\d+-/, '')] || {}, common = intended.common || {};
        const added = [...(common.added || []), ...(change.added || [])], resized = { ...common.resized, ...change.resized };
        assert.equal(after.width, before.width, `${scene}: viewport width`);
        assert.equal(after.height, before.height, `${scene}: viewport height`);
        for (const selector of added) assert.ok(after.elements[selector], `${scene}: intended control ${selector} is missing`);
        assert.deepEqual(Object.keys(after.elements).filter(key => !added.includes(key)).sort(), Object.keys(before.elements).sort(), `${scene}: visible controls`);
        for (const [selector, recorded] of Object.entries(before.elements)) {
            const delta = resized[selector];
            // A moved control carries its icons with it; their size and relative position still match.
            const old = delta ? { ...recorded,
                rect: recorded.rect.map((value, index) => value + delta[index]),
                icons: recorded.icons.map(icon => icon.map((value, index) => value + (index < 2 ? delta[index] : 0))),
            } : recorded;
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
