const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch, until, sendInput, click, key, screenshot, root } = require('./harness.cjs');
const { withSavedClipboard, fixtureScene, clipboardRead, choose } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 120000 };
const { image } = require('./fixtures.cjs');

test('minimap native navigation preserves zoom and Focus mode hides the overview', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    await fixtureScene(h.page, ['shell', 'claude', 'codex', 'gemini'].map((profile, index) => ({
        profile, title: `${profile} overview`, x: index % 2 * 700, y: Math.floor(index / 2) * 470
    })));
    const overview = await h.page.evaluate(() => {
        workspace.camera = { x: 50, y: 40, z: .65 }; renderCamera(); select(workspace.cards[0].id);
        const map = document.querySelector('#minimap-map').getBoundingClientRect();
        const toolbar = document.querySelector('.canvas-toolbar').getBoundingClientRect();
        const panel = document.querySelector('#minimap').getBoundingClientRect();
        return { hidden: document.querySelector('#minimap').hidden, cards: document.querySelectorAll('.minimap-card').length,
            overlap: panel.left < toolbar.right && panel.right > toolbar.left && panel.top < toolbar.bottom && panel.bottom > toolbar.top,
            x: Math.round(map.left + 175), y: Math.round(map.top + 60), cameraX: workspace.camera.x };
    });
    assert.equal(overview.hidden, false); assert.equal(overview.cards, 4); assert.equal(overview.overlap, false);
    const end = { x: overview.x - 20, y: overview.y - 10 };
    await sendInput(h.page, async () => {
        await h.page.mouse.move(overview.x, overview.y); await h.page.mouse.down();
        await h.page.mouse.move(end.x, end.y, { steps: 4 }); await h.page.mouse.up();
    }, { point: end });
    const nav = await h.page.evaluate(() => ({ x: workspace.camera.x, z: workspace.camera.z, dragging: !!minimapDrag }));
    assert.notEqual(nav.x, overview.cameraX); assert.equal(nav.z, .65); assert.equal(nav.dragging, false);
    await h.page.evaluate(() => setFocus(workspace.cards[0].id));
    assert.equal(await h.page.locator('#minimap').isHidden(), true);
    await h.page.evaluate(() => { setFocus(null); fitCanvas(); });
    assert.equal(await h.page.locator('#minimap').isVisible(), true);
    await screenshot(h.page, 'minimap');
});

test('board connectors, native clipboard, file drops, cleanup, and portable workspace images roundtrip', windows, async t => {
    await withSavedClipboard(async () => {
        const h = await launch({ clean: true }); t.after(() => h.dispose());
        const project = path.join(root, '.cache', 'tauri-board'); await fs.mkdir(project, { recursive: true });
        // Import through raw IPC, then load an ordinary format-3 board using the returned name.
        const asset = await h.page.evaluate(async image => {
            return (await invoke('import-image', { bytes: Uint8Array.from(atob(image), char => char.charCodeAt(0)) })).asset;
        }, image);
        await h.page.evaluate(asset => {
            loadWorkspace({ version: 3, name: 'Board roundtrip', camera: { x: 40, y: 60, z: .7 }, cards: [], items: [
                { id: 'note', type: 'note', x: 0, y: 80, w: 200, h: 200, text: 'Write the\nrelease notes', color: 'green' },
                { id: 'box', type: 'shape', shape: 'rect', x: 380, y: 80, w: 180, h: 110, text: 'Review' },
                { id: 'ring', type: 'shape', shape: 'ellipse', x: 700, y: 80, w: 150, h: 150, text: 'Ship', color: 'purple' },
                { id: 'pic', type: 'image', x: 380, y: 300, w: 192, h: 144, asset },
                { id: 'wire', type: 'line', start: { id: 'note' }, end: { id: 'box' }, arrow: true, color: 'blue' }
            ] });
        }, asset);
        await h.page.waitForFunction(() => { const img = document.querySelector('.item-image img'); return img?.complete && img.naturalWidth > 0; });
        const wire = await h.page.evaluate(() => {
            const { start, end } = linePoints(findItem('wire')), r = viewport.getBoundingClientRect(), c = workspace.camera;
            const x = Math.round(r.left + c.x + (start.x + end.x) / 2 * c.z);
            const y = Math.round(r.top + c.y + (start.y + end.y) / 2 * c.z);
            return { x, y, hit: document.elementFromPoint(x, y)?.getAttribute('class') };
        });
        assert.equal(wire.hit, 'line-hit'); await click(h.page, wire);
        assert.deepEqual(await h.page.evaluate(() => [...selection]), ['wire']);
        await h.page.evaluate(() => { select('note'); viewport.focus(); });
        await key(h.page, 'Control+c');
        await until(async () => await clipboardRead(h.page) === 'Write the\nrelease notes', 'Board copy did not reach the native clipboard.');
        const count = await h.page.evaluate(() => workspace.items.length);
        await key(h.page, 'Control+v');
        await until(async () => (await h.page.evaluate(() => workspace.items.length)) === count + 1, 'Native board paste did not add an item.');
        const pasted = await h.page.evaluate(() => ({ item: workspace.items.at(-1), selected: [...selection] }));
        assert.equal(pasted.item.text, 'Write the\nrelease notes'); assert.notEqual(pasted.item.id, 'note');
        assert.deepEqual(pasted.selected, [pasted.item.id]);
        await key(h.page, 'Control+x');
        await until(async () => (await h.page.evaluate(() => workspace.items.length)) === count, 'Cut did not wait for the native clipboard write.');
        await key(h.page, 'Control+v');
        await until(async () => (await h.page.evaluate(() => workspace.items.length)) === count + 1, 'Cut items were not pasted back.');
        await key(h.page, 'Control+d');
        assert.equal(await h.page.evaluate(() => workspace.items.length), count + 2);
        const dropped = path.join(project, 'drop.png'); await fs.writeFile(dropped, Buffer.from(image, 'base64'));
        const point = await h.page.evaluate(() => { const r = viewport.getBoundingClientRect(); return { x: Math.round(r.left + r.width - 200), y: Math.round(r.top + 400) }; });
        const cdp = await h.page.context().newCDPSession(h.page);
        const data = { items: [], files: [dropped], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...point, data });
        await until(async () => (await h.page.evaluate(() => workspace.items.filter(item => item.type === 'image').length)) === 2, 'Native file drop did not reach the board.');
        await h.page.waitForFunction(() => [...document.querySelectorAll('.item-image img')].every(img => img.complete && img.naturalWidth > 0));
        await h.page.evaluate(async image => {
            const bytes = [...Uint8Array.from(atob(image), char => char.charCodeAt(0)), 0];
            await invoke('import-image', { bytes: new Uint8Array(bytes) });
            const found = await invoke('unused-images', { keep: referencedImages() });
            if (found.count !== 1) throw new Error('Expected exactly one orphaned image.');
            const result = await invoke('delete-unused-images', { keep: referencedImages() });
            if (result.deleted !== 1) throw new Error('Orphaned image was not deleted.');
        }, image);
        assert.deepEqual(await fs.readdir(path.join(h.profile, 'assets')), [asset]);
        const ordinary = path.join(project, 'ordinary.terminalcanvas'), portable = path.join(project, 'portable.terminalcanvas');
        await choose(h.page, ordinary); await h.page.evaluate(() => invoke('save-as', workspace));
        await choose(h.page, portable); await h.page.evaluate(() => invoke('export', workspace));
        const saved = JSON.parse(await fs.readFile(ordinary, 'utf8')), exported = JSON.parse(await fs.readFile(portable, 'utf8'));
        assert.equal(saved.version, 3); assert.equal(saved.assets, undefined); assert.equal(typeof exported.assets[asset], 'string');
        await fs.rm(path.join(h.profile, 'assets', asset));
        await choose(h.page, portable);
        await h.page.evaluate(async () => { loadWorkspace((await invoke('open')).workspace); });
        await h.page.waitForFunction(() => [...document.querySelectorAll('.item-image img')].every(img => img.complete && img.naturalWidth > 0));
        assert.deepEqual(await h.page.evaluate(() => workspace), saved);
        assert.equal((await h.state()).host.running, 0);
        await screenshot(h.page, 'board-roundtrip');
    });
});
