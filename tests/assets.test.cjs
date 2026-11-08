const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { IMAGE_BYTES, detectImage, assetPath, storeImage, embedAssets, extractAssets } = require('../src/assets.cjs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
async function folder(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-canvas-assets-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

test('images are identified by their bytes, never by name, and SVG or oversized files are rejected', () => {
    assert.equal(detectImage(PNG).ext, 'png');
    assert.equal(detectImage(JPEG).ext, 'jpg');
    assert.equal(detectImage(GIF).ext, 'gif');
    assert.equal(detectImage(WEBP).ext, 'webp');
    assert.equal(detectImage(new Uint8Array(PNG)).mime, 'image/png');
    assert.throws(() => detectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /Only PNG/);
    assert.throws(() => detectImage(Buffer.alloc(0)), /between/);
    assert.throws(() => detectImage(Buffer.alloc(IMAGE_BYTES + 1, 0xff)), /between/);
    for (const name of ['../workspace.terminalcanvas', `${'a'.repeat(64)}.svg`, 'C:\\Windows\\win.ini']) assert.throws(() => assetPath(os.tmpdir(), name), /Invalid image asset/);
});

test('stored images are content-addressed and deduplicated', async t => {
    const dir = await folder(t);
    const name = await storeImage(dir, PNG);
    assert.equal(name, `${sha(PNG)}.png`);
    assert.equal(await storeImage(dir, new Uint8Array(PNG)), name);
    assert.deepEqual(await fs.readdir(dir), [name]);
    assert.deepEqual(await fs.readFile(path.join(dir, name)), PNG);
});

test('portable exports embed referenced images and report missing ones', async t => {
    const dir = await folder(t);
    const name = await storeImage(dir, PNG);
    const missing = `${'b'.repeat(64)}.png`;
    const board = { items: [{ type: 'image', asset: name }, { type: 'image', asset: name }, { type: 'image', asset: missing }, { type: 'note', text: '' }] };
    const { assets, missing: absent } = await embedAssets(board, dir);
    assert.deepEqual(Object.keys(assets), [name]);
    assert.equal(assets[name], `data:image/png;base64,${PNG.toString('base64')}`);
    assert.deepEqual(absent, [missing]);
});

test('imports extract embedded images, rename mismatched hashes, and strip the embedded payload', async t => {
    const source = await folder(t), target = await folder(t);
    const name = await storeImage(source, PNG);
    const forged = `${'c'.repeat(64)}.png`;
    const raw = {
        version: 2, items: [{ id: 'a', type: 'image', asset: name }, { id: 'b', type: 'image', asset: forged }],
        assets: { [name]: `data:image/png;base64,${PNG.toString('base64')}`, [forged]: `data:image/gif;base64,${GIF.toString('base64')}` }
    };
    const board = await extractAssets(raw, target);
    assert.equal('assets' in board, false);
    assert.equal(board.items[0].asset, name);
    assert.equal(board.items[1].asset, `${sha(GIF)}.gif`, 'the stored name always comes from the bytes');
    assert.deepEqual((await fs.readdir(target)).sort(), [name, `${sha(GIF)}.gif`].sort());
    assert.equal(await extractAssets({ version: 2, items: [] }, target).then(b => 'assets' in b), false);
});

test('imports reject malformed embedded images', async t => {
    const dir = await folder(t);
    const png = `${'d'.repeat(64)}.png`;
    for (const assets of [[], null, { [png]: 'https://example.com/a.png' }, { [png]: 'data:text/html;base64,PGgxPg==' }, { 'evil.png': `data:image/png;base64,${PNG.toString('base64')}` }, { [png]: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` }]) {
        await assert.rejects(extractAssets({ version: 2, items: [], assets }, dir), /Invalid embedded|Only PNG/);
    }
    assert.deepEqual(await fs.readdir(dir), []);
});
