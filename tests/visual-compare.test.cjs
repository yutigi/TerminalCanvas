const test = require('node:test');
const assert = require('node:assert/strict');
const { compare } = require('./visual/compare.cjs');
const config = require('./visual/reference.json');
// Small fixtures isolate the switcher/account additions; canvas movement is covered separately below.
const intended = { common: { added: config.intended.common.added.filter(selector => selector === '#find-terminal[0]') }, card: config.intended.card, launch: config.intended.launch };

const control = rect => ({ rect, background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', icons: [] });
const report = elements => ({ scenes: { '1000x680-card': { width: 1000, height: 680, elements } } });
const before = report({ '.card-title[0]': control([100, 20, 300, 14]), '.icon-button[0]': control([450, 15, 26, 26]) });

test('intended layout changes are accepted exactly as listed', () => {
    const after = report({
        '.card-title[0]': control([100, 19, 271, 16]),
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
    const missing = report({ '.card-title[0]': control([100, 19, 271, 16]), '.icon-button[0]': control([450, 15, 26, 26]), '#find-terminal[0]': control([180, 100, 26, 26]) });
    assert.throws(() => compare(before, missing, 1.5, { intended }), /intended control \.card-account-icon\[0\] is missing/);
    const extra = report({
        '.card-title[0]': control([100, 19, 271, 16]),
        '.icon-button[0]': control([450, 15, 26, 26]),
        '.card-account-icon[0]': control([421, 15, 26, 26]),
        '#find-terminal[0]': control([180, 100, 26, 26]),
        '.icon-button[1]': control([480, 15, 26, 26]),
    });
    assert.throws(() => compare(before, extra, 1.5, { intended }), /visible controls/);
});

test('the automatic-title hint moves existing launch controls and their icons without masking other changes', () => {
    const launch = elements => ({ scenes: { '1000x680-launch': { width: 1000, height: 680, elements } } });
    const before = launch({
        '#launch-dialog[0]': control([260, 40, 480, 595]),
        '.dialog-heading[0]': { ...control([280, 60, 440, 40]), icons: [[290, 70, 21, 21]] },
        '.field-hint:not(#automatic-title-hint)[0]': control([280, 520, 440, 16]),
        '#save[0]': control([800, 10, 40, 30]),
    });
    const after = launch({
        '#launch-dialog[0]': control([260, 20, 480, 635]),
        '.dialog-heading[0]': { ...control([280, 40, 440, 40]), icons: [[290, 50, 21, 21]] },
        '.field-hint:not(#automatic-title-hint)[0]': control([280, 540, 440, 16]),
        '#automatic-title-hint[0]': control([280, 350, 440, 32]),
        '#find-terminal[0]': control([180, 100, 26, 26]),
        '#save[0]': control([800, 10, 40, 30]),
    });
    assert.deepEqual(compare(before, after, 1.5, { intended }), []);
    assert.throws(() => compare(before, after, 1.5), /visible controls/);
    const missing = structuredClone(after);
    delete missing.scenes['1000x680-launch'].elements['#automatic-title-hint[0]'];
    assert.throws(() => compare(before, missing, 1.5, { intended }), /intended control.*is missing/);
    for (const [selector, field, mutate, message] of [
        ['.dialog-heading[0]', 'icons', icons => { icons[0][1] += 4; }, /icon 0/],
        ['.dialog-heading[0]', 'icons', icons => { icons[0][2] += 4; }, /icon 0/],
        ['#launch-dialog[0]', 'rect', rect => { rect[3] += 4; }, /launch-dialog.*bounds/],
        ['#save[0]', 'rect', rect => { rect[0] += 4; }, /save.*bounds/],
    ]) {
        const drift = structuredClone(after);
        mutate(drift.scenes['1000x680-launch'].elements[selector][field]);
        assert.match(compare(before, drift, 1.5, { intended }).join('\n'), message);
    }
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
        if (scene === 'launch') current.scenes[key].elements['#automatic-title-hint[0]'] = control([280, 350, 440, 32]);
        if (scene === 'card') current.scenes[key].elements['.card-account-icon[0]'] = control([421, 15, 26, 26]);
        assert.deepEqual(compare(old, current, 1.5, { intended }), []);
        assert.throws(() => compare(old, old, 1.5, { intended }), /intended control .* is missing/);
        const moved = structuredClone(current); moved.scenes[key].elements['#search[0]'].rect[1] += 14;
        assert.match(compare(old, moved, 1.5, { intended }).join('\n'), /#search\[0\] bounds/);
        const webkit = structuredClone(current); webkit.scenes[key].elements['#find-terminal[0]'].rect[2] += 2;
        assert.match(compare(current, webkit, .5).join('\n'), /#find-terminal\[0\] bounds/);
    }
});


test('combined canvas and automatic-title controls are required in every scene', () => {
    for (const scene of config.scenes) {
        const key = `1000x680-${scene}`;
        const old = { scenes: { [key]: { width: 1000, height: 680, elements: { '#search[0]': control([48, 400, 135, 14]) } } } };
        const current = structuredClone(old);
        current.scenes[key].elements['#search[0]'].rect[1] += 76;
        const added = [...config.intended.common.added, ...(config.intended[scene]?.added || [])];
        for (const selector of added) current.scenes[key].elements[selector] = control([20, 50, 26, 26]);
        assert.deepEqual(compare(old, current, 1.5, { intended: config.intended }), []);
        for (const selector of added) {
            const missing = structuredClone(current);
            delete missing.scenes[key].elements[selector];
            assert.throws(() => compare(old, missing, 1.5, { intended: config.intended }), /intended control.*is missing/);
        }
        current.scenes[key].elements['#search[0]'].rect[1] += 4;
        assert.match(compare(old, current, 1.5, { intended: config.intended }).join('\n'), /search.*bounds/);
    }
});
