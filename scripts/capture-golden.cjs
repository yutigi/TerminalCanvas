/* Captures what the JavaScript host does today as golden fixtures for the Rust port
   (docs/rust-migration-plan.md, Phase 0). The Rust tests replay every fixture.

       node scripts/capture-golden.cjs           rewrite tests/golden/
       node scripts/capture-golden.cjs --check   fail if tests/golden/ is out of date

   Platform, home folder, and hostname are fixed below, so every machine writes the same files. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

// directoryReports() accepts OSC 7 hosts that match this machine's name.
const HOSTNAME = 'TC-Host';
os.hostname = () => HOSTNAME;
const HOME = { win32: 'C:\\Users\\tc', linux: '/home/tc', darwin: '/Users/tc' };

const workspace = require('../src/workspace.cjs');
const styles = require('../src/item-styles.js');
const { sessionMetadata, MetadataParser } = require('../src/session-metadata.cjs');
const { directoryReports, powershellArgs } = require('../src/terminal-cwd.cjs');
const assets = require('../src/assets.cjs');
const { prepareIntegration, powershellSource, bashSource } = require('../src/shell-integration.cjs');
const { recordSession } = require('../src/session-hook.cjs');
const { spawnSync } = require('node:child_process');
const { validateWorkspace, validateCard, validateItem } = workspace;

const root = path.resolve(__dirname, '..');
const goldenDir = path.join(root, 'tests', 'golden');
const outputs = new Map();
const json = (file, value) => outputs.set(file, JSON.stringify(compact(value), null, 2) + '\n');
// Large generated corpora: one case per line, so a behavior change still shows up as a one-line diff.
const jsonLines = (file, header, cases) => outputs.set(file, '{\n' + Object.entries(header).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(compact(value))},\n`).join('')
    + '"cases": [\n' + cases.map(entry => JSON.stringify(compact(entry))).join(',\n') + '\n]\n}\n');
const text = (file, value) => outputs.set(file, value);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function attempt(fn) {
    try { return { result: clone(fn()) }; } catch (error) { return { error: error.message }; }
}
// Seeded generator so generated corpora never change between runs.
function random(seed) {
    return () => {
        seed = seed + 0x6d2b79f5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
const pick = (next, list) => list[Math.floor(next() * list.length)];
const codePoints = value => [...value];

/* Fixtures stay small by storing long repetitive values in two encodings, which the Rust tests expand:
     { "$text": ["literal", ["unit", count], ...] }            a string of literal parts and repeated units
     { "$array": { "template": T, "count": n, "idPrefix": p } } n copies of T; with idPrefix, copy i gets id p + i */
function compactText(value) {
    const points = codePoints(value), parts = [];
    let literal = '';
    for (let i = 0; i < points.length;) {
        let best = null;
        for (let size = 1; size <= 3; size++) {
            const unit = points.slice(i, i + size).join('');
            let count = 1;
            while (points.slice(i + count * size, i + (count + 1) * size).join('') === unit) count++;
            if (count * size >= 64 && (!best || count * size > best.count * best.size)) best = { unit, size, count };
        }
        if (!best) { literal += points[i++]; continue; }
        if (literal) parts.push(literal);
        literal = '';
        parts.push([best.unit, best.count]);
        i += best.size * best.count;
    }
    if (literal) parts.push(literal);
    return parts;
}
function compact(value) {
    if (typeof value === 'string') {
        if (value.length < 256) return value;
        const parts = compactText(value);
        return parts.length === 1 && typeof parts[0] === 'string' ? value : { $text: parts };
    }
    if (Array.isArray(value)) {
        if (value.length >= 20) {
            const first = JSON.stringify(value[0]);
            if (value.every(element => JSON.stringify(element) === first)) return { $array: { template: compact(value[0]), count: value.length } };
            const prefix = typeof value[0]?.id === 'string' && value[0].id.endsWith('0') ? value[0].id.slice(0, -1) : null;
            const rest = element => { const { id: _, ...others } = element; return JSON.stringify(others); };
            if (prefix !== null && value.every((element, i) => element && typeof element === 'object' && element.id === `${prefix}${i}` && rest(element) === rest(value[0]))) {
                const { id: _, ...template } = value[0];
                return { $array: { template: compact(template), count: value.length, idPrefix: prefix } };
            }
        }
        return value.map(compact);
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compact(entry)]));
    return value;
}

const UUID = '12345678-1234-4321-9876-123456789abc';
const NEXT_UUID = 'abcdef01-1234-4321-9876-123456789abc';
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110';
const ASSET = `${'a'.repeat(64)}.png`;

/* ---------- Workspace validation ---------- */

function workspaceFixtures() {
    const card = (over = {}) => ({ id: 'card-1', type: 'terminal', profile: 'shell', title: 'Terminal', cwd: '/project', command: '', x: 0, y: 0, w: 660, h: 430, ...over });
    const items = {
        text: { id: 'label', type: 'text', x: 0, y: 0, w: 220, h: 40, text: 'Plan\n\tnext step' },
        note: { id: 'note', type: 'note', x: 10, y: 10, w: 200, h: 200, text: 'Sticky' },
        rect: { id: 'box', type: 'shape', shape: 'rect', x: 300, y: 0, w: 180, h: 110, text: '' },
        ellipse: { id: 'ring', type: 'shape', shape: 'ellipse', x: 600, y: 0, w: 150, h: 150, text: 'Done' },
        frame: { id: 'frame', type: 'frame', x: -50, y: -50, w: 1000, h: 600, title: 'Sprint' },
        image: { id: 'pic', type: 'image', x: 0, y: 300, w: 320, h: 240, asset: ASSET },
        wire: { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'ring' }, arrow: true },
        free: { id: 'free', type: 'line', start: { x: 0, y: 0 }, end: { x: -40, y: 90 } }
    };
    const board = (over = {}) => ({ version: 3, name: 'Board', camera: { x: 48, y: 48, z: 1 }, cards: [], items: [], ...over });
    const session = { provider: 'codex', sessionId: UUID, cwd: '/project' };
    const emoji = n => '🚀'.repeat(n);
    const cases = [];
    // Validate the JSON form, so the recorded input is exactly what ran.
    const add = (name, fn, raw, version) => {
        const input = clone(raw);
        const call = { validateWorkspace: () => validateWorkspace(input), validateCard: () => validateCard(input, version), validateItem: () => validateItem(input, version) }[fn];
        cases.push({ name, fn, ...(version === undefined ? {} : { version }), input: clone(input), ...attempt(call) });
    };

    // Cards: every field, every rejection, and the trimming rules.
    for (const version of [3, 2]) {
        const v = version === 3 ? '' : ' (format 2)';
        add(`card: minimal${v}`, 'validateCard', card(), version);
        add(`card: groups${v}`, 'validateCard', card({ groups: ['outer', 'inner'] }), version);
        add(`card: single group${v}`, 'validateCard', card({ group: 'pair' }), version);
        add(`card: null single group${v}`, 'validateCard', card({ group: null }), version);
        add(`card: numeric single group${v}`, 'validateCard', card({ group: 5 }), version);
        add(`card: empty single group${v}`, 'validateCard', card({ group: '' }), version);
        add(`card: both group fields${v}`, 'validateCard', card({ group: 'old', groups: ['new'] }), version);
    }
    for (const profile of workspace.PROFILES) add(`card: profile ${profile.id}`, 'validateCard', card({ profile: profile.id }));
    const cardVariants = [
        ['unknown profile', { profile: 'browser' }], ['profile case', { profile: 'Shell' }], ['missing profile', { profile: undefined }],
        ['type browser', { type: 'browser' }], ['missing type', { type: undefined }],
        ['missing id', { id: undefined }], ['empty id', { id: '' }], ['spaced id', { id: 'a b' }], ['padded id', { id: '  padded-id  ' }],
        ['underscore id', { id: 'a_b' }], ['unicode id', { id: 'ü' }], ['numeric id', { id: 5 }], ['80 character id', { id: 'i'.repeat(80) }],
        ['81 character id', { id: 'i'.repeat(81) }], ['id with tab', { id: 'a\tb' }],
        ['empty title', { title: '' }], ['blank title', { title: '   ' }], ['missing title', { title: undefined }], ['null title', { title: null }],
        ['numeric title', { title: 5 }], ['title with tab', { title: 'bad\ttitle' }], ['title with DEL', { title: 'del\x7f' }],
        ['title 100 units', { title: 't'.repeat(100) }], ['title 101 units', { title: 't'.repeat(101) }],
        ['title 50 emoji', { title: emoji(50) }], ['title 50 emoji and a letter', { title: emoji(50) + 'a' }],
        ['title 100 accented', { title: 'é'.repeat(100) }],
        ['title BOM trim', { title: '\uFEFF Title \uFEFF' }], ['title NEL is not trimmed', { title: '\u0085Title\u0085' }],
        ['title NBSP trim', { title: '\u00a0Title\u00a0' }], ['title line separator trim', { title: '\u2028Title\u2029' }],
        ['title ideographic space trim', { title: '\u3000Title\u3000' }], ['title Mongolian vowel separator is not trimmed', { title: '\u180eTitle\u180e' }],
        ['title only BOM', { title: '\uFEFF' }],
        ['empty cwd', { cwd: '' }], ['missing cwd', { cwd: undefined }], ['padded cwd', { cwd: '  /project  ' }],
        ['cwd 4096 units', { cwd: '/' + 'c'.repeat(4095) }], ['cwd 4097 units', { cwd: '/' + 'c'.repeat(4096) }], ['cwd with newline', { cwd: '/a\nb' }],
        ['command', { command: 'echo hello' }], ['missing command', { command: undefined }], ['command CR', { command: 'echo one\recho two' }],
        ['command LF', { command: 'echo a\nrm b' }], ['command NUL', { command: 'echo \x00' }],
        ['command 2000 units', { command: 'c'.repeat(2000) }], ['command 2001 units', { command: 'c'.repeat(2001) }],
        ['x limit', { x: 100000 }], ['x negative limit', { x: -100000 }], ['x beyond', { x: 100001 }], ['x string', { x: '1' }],
        ['x null', { x: null }], ['x missing', { x: undefined }], ['fractional position', { x: 1.5, y: -0.25 }], ['y beyond', { y: -100001 }],
        ['w 399', { w: 399 }], ['w 400', { w: 400 }], ['w 2400', { w: 2400 }], ['w 2401', { w: 2401 }],
        ['h 279', { h: 279 }], ['h 280', { h: 280 }], ['h 1800', { h: 1800 }], ['h 1801', { h: 1801 }], ['h string', { h: '430' }],
        ['empty groups', { groups: [] }], ['null groups', { groups: null }], ['string groups', { groups: 'g' }], ['duplicate groups', { groups: ['g', 'g'] }],
        ['8 groups', { groups: Array.from({ length: 8 }, (_, i) => `g${i}`) }], ['9 groups', { groups: Array.from({ length: 9 }, (_, i) => `g${i}`) }],
        ['spaced group', { groups: ['bad group'] }], ['padded group', { groups: [' g '] }], ['padded duplicate groups', { groups: ['g', ' g'] }],
        ['numeric group', { groups: [5] }], ['object groups', { groups: { 0: 'g' } }],
        ['session', { session }], ['session uppercase id', { session: { ...session, sessionId: UUID.toUpperCase() } }],
        ['session extra fields', { session: { ...session, token: 'secret', transcript: 'private' } }],
        ['session claude', { session: { ...session, provider: 'claude' } }], ['session null', { session: null }], ['session empty', { session: {} }],
        ['session unknown provider', { session: { ...session, provider: 'gemini' } }], ['session array id', { session: { ...session, sessionId: [UUID] } }],
        ['session command id', { session: { ...session, sessionId: '$(bad)' } }], ['session long id', { session: { ...session, sessionId: 'a'.repeat(200) } }],
        ['session id with trailing newline', { session: { ...session, sessionId: UUID + '\n' } }], ['session cwd newline', { session: { ...session, cwd: 'bad\npath' } }],
        ['session empty cwd', { session: { ...session, cwd: '' } }], ['session relative cwd', { session: { ...session, cwd: 'relative' } }],
        ['session cwd 4097 units', { session: { ...session, cwd: '/' + 's'.repeat(4096) } }], ['session string', { session: 'codex' }],
        ['runtime fields dropped', { pid: 123, output: 'private output', html: '<b>x</b>' }],
        ['type and id both wrong', { type: 'browser', id: undefined }], ['id and profile both wrong', { id: 'a b', profile: 'browser' }],
        ['title and size both wrong', { title: 5, w: 1 }], ['position and size both wrong', { x: 'a', w: 1 }], ['size and groups both wrong', { w: 1, groups: 'g' }]
    ];
    for (const [name, over] of cardVariants) add(`card: ${name}`, 'validateCard', card(over));
    for (const [name, value] of [['null', null], ['number', 5], ['string', 'terminal'], ['array', []], ['false', false]]) add(`card: ${name} input`, 'validateCard', value);

    // Items: each type, then each field.
    for (const [kind, item] of Object.entries(items)) {
        add(`item: ${kind}`, 'validateItem', item);
        add(`item: ${kind} grouped (format 2)`, 'validateItem', { ...item, group: 'pair' }, 2);
        add(`item: ${kind} styled`, 'validateItem', { ...item, color: 'blue', fontSize: 'huge' });
        add(`item: ${kind} default style`, 'validateItem', { ...item, color: 'default', fontSize: 'medium' });
        add(`item: ${kind} null style`, 'validateItem', { ...item, color: null, fontSize: null });
        add(`item: ${kind} unknown color`, 'validateItem', { ...item, color: 'chartreuse' });
        add(`item: ${kind} unknown size`, 'validateItem', { ...item, fontSize: '40px' });
        add(`item: ${kind} numeric color`, 'validateItem', { ...item, color: 3 });
        add(`item: ${kind} unknown color and size`, 'validateItem', { ...item, color: '#ff0000', fontSize: 'tiny' });
        add(`item: ${kind} padded id`, 'validateItem', { ...item, id: ' padded ' });
        add(`item: ${kind} unknown fields`, 'validateItem', { ...item, html: '<b>x</b>', z: 4 });
    }
    for (const color of styles.COLORS) add(`item: note color ${color}`, 'validateItem', { ...items.note, color });
    for (const size of styles.FONT_SIZES) add(`item: note size ${size}`, 'validateItem', { ...items.note, fontSize: size });
    const itemVariants = [
        ['unknown type', { ...items.text, type: 'browser' }], ['missing type', { ...items.text, type: undefined }], ['missing id', { ...items.text, id: undefined }],
        ['text bell', { ...items.text, text: 'bell\x07' }], ['text vertical tab', { ...items.text, text: 'a\x0bb' }], ['text DEL', { ...items.text, text: 'a\x7fb' }],
        ['text tab and newline', { ...items.text, text: 'a\tb\nc' }], ['text CRLF', { ...items.note, text: 'a\r\nb' }], ['text lone CR', { ...items.note, text: 'a\rb\r' }],
        ['text CR CR LF', { ...items.note, text: 'a\r\r\nb' }], ['text 10000 units', { ...items.text, text: 't'.repeat(10000) }],
        ['text 10001 units', { ...items.text, text: 't'.repeat(10001) }], ['text CRLF fits after normalizing', { ...items.text, text: 'a\r\n'.repeat(4000) }],
        ['text 5000 emoji', { ...items.text, text: emoji(5000) }], ['text 5000 emoji and a letter', { ...items.text, text: emoji(5000) + 'a' }],
        ['text missing', { ...items.text, text: undefined }], ['text null', { ...items.text, text: null }], ['note text number', { ...items.note, text: 5 }],
        ['text is not trimmed', { ...items.text, text: '  spaced  ' }],
        ['shape triangle', { ...items.rect, shape: 'triangle' }], ['shape missing', { ...items.rect, shape: undefined }], ['shape text missing', { ...items.rect, text: undefined }],
        ['shape text null', { ...items.rect, text: null }], ['shape and text both wrong', { ...items.rect, shape: 'star', text: null }],
        ['frame title newline', { ...items.frame, title: 'two\nlines' }], ['frame title missing', { ...items.frame, title: undefined }],
        ['frame title null', { ...items.frame, title: null }], ['frame title blank', { ...items.frame, title: '   ' }], ['frame title padded', { ...items.frame, title: ' Sprint ' }],
        ['frame title number', { ...items.frame, title: 7 }], ['frame title 101 units', { ...items.frame, title: 'f'.repeat(101) }],
        ['image traversal', { ...items.image, asset: '../../secret.png' }], ['image svg', { ...items.image, asset: `${'a'.repeat(64)}.svg` }],
        ['image uppercase hash', { ...items.image, asset: `${'A'.repeat(64)}.png` }], ['image short hash', { ...items.image, asset: `${'a'.repeat(63)}.png` }],
        ['image jpeg extension', { ...items.image, asset: `${'a'.repeat(64)}.jpeg` }], ['image jpg', { ...items.image, asset: `${'b'.repeat(64)}.jpg` }],
        ['image gif', { ...items.image, asset: `${'c'.repeat(64)}.gif` }], ['image webp', { ...items.image, asset: `${'d'.repeat(64)}.webp` }],
        ['image asset with newline', { ...items.image, asset: `${'a'.repeat(64)}.png\n` }], ['image missing asset', { ...items.image, asset: undefined }],
        ['image keeps no style', { ...items.image, color: 'chartreuse', fontSize: 'tiny' }],
        ['w 7', { ...items.note, w: 7 }], ['w 8', { ...items.note, w: 8 }], ['h 8000', { ...items.note, h: 8000 }], ['h 8001', { ...items.note, h: 8001 }],
        ['w string', { ...items.note, w: '200' }], ['x beyond', { ...items.note, x: 100001 }], ['y null', { ...items.note, y: null }],
        ['position and size both wrong', { ...items.note, x: null, w: 1 }],
        ['line endpoint point string', { ...items.wire, start: { x: 'a', y: 0 } }], ['line endpoint missing', { ...items.wire, start: undefined }],
        ['line endpoint null id', { ...items.wire, start: { id: null } }], ['line endpoint id and point', { ...items.wire, start: { id: 'note', x: 1, y: 2 } }],
        ['line endpoint extra fields', { ...items.free, start: { x: 1, y: 2, z: 3 } }], ['line endpoint array', { ...items.free, start: [1, 2] }],
        ['line endpoint padded id', { ...items.wire, end: { id: ' ring ' } }], ['line endpoint bad id', { ...items.wire, end: { id: 'a b' } }],
        ['line arrow string', { ...items.wire, arrow: 'true' }], ['line arrow one', { ...items.wire, arrow: 1 }], ['line arrow missing', { ...items.free }],
        ['line with geometry', { ...items.free, x: 5, y: 5, w: 'bad', h: null }], ['line font size ignored', { ...items.free, fontSize: 'tiny' }],
        ['line both endpoints wrong', { ...items.free, start: null, end: { id: 5 } }],
        ['groups', { ...items.note, groups: ['g-1'] }], ['bad group', { ...items.note, groups: ['bad group'] }], ['string groups', { ...items.note, groups: 'g-1' }],
        ['duplicate groups', { ...items.note, groups: ['g', 'g'] }], ['9 groups', { ...items.note, groups: Array.from({ length: 9 }, (_, i) => `g${i}`) }],
        ['empty groups', { ...items.note, groups: [] }], ['format 3 ignores single group', { ...items.note, group: 'pair' }],
        ['color before size before groups', { ...items.note, color: 'bad', fontSize: 'bad', groups: 'bad' }]
    ];
    for (const [name, item] of itemVariants) add(`item: ${name}`, 'validateItem', item);
    for (const [name, value] of [['null', null], ['number', 5], ['string', 'note'], ['array', []]]) add(`item: ${name} input`, 'validateItem', value);

    // Workspaces: formats, limits, references, nesting, and the order of checks.
    const all = Object.values(items);
    const c1 = card({ id: 'card-1' }), c2 = card({ id: 'card-2', x: 700 });
    const workspaceVariants = [
        ['empty', board()], ['created', workspace.createWorkspace()], ['every item type', board({ cards: [c1], items: all })],
        ['unknown properties', board({ plugins: [{ execute: 'arbitrary' }], assets: {}, theme: 'dark' })],
        ['format 1 ignores items', { ...board({ cards: [c1], items: [{ junk: true }] }), version: 1 }],
        ['format 1 ignores non-array items', { ...board({ items: 'nope' }), version: 1 }],
        ['format 1 groups', { ...board({ cards: [{ ...c1, group: 'pair' }] }), version: 1 }],
        ['format 2 groups', { ...board({ cards: [{ ...c1, group: 'pair' }], items: [{ ...items.note, group: 'pair' }] }), version: 2 }],
        ['format 2 without items', (({ items: _, ...rest }) => ({ ...rest, version: 2 }))(board())],
        ['format 3 null items', board({ items: null })], ['format 3 without items', (({ items: _, ...rest }) => rest)(board())],
        ['format 3 ignores single group', board({ items: [{ ...items.note, group: 'pair' }] })],
        ['format 4', board({ version: 4 })], ['format 0', board({ version: 0 })], ['format string', board({ version: '3' })], ['format missing', board({ version: undefined })],
        ['cards missing', board({ cards: undefined })], ['cards object', board({ cards: {} })],
        ['24 cards', board({ cards: Array.from({ length: 24 }, (_, i) => card({ id: `card-${i}` })) })],
        ['25 cards', board({ cards: Array.from({ length: 25 }, (_, i) => card({ id: `card-${i}` })) })],
        ['1000 items', board({ items: Array.from({ length: 1000 }, (_, i) => ({ ...items.note, id: `n${i}` })) })],
        ['1001 items', board({ items: Array.from({ length: 1001 }, (_, i) => ({ ...items.note, id: `n${i}` })) })],
        ['items string', board({ items: 'nope' })],
        ['camera missing', board({ camera: undefined })], ['camera null', board({ camera: null })], ['camera number', board({ camera: 5 })],
        ['camera z 0.35', board({ camera: { x: 0, y: 0, z: 0.35 } })], ['camera z 0.34', board({ camera: { x: 0, y: 0, z: 0.34 } })],
        ['camera z 1.5', board({ camera: { x: 0, y: 0, z: 1.5 } })], ['camera z 1.51', board({ camera: { x: 0, y: 0, z: 1.51 } })],
        ['camera z 0', board({ camera: { x: 0, y: 0, z: 0 } })], ['camera z 2', board({ camera: { x: 0, y: 0, z: 2 } })], ['camera z string', board({ camera: { x: 0, y: 0, z: '1' } })],
        ['camera x beyond', board({ camera: { x: 100001, y: 0, z: 1 } })], ['camera extra fields', board({ camera: { x: -5.5, y: 7, z: 1, w: 3 } })],
        ['name missing', board({ name: undefined })], ['name empty', board({ name: '' })], ['name blank', board({ name: '  ' })], ['name padded', board({ name: ' My board ' })],
        ['name 101 units', board({ name: 'n'.repeat(101) })], ['name newline', board({ name: 'a\nb' })], ['name number', board({ name: 5 })],
        ['duplicate cards', board({ cards: [c1, c1] })], ['duplicate items', board({ items: [items.note, items.note] })],
        ['item shares a card id', board({ cards: [c1], items: [{ ...items.note, id: 'card-1' }] })],
        ['padded ids collide', board({ items: [items.note, { ...items.text, id: ' note ' }] })],
        ['connector to a card', board({ cards: [c1], items: [{ id: 'wire', type: 'line', start: { id: 'card-1' }, end: { x: 5, y: 5 } }] })],
        ['connector to a missing item', board({ items: [items.note, items.wire] })],
        ['connector to a line', board({ items: [items.note, { ...items.wire, end: { id: 'free' } }, items.free] })],
        ['connector to itself', board({ items: [items.note, { ...items.wire, end: { id: 'wire' } }] })],
        ['connector to padded id', board({ items: [items.note, items.ellipse, { ...items.wire, start: { id: ' note ' } }] })],
        ['nested groups', board({ items: [{ ...items.text, groups: ['outer', 'inner'] }, { ...items.note, groups: ['outer', 'inner'] }, { ...items.rect, groups: ['outer'] }] })],
        ['inconsistent nesting', board({ items: [{ ...items.text, groups: ['outer', 'inner'] }, { ...items.note, groups: ['inner'] }] })],
        ['swapped nesting', board({ items: [{ ...items.text, groups: ['a', 'b'] }, { ...items.note, groups: ['b', 'a'] }] })],
        ['different parents', board({ items: [{ ...items.text, groups: ['a', 'b'] }, { ...items.note, groups: ['c', 'b'] }] })],
        ['nesting across cards and items', board({ cards: [{ ...c1, groups: ['outer', 'inner'] }], items: [{ ...items.note, groups: ['inner'] }] })],
        ['deep consistent nesting', board({ items: [{ ...items.text, groups: ['a', 'b', 'c'] }, { ...items.note, groups: ['a', 'b'] }, { ...items.rect, groups: ['a', 'b', 'c', 'd'] }] })],
        ['bad card before bad item', board({ cards: [card({ w: 1 })], items: [{ ...items.note, w: 1 }] })],
        ['duplicate cards before bad item', board({ cards: [c1, c1], items: [{ ...items.note, w: 1 }] })],
        ['bad item before duplicate items', board({ items: [items.note, items.note, { ...items.text, w: 1 }] })],
        ['duplicate items before missing connector', board({ items: [items.note, items.note, items.wire] })],
        ['missing connector before nesting', board({ items: [{ ...items.text, groups: ['a', 'b'] }, { ...items.note, groups: ['b'] }, items.wire] })],
        ['nesting before name', board({ name: 5, items: [{ ...items.text, groups: ['a', 'b'] }, { ...items.note, groups: ['b'] }] })],
        ['camera before cards', board({ camera: null, cards: [card({ w: 1 })] })], ['items before camera', board({ items: 'nope', camera: null })],
        ['two valid cards', board({ cards: [c1, c2] })]
    ];
    for (const [name, input] of workspaceVariants) add(`workspace: ${name}`, 'validateWorkspace', input);
    for (const [name, value] of [['null', null], ['number', 5], ['array', []], ['string', 'workspace']]) add(`workspace: ${name} input`, 'validateWorkspace', value);

    // Randomized mutations of one board, to pin down which check fails first.
    const base = board({
        name: 'Golden board', camera: { x: 48, y: -12.5, z: 1 },
        cards: [
            card({ id: 'card-a', profile: 'claude', title: 'Claude', command: 'claude', groups: ['g-outer'], session: { provider: 'claude', sessionId: UUID, cwd: '/project' } }),
            card({ id: 'card-b', title: 'Shell', cwd: 'C:\\work', x: 700 })
        ],
        items: [
            { ...items.text, y: 500, color: 'blue', fontSize: 'huge' }, { ...items.note, y: 600, groups: ['g-outer', 'g-inner'] },
            { ...items.rect, y: 600, groups: ['g-outer', 'g-inner'] }, { ...items.ellipse, y: 600, color: 'green' },
            { ...items.frame, y: 450, color: 'purple' }, { ...items.image, y: 900 },
            { ...items.wire, end: { id: 'card-b' }, color: 'red' }, items.free
        ]
    });
    const DELETE = { $delete: true };
    const pool = [
        DELETE, null, true, false, 0, -1, 0.5, 1, 2, 3, 4, 8, 400, 1800, 8000, 100000, 100001, -100001, 0.34, 0.35, 1.5, 1.51,
        '', ' ', '  padded  ', 'x', 'a b', 'card-a', 'card-b', 'note', 'wire', 'ring', 'free', 'g-outer', 'g-inner', '3',
        'text', 'shape', 'frame', 'image', 'line', 'terminal', 'rect', 'ellipse', 'triangle', 'red', 'chartreuse', 'default',
        'small', 'medium', 'huge', 'claude', 'codex', 'shell', 'Shell', '\t', 'tab\there', 'line\nbreak', 'cr\r\nlf', 'nul\u0000',
        'del\u007f', '\uFEFFbom\uFEFF', '\u0085nel', '\u00a0nbsp\u00a0', '子', '🚀'.repeat(50), '🚀'.repeat(51), 'a'.repeat(100), 'a'.repeat(101),
        'b'.repeat(81), [], ['g-outer'], ['g-inner'], ['g-outer', 'g-inner'], ['g-inner', 'g-outer'], ['dup', 'dup'], ['bad group'],
        [' padded '], [5], Array.from({ length: 9 }, (_, i) => `g${i}`), {}, { id: 'note' }, { id: 'missing' }, { id: 'free' }, { id: 'card-a' },
        { x: 1, y: 2 }, { x: 'a', y: 0 }, { provider: 'codex', sessionId: UUID.toUpperCase(), cwd: '/x' }, { provider: 'claude', sessionId: 'bad', cwd: '/x' },
        'C:\\work', '/project', `${'b'.repeat(64)}.png`, `${'b'.repeat(64)}.svg`, '../../secret.png', { x: 0, y: 0, z: 1 }
    ];
    const cardFields = ['id', 'type', 'profile', 'title', 'cwd', 'command', 'session', 'x', 'y', 'w', 'h', 'groups', 'group'];
    const itemFields = ['id', 'type', 'x', 'y', 'w', 'h', 'text', 'shape', 'title', 'asset', 'start', 'end', 'arrow', 'color', 'fontSize', 'groups', 'group'];
    const paths = [['version'], ['name'], ['camera'], ['camera', 'x'], ['camera', 'y'], ['camera', 'z'], ['cards'], ['items'],
        ['cards', 0, 'session', 'sessionId'], ['cards', 0, 'session', 'provider'], ['cards', 0, 'session', 'cwd'],
        ['items', 6, 'start', 'id'], ['items', 6, 'end', 'id'], ['items', 7, 'end', 'x'],
        ...[0, 1].flatMap(i => cardFields.map(f => ['cards', i, f])), ...[0, 1, 2, 3, 4, 5, 6, 7].flatMap(i => itemFields.map(f => ['items', i, f]))];
    function mutate(target, [keys, value]) {
        let node = target;
        for (const key of keys.slice(0, -1)) {
            if (!node || typeof node !== 'object') return;
            node = node[key];
        }
        if (!node || typeof node !== 'object' || Array.isArray(node)) return;
        if (value && value.$delete) delete node[keys.at(-1)];
        else node[keys.at(-1)] = clone(value);
    }
    const next = random(20261109);
    const mutations = [];
    for (let i = 0; i < 400; i++) {
        const changes = Array.from({ length: 1 + Math.floor(next() * 3) }, () => [pick(next, paths), pick(next, pool)]);
        const input = clone(base);
        for (const change of changes) mutate(input, change);
        mutations.push({ mutations: changes, ...attempt(() => validateWorkspace(input)) });
    }
    return {
        constants: {
            VERSION: workspace.VERSION, LIMITS: workspace.LIMITS, PROFILES: workspace.PROFILES, ITEM_TYPES: workspace.ITEM_TYPES,
            SHAPES: workspace.SHAPES, ITEM_SIZE: workspace.ITEM_SIZE, COLORS: styles.COLORS, FONT_SIZES: styles.FONT_SIZES,
            COLORED_TYPES: styles.COLORED_TYPES, TEXT_TYPES: styles.TEXT_TYPES, GROUP_DEPTH: styles.GROUP_DEPTH,
            createWorkspace: workspace.createWorkspace()
        },
        cases,
        mutations: { delete: DELETE, base, cases: mutations }
    };
}

/* ---------- Terminal metadata streams ---------- */

const osc = event => '\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07';
// Compares the recorded events with feeding the same stream whole, one code point at a time, and split once
// at every code point (about 1500 evenly spaced points in long streams). The Rust tests repeat the split
// checks only where the JavaScript code passes them.
function splitInvariant(run, chunks, expected) {
    const stream = chunks.join('');
    if (stream.length > 20000) return false;
    const points = codePoints(stream);
    const step = Math.max(1, Math.ceil(points.length / 1500));
    if (JSON.stringify(run([stream])) !== expected || JSON.stringify(run(points)) !== expected) return false;
    for (let split = 1; split < points.length; split += step) {
        if (JSON.stringify(run([points.slice(0, split).join(''), points.slice(split).join('')])) !== expected) return false;
    }
    return true;
}

function directoryFixtures() {
    const run = (platform, chunks) => {
        const events = [];
        const observe = directoryReports(platform, cwd => events.push({ type: 'cwd', cwd }), ready => events.push({ type: 'ready', ready }));
        for (const chunk of chunks) observe(chunk);
        return events;
    };
    const cases = [];
    const add = (name, platform, chunks) => {
        const events = run(platform, chunks);
        cases.push({ name, platform, chunks, events, splitInvariant: splitInvariant(variant => run(platform, variant), chunks, JSON.stringify(events)) });
    };
    for (const [end, label] of [['\x07', 'BEL'], ['\x1b\\', 'ST']]) add(`quoted Windows path, ${label}`, 'win32', ['hello\x1b]9;9;"C:\\some folder\\子"' + end + 'world']);
    add('unrelated, oversized, and invalid reports', 'win32', [
        'C:\\fake prompt> cd fake\r\n\x1b]0;title\x07', '\x1b]9;9;' + 'a'.repeat(50000), '\x07',
        '\x1b]9;9;relative\x07\x1b]9;9;\x07\x1b]9;9;C:\\bad\npath\x07', '\x1b]9;9;C:\\valid\x07'
    ]);
    add('OSC 7 decodes once', 'linux', ['\x1b]7;file://localhost/a%20folder/%25literal/%E5%AD%90\x07']);
    add('Windows drive and UNC paths', 'win32', ['\x1b]7;file:///C:/a%20folder/%25literal/%23name/%E5%AD%90\x07', '\x1b]7;file://server/share/a%20folder\x07']);
    add('Unix ignores remote hosts', 'linux', ['\x1b]7;file://remote.example/home/user\x07plain text', '\x1b]7;file:///local\x07']);
    for (const host of ['tc-host', 'TC-HOST', 'localhost', 'LOCALHOST']) add(`Windows UNC share on ${host}`, 'win32', [`\x1b]7;file://${host}/share/a%20folder/%25literal/%23name/%E5%AD%90\x07`]);
    add('Windows localhost drive and encoded separator', 'win32', ['\x1b]7;file://localhost/C:/a%20folder\x07', '\x1b]7;file://localhost/share/encoded%5cseparator\x07']);
    add('Unix accepts this machine', 'linux', ['\x1b]7;file://tc-host/a%20folder\x07']);
    add('macOS accepts this machine', 'darwin', ['\x1b]7;file://TC-Host/Users/tc\x07\x1b]7;file://elsewhere/Users/tc\x07']);
    add('readiness reports', 'win32', ['\x1b]777;tc-ready;0\x07\x1b]7;file:///C:/project\x07\x1b]777;tc-ready;1\x1b\\', '\x1b]777;tc-ready;2\x07']);
    add('readiness rejects extra text', 'win32', ['\x1b]777;tc-ready;1;\x07\x1b]777;tc-ready;\x07\x1b]777;TC-READY;1\x07\x1b]777;tc-ready;11\x07']);
    add('readiness on Unix', 'linux', ['\x1b]777;tc-ready;1\x07']);
    add('OSC restarts inside OSC', 'win32', ['\x1b]9;9;C:\\a\x1b]9;9;C:\\b\x07']);
    add('escape inside OSC cancels it', 'win32', ['\x1b]9;9;C:\\a\x1bX\x07\x1b]9;9;C:\\c\x07']);
    add('double escape before OSC', 'win32', ['\x1b\x1b]9;9;C:\\d\x07']);
    add('escape then text', 'win32', ['\x1bx]9;9;C:\\no\x07']);
    add('payload of exactly 16384 units', 'win32', ['\x1b]9;9;C:\\' + 'a'.repeat(16384 - 7) + '\x07']);
    add('payload of 16385 units overflows', 'win32', ['\x1b]9;9;C:\\' + 'a'.repeat(16385 - 7) + '\x07']);
    add('surrogate pair at 16383 units', 'win32', ['\x1b]9;9;C:\\' + 'a'.repeat(16383 - 7) + '🚀\x07']);
    add('surrogate pair at 16384 units', 'win32', ['\x1b]9;9;C:\\' + 'a'.repeat(16384 - 7) + '🚀\x07']);
    add('overflow resets for the next report', 'win32', ['\x1b]9;9;' + 'a'.repeat(20000) + '\x07\x1b]9;9;C:\\next\x07']);
    add('9;9 path of 4096 units', 'win32', ['\x1b]9;9;C:\\' + 'p'.repeat(4093) + '\x07', '\x1b]9;9;C:\\' + 'p'.repeat(4094) + '\x07']);
    add('9;9 path of 4096 emoji units', 'linux', ['\x1b]9;9;/' + '🚀'.repeat(2047) + 'x\x07', '\x1b]9;9;/' + '🚀'.repeat(2048) + '\x07']);

    // OSC 9;9 and OSC 7 payloads on each platform.
    const values = ['"C:\\x"', 'C:\\x', 'C:/x', '"', '""', '"C:\\x', 'C:\\x"', '/x', '"/x"', 'relative', 'C:', 'C:\\', 'c:x', '\\\\server\\share',
        '\\x', 'C:\\a\x7fb', 'C:\\a\tb', '/a\u0085b', '/' + '子'.repeat(3), ' C:\\x', 'C:\\x '];
    const ninenine = values.map(value => ({ value, win32: run('win32', [`\x1b]9;9;${value}\x07`]).map(e => e.cwd), linux: run('linux', [`\x1b]9;9;${value}\x07`]).map(e => e.cwd) }));
    const osc7 = fileUris().map(uri => ({ uri, win32: run('win32', [`\x1b]7;${uri}\x07`]).map(e => e.cwd), linux: run('linux', [`\x1b]7;${uri}\x07`]).map(e => e.cwd) }));
    return { hostname: HOSTNAME, home: HOME, cases, ninenine, osc7 };
}

function fileUris() {
    const hosts = ['', 'localhost', 'LOCALHOST', 'LocalHost', 'tc-host', 'TC-HOST', 'server', 'remote.example', 'xn--n3h.com', 'b\u00fccher.example',
        '127.0.0.1', '[::1]', 'localhost:80', 'user@localhost', 'a%20b', 'a b', '%6Cocalhost'];
    const paths = ['', '/', '/C:/', '/C:/a%20folder', '/c|/x', '/C|', '/C:', '/C', '/share/a%20folder', '/share/encoded%5cseparator', '/share/encoded%5Cseparator',
        '/a%2fb', '/a%2Fb', '/%E5%AD%90', '/%FF', '/%C0%AF', '/%ED%A0%80', '/a%', '/a%zz', '/a/../b', '/a/./b', '//double', '/a?query', '/a#frag', '/a%23b%3Fc',
        '/a b', '/a\tb', '/a\\b', '/tab%09x', '/nul%00x', '/del%7Fx', '/C:/%2e%2e/x', '/C:/a%20b/', '/D:\\x', '/%43:/x', '/~user', '/a:b', '/子/🚀'];
    const uris = [];
    for (const host of hosts) for (const p of paths) uris.push(`file://${host}${p}`);
    uris.push('file:/a', 'file:a', 'file:C:/x', 'file:///', 'FILE:///x', 'File://LocalHost/x', 'file://', 'file:', 'http://localhost/x', 'https://tc-host/x',
        'not a url', '', 'file:\\\\server\\share', 'file:///' + 'a'.repeat(4095), 'file:///' + 'a'.repeat(4096), 'file:///C:/' + 'a'.repeat(4093), 'file:///C:/' + 'a'.repeat(4094));
    return uris;
}

function parserFixtures() {
    const run = (options, chunks) => {
        const events = [];
        const parser = new MetadataParser({
            ...options,
            onChange: patch => events.push({ type: 'change', patch: clone(patch) }),
            onLaunch: event => events.push({ type: 'launch', event: clone(event) }),
            onEnd: event => events.push({ type: 'end', event: clone(event) }),
            onWarning: message => events.push({ type: 'warning', message })
        });
        for (const chunk of chunks) parser.feed(chunk);
        return { events, state: { cwd: parser.cwd, launch: clone(parser.launch) ?? null, bufferLength: parser.buffer.length, textLength: parser.text.length } };
    };
    const cases = [];
    const add = (name, options, chunks) => {
        const output = run(options, chunks);
        const events = JSON.stringify(output.events);
        cases.push({ name, options, chunks, ...output, splitInvariant: splitInvariant(variant => run(options, variant).events, chunks, events) });
    };
    const linux = { cwd: '/project', platform: 'linux', directories: true };
    const launch = (provider, token = TOKEN, extra = {}) => osc({ type: 'launch', provider, token, cwd: '/project', ...extra });
    add('stream order with character splits', { cwd: '/old', platform: 'linux', directories: true }, [
        '\x1b]7;file://localhost/new%20folder\x1b\\' + osc({ type: 'launch', provider: 'codex', token: TOKEN, cwd: '/new folder' })
        + `session id: \x1b[32m${UUID}\x1b[0m\n` + osc({ type: 'end', token: TOKEN, exitCode: 0 })
        + osc({ type: 'launch', provider: 'claude', token: NEXT_UUID, cwd: '/other', sessionId: NEXT_UUID }),
        'ordinary output\n'
    ]);
    add('output cannot replace a session without a launch', linux, [
        `a random UUID ${UUID}\n`, '\x1b]7;file://remote/private\x07', `Example: codex resume ${UUID}\nclaude --resume ${NEXT_UUID}\nsession id: ${UUID}\n`,
        `To continue this session, run codex resume ${UUID}\n`, osc({ type: 'launch', provider: 'claude', token: UUID, sessionId: UUID, cwd: '/project' }),
        `To continue this session, run codex resume ${NEXT_UUID}\nclaude --resume ${NEXT_UUID}\n`, '\x1b]633;TC;not-json\x07', 'x'.repeat(100000)
    ]);
    add('Codex headers only between its launch and end', linux, [
        osc({ type: 'end', exitCode: 1 }), osc({ type: 'launch', provider: 'codex', token: UUID, cwd: '/project' }),
        `Example: codex resume ${NEXT_UUID}\nThe docs say session id: ${NEXT_UUID}\nclaude --resume ${NEXT_UUID}\n`, `session id: ${UUID}\n`,
        osc({ type: 'end', token: NEXT_UUID, exitCode: 0 }), `To continue this session, run codex resume ${NEXT_UUID}\n`,
        osc({ type: 'end', token: UUID, exitCode: 0 }), `session id: ${UUID}\nTo continue this session, run codex resume ${UUID}\n`
    ]);
    add('warnings', linux, [
        osc({ type: 'warning', message: 'w'.repeat(512) }), osc({ type: 'warning', message: 'w'.repeat(513) }), osc({ type: 'warning', message: '🚀'.repeat(256) }),
        osc({ type: 'warning', message: '🚀'.repeat(256) + 'x' }), osc({ type: 'warning', message: 5 }), osc({ type: 'warning' }), osc({ type: 'warning', message: '' })
    ]);
    add('cwd events', linux, [
        osc({ type: 'cwd', cwd: '/next' }), osc({ type: 'cwd', cwd: 'relative' }), osc({ type: 'cwd', cwd: '' }), osc({ type: 'cwd', cwd: 'a\nb' }),
        osc({ type: 'cwd', cwd: 'del\x7f' }), osc({ type: 'cwd', cwd: 5 }), osc({ type: 'cwd', cwd: '/' + 'c'.repeat(4095) }), osc({ type: 'cwd', cwd: '/' + 'c'.repeat(4096) })
    ]);
    add('launch variants', linux, [
        launch('claude'), launch('claude', TOKEN.toUpperCase(), { sessionId: UUID.toUpperCase() }), launch('gemini'), launch('codex', 'not-a-token'),
        launch('codex', TOKEN, { cwd: '' }), launch('codex', TOKEN, { cwd: 5 }), launch('claude', TOKEN, { sessionId: 'bad' }), launch('claude', TOKEN, { sessionId: 7 })
    ]);
    add('launch token inside an array', linux, [launch('codex', [TOKEN]), osc({ type: 'end', token: TOKEN, exitCode: 0 }), `session id: ${UUID}\n`]);
    add('launch token nested arrays', linux, [launch('codex', [[TOKEN]]), launch('codex', [TOKEN, TOKEN]), launch('codex', [null, TOKEN])]);
    add('end variants', linux, [
        osc({ type: 'end', token: TOKEN }), launch('codex'), osc({ type: 'end', token: TOKEN.toUpperCase() }), osc({ type: 'end' }),
        osc({ type: 'end', token: TOKEN, exitCode: 3, extra: true }), osc({ type: 'end', token: TOKEN })
    ]);
    add('non-object events', linux, ['\x1b]633;TC;' + Buffer.from('5').toString('base64') + '\x07', '\x1b]633;TC;' + Buffer.from('null').toString('base64') + '\x07',
        '\x1b]633;TC;' + Buffer.from('"launch"').toString('base64') + '\x07', '\x1b]633;TC;' + Buffer.from('[]').toString('base64') + '\x07', '\x1b]633;TC;\x07']);
    const cwdEvent = Buffer.from(JSON.stringify({ type: 'cwd', cwd: '/b64' })).toString('base64');
    add('lenient base64', linux, [
        `\x1b]633;TC;${cwdEvent.slice(0, 8)} \n\t${cwdEvent.slice(8)}\x07`, `\x1b]633;TC;${cwdEvent.replaceAll('+', '-').replaceAll('/', '_')}\x07`,
        `\x1b]633;TC;${cwdEvent.slice(0, 12)}!$${cwdEvent.slice(12)}\x07`, `\x1b]633;TC;${cwdEvent.slice(0, 12)}=${cwdEvent.slice(12)}\x07`,
        '\x1b]633;TC;' + Buffer.from(JSON.stringify({ type: 'cwd', cwd: '/子' })).toString('base64') + '\x07',
        '\x1b]633;TC;' + Buffer.concat([Buffer.from('{"type":"cwd","cwd":"/bad'), Buffer.from([0xff, 0xe5, 0xad]), Buffer.from('"}')]).toString('base64') + '\x07'
    ]);
    add('OSC 7 with directories', linux, ['\x1b]7;file:///a%20b\x07', '\x1b]7;file://localhost/c\x07', '\x1b]7;file://remote/d\x07', '\x1b]7;file:///bad%\x07',
        '\x1b]7;file:///e%0Af\x07', '\x1b]7;http://localhost/g\x07', '\x1b]7;file:///del%7F\x07', '\x1b]7;file:///C:/h\x07', '\x1b]7;file://tc-host/i\x07']);
    add('OSC 7 on Windows', { cwd: 'C:\\project', platform: 'win32', directories: true }, ['\x1b]7;file:///C:/a%20b\x07', '\x1b]7;file:///unix\x07',
        '\x1b]7;file://server/share\x07', '\x1b]7;file://localhost/C:/c\x07']);
    add('OSC 7 without directories', { cwd: '/project', platform: 'linux', directories: false }, ['\x1b]7;file:///a\x07', osc({ type: 'cwd', cwd: '/still' })]);
    add('Codex patterns', linux, [
        launch('codex'), `SESSION ID: ${UUID.toUpperCase()}\n`, `  \tsession id:\t${NEXT_UUID}.\n`, `session id: ${UUID}x\n`, `session id: ${UUID}_\n`,
        `session id: ${UUID}子\n`, `session id: ${'-'.repeat(36)}\n`, `xsession id: ${UUID}\n`, `\rTo continue this session, run codex resume ${NEXT_UUID}\r`,
        `To continue this session, run codex resume ${UUID}\nsession id: ${NEXT_UUID}\n`, `session id: ${NEXT_UUID}\nTo continue this session, run codex resume ${UUID}\n`
    ]);
    add('Codex header split by ANSI across chunks', linux, [launch('codex'), 'session id: \x1b[3', `2m${UUID}\x1b[0m\n`]);
    add('Codex header split across chunks', linux, [launch('codex'), `session id: ${UUID.slice(0, 20)}`, `${UUID.slice(20)}\n`]);
    add('Codex header ID followed later by a letter', linux, [launch('codex'), `session id: ${UUID}`, 'x\n']);
    add('Codex text window', linux, [launch('codex'), 'y'.repeat(5000), `\nsession id: ${UUID}\n`, 'z'.repeat(4090), `\nsession id: ${NEXT_UUID}\n`]);
    add('Codex header beyond the window', linux, [launch('codex'), `\nsession id: ${UUID}`, 'z'.repeat(4100)]);
    add('unterminated OSC beyond the buffer', linux, [launch('codex'), '\x1b]633;TC;' + 'q'.repeat(40000), '\x07', `\nsession id: ${UUID}\n`]);
    add('escape at a chunk end', linux, ['text\x1b', ']633;TC;' + Buffer.from(JSON.stringify({ type: 'cwd', cwd: '/joined' })).toString('base64') + '\x07']);
    add('escape then text at a chunk end', linux, [launch('codex'), 'session id: \x1b', `[1m${UUID}\n`]);
    add('nested OSC start in payload', linux, ['\x1b]0;title\x1b]633;TC;' + Buffer.from(JSON.stringify({ type: 'cwd', cwd: '/nested' })).toString('base64') + '\x07']);
    add('ST terminator', linux, [osc({ type: 'cwd', cwd: '/st' }).slice(0, -1) + '\x1b\\']);
    add('BEL before ST', linux, ['\x1b]633;TC;abc\x07def\x1b\\']);
    add('Windows Claude launch', { cwd: 'C:\\project', platform: 'win32', directories: false }, [
        osc({ type: 'launch', provider: 'claude', token: TOKEN, cwd: 'C:\\project', sessionId: UUID }), osc({ type: 'end', token: TOKEN, exitCode: 1 })
    ]);

    const osc7 = fileUris().filter(uri => uri.startsWith('file://')).map(uri => {
        const result = platform => run({ cwd: '/start', platform, directories: true }, [`\x1b]7;${uri}\x07`]).events.map(e => e.patch.cwd);
        return { uri, win32: result('win32'), linux: result('linux') };
    });
    const sessions = [
        null, 5, 'codex', {}, { provider: 'codex', sessionId: UUID, cwd: '/x' }, { provider: 'claude', sessionId: UUID.toUpperCase(), cwd: '/x', extra: 1 },
        { provider: 'Codex', sessionId: UUID, cwd: '/x' }, { provider: 'codex', sessionId: UUID, cwd: '' }, { provider: 'codex', sessionId: UUID, cwd: 'a\x1fb' },
        { provider: 'codex', sessionId: UUID, cwd: 'a\x7fb' }, { provider: 'codex', sessionId: `${UUID}\n`, cwd: '/x' }, { provider: 'codex', sessionId: UUID.replaceAll('-', ''), cwd: '/x' },
        { provider: 'codex', sessionId: 'g2345678-1234-4321-9876-123456789abc', cwd: '/x' }, { provider: 'codex', sessionId: UUID, cwd: '/' + 'x'.repeat(4095) },
        { provider: 'codex', sessionId: UUID, cwd: '/' + 'x'.repeat(4096) }, { provider: 'codex', sessionId: UUID, cwd: 5 }
    ].map(input => ({ input, result: sessionMetadata(input) }));
    return { cases, osc7, sessionMetadata: sessions };
}

/* ---------- Node runtime behaviors the host depends on ---------- */

function base64Fixtures() {
    const alphabet = ['A', 'B', 'Q', 'Y', 'W', 'J', 'j', 'z', '0', '9', '+', '/', '-', '_', '=', ' ', '\n', '\t', '!', '$', 'é', 'ÿ', '\u0080', '\u00a0',
        '子', '\u4e3d', '\u4e20', '\u4e41', '\uFEFF', '🚀', '\u0000'];
    const next = random(633);
    const inputs = ['YQ==', 'YQ', 'YQ=', 'YQ==YQ==', 'YWJj', 'YW Jj', 'YW$Jj', 'YW-_', 'Y', 'YWJjZ', '=YWJj', 'Y=Q=', 'YWJ=Yw==', '!!!!', '', 'YWJj!ZGVm',
        'YWJjZGVm====', 'YW=Jj', 'YW子Jj', 'YR==', 'YWJjZA=', 'YWJjZA==extra', '\uFEFFYWJj', 'YW\u4e3dJj', 'YW🚀Jj', '🚀YWJj', 'YWJj🚀'];
    for (let i = 0; i < 300; i++) inputs.push(Array.from({ length: Math.floor(next() * 25) }, () => pick(next, alphabet)).join(''));
    return inputs.map(input => {
        const bytes = Buffer.from(input, 'base64');
        return { input, hex: bytes.toString('hex'), utf8: bytes.toString('utf8') };
    });
}

function utf8Fixtures() {
    const pieces = [[0x61], [0x7f], [0x80], [0xbf], [0xc0, 0x80], [0xc2], [0xc2, 0xa9], [0xdf, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0xa0, 0x80], [0xe5, 0xad, 0x90],
        [0xe5, 0xad], [0xed, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xef, 0xbf, 0xbd], [0xf0, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x9a, 0x80], [0xf0, 0x9f, 0x9a],
        [0xf4, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf5], [0xff], [0xfe], [0x1b], [0x0a]];
    const next = random(8);
    const cases = [];
    for (let i = 0; i < 300; i++) {
        const bytes = Buffer.from(Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(next, pieces)).flat());
        const decoder = new StringDecoder('utf8');
        let streamed = '';
        for (const byte of bytes) streamed += decoder.write(Buffer.from([byte]));
        streamed += decoder.end();
        cases.push({ hex: bytes.toString('hex'), whole: bytes.toString('utf8'), streamed });
    }
    return cases;
}

/* ---------- Image assets ---------- */

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

async function assetFixtures() {
    const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tc-golden-'));
    const listing = dir => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const folders = [];
    const folder = () => { const dir = temporary(); folders.push(dir); return dir; };
    try {
        const bytes = spec => spec.hex !== undefined ? Buffer.from(spec.hex, 'hex') : Buffer.alloc(spec.count, Buffer.from(spec.repeat, 'hex'));
        const detectImage = [
            ['png', { hex: PNG.toString('hex') }], ['jpeg', { hex: JPEG.toString('hex') }], ['gif89a', { hex: GIF.toString('hex') }],
            ['gif87a', { hex: Buffer.from('GIF87a\x01\x00', 'latin1').toString('hex') }], ['gif88a', { hex: Buffer.from('GIF88a\x01\x00', 'latin1').toString('hex') }],
            ['webp', { hex: WEBP.toString('hex') }], ['riff without webp', { hex: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]).toString('hex') }],
            ['png signature only', { hex: PNG.subarray(0, 8).toString('hex') }], ['png signature and a byte', { hex: PNG.subarray(0, 9).toString('hex') }],
            ['jpeg three bytes', { hex: 'ffd8ff' }], ['jpeg four bytes', { hex: 'ffd8ff00' }], ['gif six bytes', { hex: Buffer.from('GIF89a', 'latin1').toString('hex') }],
            ['webp twelve bytes', { hex: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]).toString('hex') }],
            ['empty', { hex: '' }], ['svg', { hex: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('hex') }],
            ['15 MB', { repeat: 'ff', count: assets.IMAGE_BYTES }], ['15 MB and a byte', { repeat: 'ff', count: assets.IMAGE_BYTES + 1 }]
        ].map(([name, spec]) => ({ name, bytes: spec, ...attempt(() => { const { ext, mime } = assets.detectImage(bytes(spec)); return { ext, mime }; }) }));
        const assetNames = ['../workspace.terminalcanvas', `${'a'.repeat(64)}.svg`, 'C:\\Windows\\win.ini', ASSET, `${'a'.repeat(64)}.PNG`, `${'a'.repeat(64)}.png.tmp`, '', 5]
            .map(name => ({ name, ...attempt(() => { assets.assetPath(os.tmpdir(), name); return true; }) }));
        const dir = folder();
        const storeImage = [];
        for (const image of [PNG, JPEG, GIF, WEBP, PNG]) storeImage.push({ bytes: image.toString('hex'), name: await assets.storeImage(dir, image) });
        const stored = listing(dir);
        const keepList = [null, 'a.png', [], [ASSET], [ASSET, ASSET], ['../workspace.terminalcanvas'], [`${'a'.repeat(64)}.svg`], [42], [ASSET, 42], {},
            Array(200000).fill(ASSET), Array(200001).fill(ASSET)].map(input => ({ input, ...attempt(() => [...assets.keepList(input)]) }));
        const imageNames = [
            { items: [{ type: 'image', asset: 'b' }, { type: 'note' }, { type: 'image', asset: 'a' }, { type: 'image', asset: 'b' }] }, {}, { items: [] }
        ].map(board => ({ board, names: assets.imageNames(board) }));

        const dataUrl = (image, mime = 'image/png') => `data:${mime};base64,${image.toString('base64')}`;
        const forged = `${'c'.repeat(64)}.png`;
        const extractInputs = [
            ['renames forged names', { version: 2, items: [{ id: 'a', type: 'image', asset: ASSET }, { id: 'b', type: 'image', asset: forged }, { id: 'n', type: 'note' }], assets: { [ASSET]: dataUrl(PNG), [forged]: dataUrl(GIF, 'image/gif') } }],
            ['no assets', { version: 3, items: [] }], ['undefined assets stay', { version: 3, items: 'not checked' }],
            ['items not an array', { version: 3, items: 'nope', assets: { [ASSET]: dataUrl(PNG) } }],
            ['null items entries', { version: 3, items: [null, 5, { type: 'image', asset: ASSET }], assets: { [ASSET]: dataUrl(PNG) } }],
            ['empty assets', { version: 3, items: [], assets: {} }], ['assets array', { version: 2, items: [], assets: [] }], ['assets null', { version: 2, items: [], assets: null }],
            ['assets string', { assets: 'x' }], ['remote url', { assets: { [ASSET]: 'https://example.com/a.png' } }],
            ['html data url', { assets: { [ASSET]: 'data:text/html;base64,PGgxPg==' } }], ['bad name', { assets: { 'evil.png': dataUrl(PNG) } }],
            ['svg bytes', { assets: { [ASSET]: dataUrl(Buffer.from('<svg/>')) } }], ['uppercase mime', { assets: { [ASSET]: dataUrl(PNG, 'image/PNG') } }],
            ['mime with plus', { assets: { [ASSET]: dataUrl(PNG, 'image/svg+xml') } }], ['url-safe base64', { assets: { [ASSET]: 'data:image/png;base64,ab-_' } }],
            ['padding in the middle', { assets: { [ASSET]: `data:image/png;base64,${PNG.toString('base64')}==AAAA` } }],
            ['second asset fails', { items: [], assets: { [ASSET]: dataUrl(PNG), [forged]: 'data:image/png;base64,PHN2Zy8+' } }],
            ['integer-like key first', { items: [], assets: { [ASSET]: dataUrl(Buffer.from('<svg/>')), 7: dataUrl(PNG) } }],
            ['numeric input', 5], ['null input', null], ['string input', 'board'], ['array input', [1, 2]]
        ];
        const extractAssets = [];
        for (const [name, input] of extractInputs) {
            const target = folder();
            let outcome;
            try { outcome = { result: clone(await assets.extractAssets(clone(input), target)) }; } catch (error) { outcome = { error: error.message }; }
            extractAssets.push({ name, input, ...outcome, stored: listing(target) });
        }

        const embedAssets = [];
        const sha = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
        const pngName = `${sha(PNG)}.png`;
        for (const [name, files, board] of [
            ['embeds referenced images and reports missing ones', [{ name: pngName, hex: PNG.toString('hex') }],
                { items: [{ type: 'image', asset: pngName }, { type: 'image', asset: pngName }, { type: 'image', asset: `${'b'.repeat(64)}.png` }, { type: 'note', text: '' }] }],
            ['a stored file that is not an image is missing', [{ name: `${'d'.repeat(64)}.gif`, hex: '00ff' }], { items: [{ type: 'image', asset: `${'d'.repeat(64)}.gif` }] }],
            ['the stored bytes decide the MIME type', [{ name: `${'e'.repeat(64)}.png`, hex: GIF.toString('hex') }], { items: [{ type: 'image', asset: `${'e'.repeat(64)}.png` }] }],
            ['no items', [], {}]
        ]) {
            const target = folder();
            for (const file of files) fs.writeFileSync(path.join(target, file.name), Buffer.from(file.hex, 'hex'));
            embedAssets.push({ name, files, board, result: await assets.embedAssets(board, target) });
        }

        const cleanup = [];
        const png = pngName, gif = `${sha(GIF)}.gif`;
        for (const [name, files, keep] of [
            ['unreferenced images only', [{ name: png, hex: PNG.toString('hex') }, { name: gif, hex: GIF.toString('hex') }, { name: 'notes.txt', hex: '6b656570' },
                { name: `${png}.1234.tmp`, hex: '6b656570' }, { name: `${'e'.repeat(64)}.svg`, hex: '6b656570' }, { name: `${'f'.repeat(64)}.png`, directory: true }], [png]],
            ['everything kept', [{ name: png, hex: PNG.toString('hex') }], [png]],
            ['a folder that cannot be deleted', [{ name: `${'0'.repeat(64)}.png`, directory: true, child: 'inside' }, { name: gif, hex: GIF.toString('hex') }], []],
            ['no assets folder', null, []]
        ]) {
            const target = files === null ? path.join(folder(), 'missing') : folder();
            for (const file of files || []) {
                if (file.directory) {
                    fs.mkdirSync(path.join(target, file.name));
                    if (file.child) fs.writeFileSync(path.join(target, file.name, file.child), 'x');
                } else fs.writeFileSync(path.join(target, file.name), Buffer.from(file.hex, 'hex'));
            }
            const unused = await assets.unusedAssets(target, assets.keepList(keep));
            const deleted = await assets.deleteAssets(target, [...unused, { name: `${'b'.repeat(64)}.png`, bytes: 99 }]);
            cleanup.push({ name, files, keep, unused, deleted, remaining: listing(target) });
        }
        return { imageBytes: assets.IMAGE_BYTES, detectImage, assetNames, storeImage, stored, keepList, imageNames, extractAssets, embedAssets, cleanup };
    } finally {
        for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ---------- Shell integration text ---------- */

function shellFixtures() {
    const args = powershellArgs();
    json('shell/powershell-args.json', args);
    text('shell/powershell-bootstrap.ps1', Buffer.from(args.at(-1), 'base64').toString('utf16le'));
    const winSettings = 'C:\\Users\\tc\\AppData\\Roaming\\terminal-canvas\\shell-integration\\00000000-0000-4000-8000-000000000000.settings.json';
    const unixSettings = '/home/tc/.config/terminal-canvas/shell-integration/00000000-0000-4000-8000-000000000000.settings.json';
    text('shell/powershell-source.ps1', powershellSource(winSettings));
    text('shell/powershell-source-quoted.ps1', powershellSource("C:\\Users\\O'Brien\\it's.settings.json"));
    text('shell/bash-source.bash', bashSource(unixSettings));
    text('shell/bash-source-quoted.bash', bashSource("/home/o'brien/it's.settings.json"));

    // prepareIntegration() names files with random IDs and points at this checkout's session-hook.cjs.
    const hook = path.join(root, 'src', 'session-hook.cjs');
    const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
    const shQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
    const executables = { win32: 'C:\\Program Files\\Terminal Canvas\\Terminal Canvas.exe', linux: '/opt/Terminal Canvas/terminal-canvas', darwin: '/Applications/Terminal Canvas.app/Contents/MacOS/Terminal Canvas' };
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-golden-shell-'));
    try {
        const integration = [];
        let settings;
        for (const [platform, shell] of [['win32', 'powershell.exe'], ['win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'], ['win32', 'cmd.exe'], ['win32', 'C:\\Windows\\System32\\CMD.EXE'],
            ['linux', '/bin/bash'], ['linux', '/bin/zsh'], ['darwin', '/bin/zsh'], ['darwin', '/opt/homebrew/bin/bash'], ['linux', '/bin/sh']]) {
            const result = prepareIntegration({ folder, executable: executables[platform], platform, shell });
            if (!result) { integration.push({ platform, shell, result: null }); continue; }
            const created = fs.readdirSync(folder);
            const stem = path.basename(result.sessionFile, '.json');
            const settingsFile = path.join(folder, `${stem}.settings.json`);
            const scriptFile = path.join(folder, `${stem}.${platform === 'win32' ? 'ps1' : 'bash'}`);
            const placeholders = value => typeof value === 'string' ? value.replaceAll(settingsFile, '{{SETTINGS}}').replaceAll(scriptFile, '{{SCRIPT}}').replaceAll(result.sessionFile, '{{SESSION}}').replaceAll(hook, '{{HOOK}}') : value;
            const source = fs.readFileSync(scriptFile, 'utf8');
            const expectedSource = platform === 'win32' ? powershellSource(settingsFile) : bashSource(settingsFile);
            // PowerShell receives the script as -EncodedCommand; Bash sources the file instead.
            let args = result.args;
            if (args && platform === 'win32') {
                const decoded = Buffer.from(args.at(-1), 'base64').toString('utf16le');
                args = [...args.slice(0, -1), decoded === source ? '{{ENCODED_SCRIPT}}' : 'MISMATCH'];
            }
            integration.push({
                platform, shell,
                result: {
                    args: args ?? null, command: placeholders(result.command) ?? null,
                    env: Object.fromEntries(Object.entries(result.env).map(([key, value]) => [key, placeholders(value)])),
                    files: created.map(name => name.slice(stem.length)).sort(), scriptMatchesSource: source === expectedSource
                }
            });
            if (!settings?.[platform]) {
                const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
                const hookEntry = raw.hooks.SessionStart[0].hooks[0];
                if (platform === 'win32') {
                    const [prefix, encoded] = hookEntry.command.split(/ -EncodedCommand /);
                    const command = Buffer.from(encoded, 'base64').toString('utf16le').replace(psQuote(hook), "'{{HOOK}}'");
                    settings = { ...settings, win32: { settings: { ...raw, hooks: { SessionStart: [{ hooks: [{ ...hookEntry, command: `${prefix} -EncodedCommand {{ENCODED_COMMAND}}` }] }] } }, encodedCommand: command } };
                } else {
                    const command = hookEntry.command.replace(shQuote(hook), "'{{HOOK}}'");
                    settings = { ...settings, [platform]: { settings: { ...raw, hooks: { SessionStart: [{ hooks: [{ ...hookEntry, command }] }] } } } };
                }
            }
            result.cleanup();
        }
        json('shell/integration.json', { executables, integration, remaining: fs.readdirSync(folder) });
        json('shell/claude-settings.json', settings);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

/* ---------- The session hook ---------- */

function hookFixtures() {
    const hook = path.join(root, 'src', 'session-hook.cjs');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-golden-hook-'));
    try {
        // `emit` runs as its own process, as the shell integration runs it. Its folder is replaced by {{CWD}}.
        const emit = [
            [['emit', 'launch', 'claude', UUID], TOKEN], [['emit', 'launch', 'codex', ''], TOKEN], [['emit', 'launch'], null],
            [['emit', 'end', '0'], TOKEN], [['emit', 'end', '127'], TOKEN], [['emit', 'end', ''], TOKEN], [['emit', 'end', 'abc'], TOKEN],
            [['emit', 'end', ' 12 '], TOKEN], [['emit', 'end', '0x1f'], TOKEN], [['emit', 'end', '1e3'], TOKEN], [['emit', 'end', '-1'], TOKEN],
            [['emit', 'end', 'Infinity'], TOKEN], [['emit', 'end', '2.5'], TOKEN], [['emit', 'end'], TOKEN], [['emit', 'other', '5'], null]
        ].map(([args, token]) => {
            const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
            delete env.TC_LAUNCH_TOKEN;
            if (token) env.TC_LAUNCH_TOKEN = token;
            const result = spawnSync(process.execPath, [hook, ...args], { cwd: folder, env, encoding: 'utf8', windowsHide: true });
            const match = /^\x1b\]633;TC;([A-Za-z0-9+/=]*)\x07$/.exec(result.stdout);
            if (result.status !== 0 || !match) throw new Error(`session-hook.cjs ${args.join(' ')} failed: ${result.stderr}`);
            const event = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
            if ('cwd' in event) event.cwd = event.cwd === fs.realpathSync(folder) || event.cwd === folder ? '{{CWD}}' : 'UNEXPECTED';
            return { args: args.slice(1), token, event };
        });
        const input = { hook_event_name: 'SessionStart', session_id: UUID, cwd: '/project', transcript_path: '/private', secret: 'credential' };
        const record = [
            ['valid', input, 'claude', TOKEN], ['uppercase ID', { ...input, session_id: UUID.toUpperCase() }, 'claude', TOKEN],
            ['codex provider', input, 'codex', TOKEN], ['unknown provider', input, 'gemini', TOKEN],
            ['other event', { ...input, hook_event_name: 'SubagentStart' }, 'claude', TOKEN], ['bad ID', { ...input, session_id: 'bad' }, 'claude', TOKEN],
            ['missing cwd', { ...input, cwd: undefined }, 'claude', TOKEN], ['cwd with a newline', { ...input, cwd: '/a\nb' }, 'claude', TOKEN],
            ['Unicode cwd', { ...input, cwd: 'C:\\ไทย\\工作\\🚀' }, 'claude', TOKEN], ['missing token', input, 'claude', null],
            ['bad token', input, 'claude', 'not-a-token'], ['missing session file', input, 'claude', TOKEN, false],
            ['number input', 5, 'claude', TOKEN], ['array input', [], 'claude', TOKEN]
        ].map(([name, raw, provider, token, withFile = true]) => {
            const file = path.join(folder, 'session.json');
            fs.rmSync(file, { force: true });
            const env = { ...(token ? { TC_LAUNCH_TOKEN: token } : {}), ...(withFile ? { TC_SESSION_FILE: file } : {}) };
            const recorded = recordSession(clone(raw), provider, env);
            const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
            const leftovers = fs.readdirSync(folder).filter(name => name !== 'session.json');
            if (leftovers.length) throw new Error(`recordSession left ${leftovers.join(', ')}`);
            return { name, input: clone(raw), provider, token, sessionFile: withFile, recorded, written };
        });
        return { token: TOKEN, emit, record };
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

async function hostWorkspaceFixture() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-golden-host-'));
    try {
        const bytes = Buffer.from(require('../tests/e2e/fixtures.cjs').image, 'base64');
        const asset = await assets.storeImage(folder, bytes);
        const board = workspace.createWorkspace();
        board.name = 'Legacy image workspace ไทย';
        board.camera = { x: 17, y: -43, z: 0.65 };
        const card = workspace.createCard({ profile: 'claude', cwd: 'C:\\Users\\tc\\Legacy ไทย' });
        card.id = 'legacy-card'; card.groups = ['legacy-group'];
        card.session = { provider: 'claude', sessionId: UUID, cwd: card.cwd };
        board.cards.push(card);
        board.items.push(
            { id: 'legacy-note', type: 'note', x: 700, y: 20, w: 200, h: 200, text: 'Shared layout\nLegacy and Rust', color: 'green', fontSize: 'large', groups: ['legacy-group'] },
            { id: 'legacy-image', type: 'image', x: 700, y: 300, w: 160, h: 120, asset },
            { id: 'legacy-wire', type: 'line', start: { id: 'legacy-card' }, end: { id: 'legacy-note' }, arrow: true }
        );
        const autosave = workspace.validateWorkspace(board);
        const embedded = await assets.embedAssets(autosave, folder);
        return { autosave, portable: { ...autosave, assets: embedded.assets }, imageFiles: { [asset]: bytes.toString('base64') } };
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
}

async function main() {
    const { mutations, ...validation } = workspaceFixtures();
    json('workspace.json', validation);
    json('renderer.json', {
        profiles: workspace.PROFILES,
        workspace: workspace.createWorkspace(),
        cards: Object.fromEntries(workspace.PROFILES.map(profile => {
            const card = workspace.createCard({ profile: profile.id });
            card.id = `fixture-${profile.id}`;
            return [profile.id, card];
        }))
    });
    jsonLines('workspace-mutations.json', { delete: mutations.delete, base: mutations.base }, mutations.cases);
    json('directory-reports.json', directoryFixtures());
    json('metadata-parser.json', parserFixtures());
    json('node-base64.json', base64Fixtures());
    json('node-utf8.json', utf8Fixtures());
    json('assets.json', await assetFixtures());
    json('host-workspace.json', await hostWorkspaceFixture());
    json('hook.json', hookFixtures());
    shellFixtures();

    const check = process.argv.includes('--check');
    const stale = [];
    for (const [file, content] of outputs) {
        const target = path.join(goldenDir, file);
        const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        if (current === content) continue;
        stale.push(file);
        if (!check) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
        }
    }
    if (check && stale.length) {
        console.error(`Golden fixtures are out of date: ${stale.join(', ')}.\nRun node scripts/capture-golden.cjs and review the diff.`);
        process.exit(1);
    }
    console.log(check ? `Golden fixtures match (${outputs.size} files).` : `Wrote ${stale.length} of ${outputs.size} golden files to tests/golden/.`);
}
main().catch(error => { console.error(error); process.exit(1); });
