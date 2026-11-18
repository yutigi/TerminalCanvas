const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('./visual/compare.cjs');
const config = require('./visual/reference.json');
// Small fixtures isolate the switcher/account additions; canvas movement is covered separately below.
const intended = { common: { added: config.intended.common.added.filter(selector => selector === '#find-terminal[0]') }, card: config.intended.card };

const control = rect => ({ rect, background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', icons: [] });
const report = elements => ({ scenes: { '1000x680-card': { width: 1000, height: 680, elements } } });
const before = report({ '.card-title[0]': control([100, 20, 300, 14]), '.icon-button[0]': control([450, 15, 26, 26]) });

test('intended layout changes are accepted exactly as listed', () => {
    const after = report({
        '.card-title[0]': control([100, 20, 271, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
        '#find-terminal[0]': control([180, 100, 26, 26]),
    });
    assert.deepEqual(compare(before, after, 1.5, { intended }), []);
    // Without the listed changes, the same capture fails as before.
    assert.throws(() => compare(before, after, 1.5), /visible controls/);
});

test('changes beyond the listed ones still fail', () => {
    const wider = report({
        '.card-title[0]': control([100, 20, 300, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
        '#find-terminal[0]': control([180, 100, 26, 26]),
    });
    assert.match(compare(before, wider, 1.5, { intended }).join('\n'), /card-title\[0\] bounds/);
    const missing = report({ '.card-title[0]': control([100, 20, 271, 14]), '.icon-button[0]': control([450, 15, 26, 26]), '#find-terminal[0]': control([180, 100, 26, 26]) });
    assert.throws(() => compare(before, missing, 1.5, { intended }), /intended control \.card-account-icon\[0\] is missing/);
    const extra = report({
        '.card-title[0]': control([100, 20, 271, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
        '#find-terminal[0]': control([180, 100, 26, 26]),
        '.icon-button[1]': control([480, 15, 26, 26]),
    });
    assert.throws(() => compare(before, extra, 1.5, { intended }), /visible controls/);
});

test('every intended change gives its reason', () => {
    for (const [scene, change] of Object.entries(config.intended)) {
        assert.ok(scene === 'common' || config.scenes.includes(scene), scene);
        assert.ok(typeof change.reason === 'string' && change.reason.length > 20, scene);
    }
});

test('shared intended movement translates icons but preserves strict engine and extra-movement checks', () => {
    const original = report({ '#search[0]': { ...control([10, 30, 100, 26]), icons: [[12, 35, 13, 13]] } });
    const moved = report({
        '#search[0]': { ...control([10, 106, 100, 26]), icons: [[12, 111, 13, 13]] },
        '#canvas-add[0]': control([20, 50, 26, 26]),
    });
    const changes = { common: { added: ['#canvas-add[0]'], resized: { '#search[0]': [0, 76, 0, 0] } } };
    assert.deepEqual(compare(original, moved, 1.5, { intended: changes }), []);
    assert.throws(() => compare(original, moved, .5), /visible controls/, 'current engine comparisons remain strict');
    moved.scenes['1000x680-card'].elements['#search[0]'].icons[0][1] += 2;
    assert.match(compare(original, moved, 1.5, { intended: changes }).join('\n'), /icon 0/);
});

test('every scene requires Find terminal and still checks existing controls and engine parity', () => {
    for (const scene of config.scenes) {
        const key = `1000x680-${scene}`;
        const old = { scenes: { [key]: { width: 1000, height: 680, elements: { '#search[0]': control([48, 555, 135, 14]) } } } };
        const current = structuredClone(old);
        current.scenes[key].elements['#find-terminal[0]'] = control([180, 520, 26, 26]);
        if (scene === 'card') current.scenes[key].elements['.card-account-icon[0]'] = control([421, 15, 26, 26]);
        assert.deepEqual(compare(old, current, 1.5, { intended }), []);
        assert.throws(() => compare(old, old, 1.5, { intended }), /intended control .* is missing/);
        const moved = structuredClone(current); moved.scenes[key].elements['#search[0]'].rect[1] += 14;
        assert.match(compare(old, moved, 1.5, { intended }).join('\n'), /#search\[0\] bounds/);
        const webkit = structuredClone(current); webkit.scenes[key].elements['#find-terminal[0]'].rect[2] += 2;
        assert.match(compare(current, webkit, .5).join('\n'), /#find-terminal\[0\] bounds/);
    }
});
