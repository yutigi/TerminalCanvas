const { randomUUID } = require('node:crypto');

const LIMITS = Object.freeze({ cards: 24, bytes: 1024 * 1024, coordinate: 100000 });
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
function validateCard(raw) {
    if (!raw || raw.type !== 'terminal') throw new Error('Unsupported card type.');
    const id = text(raw.id, 80, 'card ID');
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid card ID.');
    if (!PROFILES.some(p => p.id === raw.profile)) throw new Error('Unknown terminal profile.');
    const card = {
        id, type: 'terminal', profile: raw.profile,
        title: text(raw.title, 100, 'title') || 'Terminal',
        cwd: text(raw.cwd, 4096, 'working directory'),
        command: text(raw.command, 2000, 'command')
    };
    for (const axis of ['x', 'y']) {
        if (!finite(raw[axis], -LIMITS.coordinate, LIMITS.coordinate)) throw new Error('Invalid card position.');
        card[axis] = raw[axis];
    }
    for (const [key, min, max] of [['w', 400, 2400], ['h', 280, 1800]]) {
        if (!finite(raw[key], min, max)) throw new Error('Invalid card size.');
        card[key] = raw[key];
    }
    return card;
}
function validateWorkspace(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.cards) || raw.cards.length > LIMITS.cards) throw new Error('Unsupported workspace format or too many terminals.');
    if (!raw.camera || !finite(raw.camera.x, -LIMITS.coordinate, LIMITS.coordinate) || !finite(raw.camera.y, -LIMITS.coordinate, LIMITS.coordinate) || !finite(raw.camera.z, 0.35, 1.5)) throw new Error('Invalid canvas camera.');
    const cards = raw.cards.map(validateCard);
    if (new Set(cards.map(c => c.id)).size !== cards.length) throw new Error('Duplicate terminal IDs.');
    return {
        version: 1,
        name: text(raw.name, 100, 'workspace name') || 'Untitled workspace',
        camera: { x: raw.camera.x, y: raw.camera.y, z: raw.camera.z }, cards
    };
}
function createWorkspace() {
    return { version: 1, name: 'My AI workspace', camera: { x: 48, y: 48, z: 1 }, cards: [] };
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
module.exports = { LIMITS, PROFILES, validateCard, validateWorkspace, createWorkspace, createCard };
