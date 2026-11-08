const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, createCard, validateWorkspace, validateCard, validateItem, LIMITS } = require('../src/workspace.cjs');

test('workspace round trip preserves folders, commands, and geometry without runtime state', () => {
    const board = createWorkspace();
    board.cards.push({ ...createCard({ profile: 'custom', command: 'echo hello', cwd: process.cwd() }), pid: 123, output: 'private output' });
    const loaded = validateWorkspace(JSON.parse(JSON.stringify(board)));
    assert.equal(loaded.cards[0].command, 'echo hello');
    assert.equal(loaded.cards[0].cwd, process.cwd());
    assert.equal('pid' in loaded.cards[0], false);
    assert.equal('output' in loaded.cards[0], false);
});
test('AI profiles suggest commands and an explicit empty command launches only a shell', () => {
    assert.equal(createCard({ profile: 'claude' }).command, 'claude');
    assert.equal(createCard({ profile: 'codex', command: '' }).command, '');
    assert.equal(createCard().command, '');
});
test('rejects duplicate IDs, unknown plugins, and unsupported versions', () => {
    const board = createWorkspace(), card = createCard();
    assert.throws(() => validateWorkspace({ ...board, cards: [card, card] }), /Duplicate/);
    assert.throws(() => validateCard({ ...card, type: 'browser' }), /Unsupported/);
    assert.throws(() => validateWorkspace({ ...board, version: 3 }), /Unsupported/);
});
test('rejects non-finite, excessively large, and undersized geometry', () => {
    const card = createCard();
    for (const bad of [{ x: Infinity }, { y: NaN }, { w: 1 }, { h: 9000 }, { x: 100001 }]) assert.throws(() => validateCard({ ...card, ...bad }));
    for (const z of [0, 2, '1']) assert.throws(() => validateWorkspace({ ...createWorkspace(), camera: { x: 0, y: 0, z } }));
});
test('rejects control characters in launch commands and workspace metadata', () => {
    for (const command of ['echo one\recho two', 'echo a\nrm b', 'echo \x00']) assert.throws(() => createCard({ command }), /Invalid command/);
    assert.throws(() => createCard({ title: 'bad\ttitle' }), /Invalid title/);
});
test('caps terminal count and strips unexpected workspace properties', () => {
    const board = createWorkspace();
    board.cards = Array.from({ length: LIMITS.cards + 1 }, () => createCard());
    assert.throws(() => validateWorkspace(board), /too many/);
    assert.equal('plugins' in validateWorkspace({ ...createWorkspace(), plugins: [{ execute: 'arbitrary' }] }), false);
});

const board = (items, cards = []) => ({ ...createWorkspace(), cards, items });
const sampleItems = () => [
    { id: 'label', type: 'text', x: 0, y: 0, w: 220, h: 40, text: 'Plan\n\tnext step' },
    { id: 'note', type: 'note', x: 10, y: 10, w: 200, h: 200, text: 'Sticky', group: 'g-1' },
    { id: 'box', type: 'shape', shape: 'rect', x: 300, y: 0, w: 180, h: 110, text: '', group: 'g-1' },
    { id: 'ring', type: 'shape', shape: 'ellipse', x: 600, y: 0, w: 150, h: 150, text: 'Done' },
    { id: 'frame', type: 'frame', x: -50, y: -50, w: 1000, h: 600, title: 'Sprint' },
    { id: 'pic', type: 'image', x: 0, y: 300, w: 320, h: 240, asset: `${'a'.repeat(64)}.png` },
    { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'ring' }, arrow: true },
    { id: 'free', type: 'line', start: { x: 0, y: 0 }, end: { x: -40, y: 90 } }
];
test('version 1 workspaces migrate to version 2 with an empty item list', () => {
    const card = createCard();
    const migrated = validateWorkspace({ version: 1, name: 'Old', camera: { x: 0, y: 0, z: 1 }, cards: [card], items: [{ junk: true }] });
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.items, []);
    assert.equal(migrated.cards[0].id, card.id);
});
test('board items round trip with multiline text, groups, and connectors while dropping unknown fields', () => {
    const card = { ...createCard(), group: 'g-1' };
    const items = sampleItems().map(item => ({ ...item, html: '<b>x</b>' }));
    const loaded = validateWorkspace(JSON.parse(JSON.stringify(board(items, [card]))));
    assert.equal(loaded.items.length, items.length);
    assert.equal(loaded.items[0].text, 'Plan\n\tnext step');
    assert.equal(loaded.items[1].group, 'g-1');
    assert.equal(loaded.cards[0].group, 'g-1');
    assert.deepEqual(loaded.items[6], { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'ring' }, arrow: true });
    assert.equal(loaded.items[7].arrow, false);
    assert.equal(loaded.items.some(item => 'html' in item), false);
    const crlf = validateWorkspace(board([{ ...sampleItems()[1], text: 'a\r\nb' }]));
    assert.equal(crlf.items[0].text, 'a\nb');
});
test('rejects malformed items, unsafe asset names, and dangling connectors', () => {
    const [label, note, box, , frame, pic, wire] = sampleItems();
    const bad = [
        { ...label, type: 'browser' }, { ...label, text: 'bell\x07' }, { ...label, text: 'x'.repeat(LIMITS.text + 1) },
        { ...box, shape: 'triangle' }, { ...note, w: 4 }, { ...note, x: Infinity }, { ...frame, title: 'two\nlines' },
        { ...pic, asset: '../../secret.png' }, { ...pic, asset: `${'a'.repeat(64)}.svg` }, { ...note, group: 'bad group' },
        { ...wire, start: { x: 'a', y: 0 } }
    ];
    for (const item of bad) assert.throws(() => validateItem(item));
    assert.throws(() => validateWorkspace(board([note, wire])), /missing item/);
    assert.throws(() => validateWorkspace(board([note, { ...wire, end: { id: 'other-line' } }, { ...wire, id: 'other-line', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }])), /missing item/);
    const card = createCard();
    assert.throws(() => validateWorkspace(board([{ ...note, id: card.id }], [card])), /Duplicate/);
    assert.throws(() => validateWorkspace(board([note, note])), /Duplicate/);
    assert.throws(() => validateWorkspace(board(Array.from({ length: LIMITS.items + 1 }, (_, i) => ({ ...note, id: `n${i}` })))), /too many items/);
    assert.throws(() => validateWorkspace({ ...board([]), items: 'nope' }), /Invalid canvas items/);
});
test('connectors may attach to terminals', () => {
    const card = createCard();
    const loaded = validateWorkspace(board([{ id: 'wire', type: 'line', start: { id: card.id }, end: { x: 5, y: 5 } }], [card]));
    assert.deepEqual(loaded.items[0].start, { id: card.id });
});
