const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspace, createCard, validateWorkspace, validateCard, LIMITS } = require('../src/workspace.cjs');

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
    assert.throws(() => validateWorkspace({ ...board, version: 2 }), /Unsupported/);
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
