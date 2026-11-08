const { randomUUID } = require('node:crypto');

const LIMITS = Object.freeze({ cards: 24, items: 1000, bytes: 64 * 1024 * 1024, coordinate: 100000, text: 10000 });
const VERSION = 2;
const ITEM_TYPES = Object.freeze(['text', 'note', 'shape', 'frame', 'image', 'line']);
const SHAPES = Object.freeze(['rect', 'ellipse']);
const ITEM_SIZE = Object.freeze({ min: 8, max: 8000 });
const ASSET_NAME = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
const PROFILES = Object.freeze([
    { id: 'shell', name: 'Terminal', command: '', color: '#94a3b8', initials: '>_' },
    { id: 'claude', name: 'Claude Code', command: 'claude', color: '#d6a181', initials: 'CC' },
    { id: 'codex', name: 'Codex', command: 'codex', color: '#8dd9bd', initials: 'CX' },
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini', color: '#93b4ff', initials: 'GM' },
    { id: 'custom', name: 'Custom command', command: '', color: '#c4a3ff', initials: 'AI' }
]);
const finite = (n, min, max) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
function text(value, max, label) {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}.`);
    return value.trim();
}
// Board text may span lines; other control characters remain invalid.
function multiline(value, label) {
    if (value === undefined) return '';
    const normalized = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : null;
    if (normalized === null || normalized.length > LIMITS.text || /[\x00-\x08\x0b-\x1f]/.test(normalized)) throw new Error(`Invalid ${label}.`);
    return normalized;
}
function identifier(value, label) {
    const id = text(value, 80, label);
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error(`Invalid ${label}.`);
    return id;
}
function position(raw, target, label) {
    for (const axis of ['x', 'y']) {
        if (!finite(raw?.[axis], -LIMITS.coordinate, LIMITS.coordinate)) throw new Error(`Invalid ${label} position.`);
        target[axis] = raw[axis];
    }
    return target;
}
function withGroup(raw, target) {
    if (raw.group !== undefined && raw.group !== null) target.group = identifier(raw.group, 'group ID');
    return target;
}
function validateCard(raw) {
    if (!raw || raw.type !== 'terminal') throw new Error('Unsupported card type.');
    const id = identifier(raw.id, 'card ID');
    if (!PROFILES.some(p => p.id === raw.profile)) throw new Error('Unknown terminal profile.');
    const card = {
        id, type: 'terminal', profile: raw.profile,
        title: text(raw.title, 100, 'title') || 'Terminal',
        cwd: text(raw.cwd, 4096, 'working directory'),
        command: text(raw.command, 2000, 'command')
    };
    position(raw, card, 'card');
    for (const [key, min, max] of [['w', 400, 2400], ['h', 280, 1800]]) {
        if (!finite(raw[key], min, max)) throw new Error('Invalid card size.');
        card[key] = raw[key];
    }
    return withGroup(raw, card);
}
function endpoint(raw) {
    if (raw && typeof raw === 'object' && 'id' in raw) return { id: identifier(raw.id, 'connector target') };
    return position(raw, {}, 'line endpoint');
}
function validateItem(raw) {
    if (!raw || !ITEM_TYPES.includes(raw.type)) throw new Error('Unsupported canvas item type.');
    const item = { id: identifier(raw.id, 'item ID'), type: raw.type };
    if (raw.type === 'line') {
        item.start = endpoint(raw.start);
        item.end = endpoint(raw.end);
        item.arrow = raw.arrow === true;
        return withGroup(raw, item);
    }
    position(raw, item, 'item');
    for (const key of ['w', 'h']) {
        if (!finite(raw[key], ITEM_SIZE.min, ITEM_SIZE.max)) throw new Error('Invalid item size.');
        item[key] = raw[key];
    }
    if (raw.type === 'text' || raw.type === 'note') item.text = multiline(raw.text, `${raw.type} text`);
    if (raw.type === 'shape') {
        if (!SHAPES.includes(raw.shape)) throw new Error('Unsupported shape.');
        item.shape = raw.shape;
        item.text = multiline(raw.text, 'shape text');
    }
    if (raw.type === 'frame') item.title = text(raw.title ?? '', 100, 'frame title') || 'Frame';
    if (raw.type === 'image') {
        if (typeof raw.asset !== 'string' || !ASSET_NAME.test(raw.asset)) throw new Error('Invalid image asset.');
        item.asset = raw.asset;
    }
    return withGroup(raw, item);
}
function validateWorkspace(raw) {
    if (!raw || ![1, VERSION].includes(raw.version) || !Array.isArray(raw.cards) || raw.cards.length > LIMITS.cards) throw new Error('Unsupported workspace format or too many terminals.');
    const rawItems = raw.version === 1 ? [] : raw.items ?? [];
    if (!Array.isArray(rawItems) || rawItems.length > LIMITS.items) throw new Error('Invalid canvas items or too many items.');
    if (!raw.camera || !finite(raw.camera.x, -LIMITS.coordinate, LIMITS.coordinate) || !finite(raw.camera.y, -LIMITS.coordinate, LIMITS.coordinate) || !finite(raw.camera.z, 0.35, 1.5)) throw new Error('Invalid canvas camera.');
    const cards = raw.cards.map(validateCard);
    if (new Set(cards.map(c => c.id)).size !== cards.length) throw new Error('Duplicate terminal IDs.');
    const items = rawItems.map(validateItem);
    const ids = new Set(cards.map(c => c.id));
    for (const item of items) {
        if (ids.has(item.id)) throw new Error('Duplicate canvas item IDs.');
        ids.add(item.id);
    }
    // Connectors may attach to any element except another line or themselves.
    const targets = new Set([...cards, ...items.filter(i => i.type !== 'line')].map(e => e.id));
    for (const line of items.filter(i => i.type === 'line')) {
        for (const end of [line.start, line.end]) if (end.id && !targets.has(end.id)) throw new Error('Connector references a missing item.');
    }
    return {
        version: VERSION,
        name: text(raw.name, 100, 'workspace name') || 'Untitled workspace',
        camera: { x: raw.camera.x, y: raw.camera.y, z: raw.camera.z }, cards, items
    };
}
function createWorkspace() {
    return { version: VERSION, name: 'My AI workspace', camera: { x: 48, y: 48, z: 1 }, cards: [], items: [] };
}
function createCard(options = {}) {
    const profile = PROFILES.find(p => p.id === options.profile) || PROFILES[0];
    return validateCard({
        id: randomUUID(), type: 'terminal', profile: profile.id,
        title: options.title || profile.name, cwd: options.cwd || '',
        command: options.command ?? profile.command,
        x: options.x ?? 0, y: options.y ?? 0, w: 660, h: 430
    });
}
module.exports = { LIMITS, VERSION, PROFILES, ITEM_TYPES, SHAPES, ITEM_SIZE, ASSET_NAME, validateCard, validateItem, validateWorkspace, createWorkspace, createCard };
