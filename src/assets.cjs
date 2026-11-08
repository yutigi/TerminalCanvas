/* Image assets live content-addressed in the app's data folder; workspaces reference them by name. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { ASSET_NAME } = require('./workspace.cjs');

const IMAGE_BYTES = 15 * 1024 * 1024;
const TYPES = Object.freeze([
    { ext: 'png', mime: 'image/png', test: b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a },
    { ext: 'jpg', mime: 'image/jpeg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'gif', mime: 'image/gif', test: b => b.length > 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
    { ext: 'webp', mime: 'image/webp', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' }
]);
// File contents decide the type; names and declared MIME types are never trusted. SVG is excluded.
function detectImage(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!buffer.length || buffer.length > IMAGE_BYTES) throw new Error('Images must be between 1 byte and 15 MB.');
    const type = TYPES.find(t => t.test(buffer));
    if (!type) throw new Error('Only PNG, JPEG, GIF, and WebP images are supported.');
    return { buffer, ...type };
}
function assetPath(directory, name) {
    if (typeof name !== 'string' || !ASSET_NAME.test(name)) throw new Error('Invalid image asset.');
    return path.join(directory, name);
}
async function storeImage(directory, bytes) {
    const { buffer, ext } = detectImage(bytes);
    const name = `${createHash('sha256').update(buffer).digest('hex')}.${ext}`;
    const file = assetPath(directory, name);
    try { await fs.access(file); return name; } catch {}
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, buffer, { flag: 'wx' });
        await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(() => {}); }
    return name;
}
const imageNames = board => [...new Set((board.items || []).filter(i => i.type === 'image').map(i => i.asset))];
// Portable exports carry every referenced image as a data URL. Missing files are reported, not skipped.
async function embedAssets(board, directory) {
    const assets = {}, missing = [];
    for (const name of imageNames(board)) {
        try {
            const { buffer, mime } = detectImage(await fs.readFile(assetPath(directory, name)));
            assets[name] = `data:${mime};base64,${buffer.toString('base64')}`;
        } catch { missing.push(name); }
    }
    return { assets, missing };
}
// Imports re-hash every embedded image, so a file cannot plant content under a mismatched name.
async function extractAssets(raw, directory) {
    if (!raw || typeof raw !== 'object' || raw.assets === undefined) return raw;
    if (!raw.assets || typeof raw.assets !== 'object' || Array.isArray(raw.assets)) throw new Error('Invalid embedded images.');
    const renamed = new Map();
    for (const [name, url] of Object.entries(raw.assets)) {
        const match = typeof url === 'string' && /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(url);
        if (!ASSET_NAME.test(name) || !match) throw new Error('Invalid embedded image.');
        renamed.set(name, await storeImage(directory, Buffer.from(match[1], 'base64')));
    }
    const { assets: _embedded, ...board } = raw;
    if (Array.isArray(board.items)) {
        board.items = board.items.map(item => item?.type === 'image' && renamed.has(item.asset) ? { ...item, asset: renamed.get(item.asset) } : item);
    }
    return board;
}
module.exports = { IMAGE_BYTES, detectImage, assetPath, storeImage, embedAssets, extractAssets, imageNames };
