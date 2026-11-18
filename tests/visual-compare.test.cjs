const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('./visual/compare.cjs');
const config = require('./visual/reference.json');

const control = rect => ({ rect, background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', icons: [] });
const report = elements => ({ scenes: { '1000x680-card': { width: 1000, height: 680, elements } } });
const before = report({ '.card-title[0]': control([100, 20, 300, 14]), '.icon-button[0]': control([450, 15, 26, 26]) });

test('intended layout changes are accepted exactly as listed', () => {
    const after = report({
        '.card-title[0]': control([100, 20, 271, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
    });
    assert.deepEqual(compare(before, after, 1.5, { intended: config.intended }), []);
    // Without the listed changes, the same capture fails as before.
    assert.throws(() => compare(before, after, 1.5), /visible controls/);
});

test('changes beyond the listed ones still fail', () => {
    const wider = report({
        '.card-title[0]': control([100, 20, 300, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
    });
    assert.match(compare(before, wider, 1.5, { intended: config.intended }).join('\n'), /card-title\[0\] bounds/);
    const missing = report({ '.card-title[0]': control([100, 20, 271, 14]), '.icon-button[0]': control([450, 15, 26, 26]) });
    assert.throws(() => compare(before, missing, 1.5, { intended: config.intended }), /intended control \.card-account-icon\[0\] is missing/);
    const extra = report({
        '.card-title[0]': control([100, 20, 271, 14]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
        '.icon-button[1]': control([480, 15, 26, 26]),
    });
    assert.throws(() => compare(before, extra, 1.5, { intended: config.intended }), /visible controls/);
});

test('every intended change gives its reason', () => {
    for (const [scene, change] of Object.entries(config.intended)) {
        assert.ok(config.scenes.includes(scene), scene);
        assert.ok(typeof change.reason === 'string' && change.reason.length > 20, scene);
    }
});
