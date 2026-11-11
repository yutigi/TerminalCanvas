/* Check files produced by a native manual run; this does not drive or certify the UI. */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const archived = path.join(root, 'tests/reference/node-host');
const oracle = existsSync(archived) ? archived : path.join(root, 'src');
const { LIMITS, validateWorkspace } = require(path.join(oracle, 'workspace.cjs'));
const { assetPath, extractAssets } = require(path.join(oracle, 'assets.cjs'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function workspace(file) {
    assert.ok((await fs.stat(file)).size <= LIMITS.bytes, 'Workspace exceeds the legacy file size limit.');
    const bytes = await fs.readFile(file);
    return { raw: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
}

async function main() {
    assert.equal(process.argv.length, 6,
        'Usage: node tests/manual/verify-workspace-roundtrip.cjs <ordinary-file> <portable-file> <source-assets> <restored-profile>');
    const [ordinaryFile, portableFile, sourceAssets, profile] = process.argv.slice(2).map(file => path.resolve(file));
    const ordinary = await workspace(ordinaryFile);
    const portable = await workspace(portableFile);
    const restored = await workspace(path.join(profile, 'workspace.terminalcanvas'));
    assert.equal(ordinary.raw.assets, undefined, 'An ordinary save must keep images outside the workspace.');
    assert.ok(portable.raw.assets && Object.keys(portable.raw.assets).length, 'Portable export must embed images.');
    const expected = validateWorkspace(ordinary.raw);
    assert.deepEqual(validateWorkspace(restored.raw), expected, 'Restored autosave changed the layout.');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-canvas-native-files-'));
    try {
        assert.deepEqual(validateWorkspace(await extractAssets(portable.raw, temporary)), expected,
            'The legacy extractor/validator could not read the portable layout unchanged.');
        const names = [...new Set(expected.items.filter(item => item.type === 'image').map(item => item.asset))];
        assert.ok(names.length, 'Use a workspace containing an image for this manual check.');
        const images = [];
        for (const name of names) {
            const [source, extracted, imported] = await Promise.all([
                fs.readFile(assetPath(sourceAssets, name)),
                fs.readFile(assetPath(temporary, name)),
                fs.readFile(assetPath(path.join(profile, 'assets'), name)),
            ]);
            assert.deepEqual(extracted, source, `Portable export changed image bytes: ${name}`);
            assert.deepEqual(imported, source, `Restored profile changed image bytes: ${name}`);
            images.push({ name, bytes: source.length, sha256: sha256(source) });
        }
        process.stdout.write(JSON.stringify({
            checks: 'passed', scope: 'File contents only; native dialog, rendering, and process observations are separate.',
            oracle: path.relative(root, oracle), cards: expected.cards.length, items: expected.items.length, images,
            files: { ordinary: ordinary.sha256, portable: portable.sha256, restored: restored.sha256 },
        }, null, 2) + '\n');
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
