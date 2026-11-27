const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { launch, until, sendInput, click, key, screenshot, root, ensureFocus } = require('./harness.cjs');
const { withSavedClipboard, fixtureScene, clipboardRead, choose } = require('./support.cjs');
const windows = { skip: process.platform !== 'win32', timeout: 120000 };
const { image } = require('./fixtures.cjs');
const { arrowPaintFailures } = require('../visual/arrow-paint.cjs');

test('WebView2 arrow pixels preserve plain, colored, and selected lines in forced colors', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/golden/renderer.json'), 'utf8'));
    await h.page.evaluate(fixture => { window.layoutFixture = fixture; }, fixture);
    await h.page.evaluate(await fs.readFile(path.join(root, 'tests/visual/probe.js'), 'utf8'));
    const capture = async name => {
        const scene = await h.page.evaluate(() => window.captureLayout('board'));
        const png = await h.page.screenshot({ path: path.join(root, '.cache', `tauri-arrow-${name}.png`) });
        scene.pixels = await h.page.evaluate(({ dataURL, lines }) => window.sampleLayoutPixels(dataURL, lines),
            { dataURL: 'data:image/png;base64,' + png.toString('base64'), lines: scene.lines });
        return scene;
    };
    const normal = await capture('normal');
    assert.deepEqual(arrowPaintFailures(normal, 'WebView2 normal'), []);
    await h.page.evaluate(() => {
        const hidden = document.createElement('button'); hidden.className = 'nav-item'; hidden.hidden = true;
        document.querySelector('#help').before(hidden);
    });
    const withHidden = await h.page.evaluate(() => window.captureLayout('board'));
    assert.deepEqual(withHidden.elements, normal.elements, 'A hidden control must not renumber visible layout measurements.');
    await h.page.emulateMedia({ forcedColors: 'active' });
    const forced = await capture('forced-colors');
    assert.equal(forced.forcedColorsActive, true);
    assert.deepEqual(arrowPaintFailures(forced, 'WebView2 forced colors'), []);
    await h.page.emulateMedia({ forcedColors: 'none' });
    await h.page.evaluate(() => window.layoutArrowFillFault(true));
    const broken = arrowPaintFailures(await capture('missing-fill'), 'WebView2 missing fill');
    assert.ok(broken.some(failure => failure.includes('arrowhead pixel')), 'Removing fill must fail the actual pixel guard.');
    await h.page.evaluate(() => window.layoutArrowFillFault(false));
});

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

test('Arrange lays out a branched terminal workflow left to right in one undo step', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    // Mixed sizes in scattered places: plan -> build -> test, plan -> docs, and build -> review -> plan closes a cycle.
    const sizes = { plan: [660, 430], build: [520, 360], docs: [700, 300], test: [600, 480], review: [480, 330], notes: [560, 340] };
    await fixtureScene(h.page, Object.keys(sizes).map((title, index) => ({
        profile: ['shell', 'claude', 'codex', 'gemini'][index % 4], title, x: (5 - index) * 410, y: (index % 3) * 520
    })));
    const before = await h.page.evaluate(({ sizes, pairs }) => {
        const byTitle = Object.fromEntries(workspace.cards.map(card => [card.title, card]));
        for (const [title, [w, h]] of Object.entries(sizes)) Object.assign(byTitle[title], { w, h });
        workspace.cards.forEach(renderCardGeometry);
        for (const [from, to] of pairs) {
            const line = { id: crypto.randomUUID(), type: 'line', start: { id: byTitle[from].id }, end: { id: byTitle[to].id }, arrow: true };
            workspace.items.push(line); mountItem(line);
        }
        renderLines(); clearHistory();
        return workspace.cards.map(({ id, title, x, y, w, h }) => ({ id, title, x, y, w, h }));
    }, { sizes, pairs: [['plan', 'build'], ['plan', 'docs'], ['build', 'test'], ['build', 'review'], ['review', 'plan']] });
    const layout = () => h.page.evaluate(() => ({
        cards: Object.fromEntries(workspace.cards.map(({ title, x, y, w, h }) => [title, { x, y, w, h }])),
        steps: boardHistory.undo.length
    }));
    await h.page.locator('#arrange').click();
    const { cards, steps } = await layout();
    assert.equal(steps, 1);
    for (const card of before) assert.deepEqual([cards[card.title].w, cards[card.title].h], [card.w, card.h], `${card.title} keeps its size`);
    for (const [from, to] of [['plan', 'build'], ['plan', 'docs'], ['build', 'test'], ['build', 'review']]) {
        assert.ok(cards[to].x > cards[from].x + cards[from].w, `${to} sits right of ${from}`);
    }
    assert.equal(cards.build.y, cards.plan.y, 'the first branch continues the row');
    assert.ok(cards.docs.y > cards.build.y, 'the second branch sits below the first');
    assert.ok(cards.notes.y > Math.max(...['plan', 'build', 'docs', 'test', 'review'].map(t => cards[t].y + cards[t].h)), 'unconnected terminals follow the flow');
    await screenshot(h.page, 'arrange-branched');
    await h.page.locator('#arrange').click();
    assert.deepEqual(await layout(), { cards, steps: 1 }, 'a second Arrange changes nothing and adds no undo step');
    await h.page.locator('#undo').click();
    assert.deepEqual(await h.page.evaluate(() => workspace.cards.map(({ id, title, x, y, w, h }) => ({ id, title, x, y, w, h }))), before);
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

test('snapping lines up native terminal moves and resizes with guides, and Alt places freely', windows, async t => {
    const h = await launch({ clean: true }); t.after(() => h.dispose());
    const page = h.page;
    await fixtureScene(page, [{ profile: 'shell', title: 'Anchor', x: 800, y: 40 }, { profile: 'shell', title: 'Moving', x: 0, y: 0 }]);
    const scene = await page.evaluate(async () => {
        Object.assign(workspace.cards[0], { w: 500, h: 300 }); renderGeometry(workspace.cards[0]);
        workspace.camera = { x: 30, y: 90, z: .5 }; renderCamera();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const toggle = document.querySelector('#snap-toggle').getBoundingClientRect();
        const before = document.querySelector('#minimap-toggle').getBoundingClientRect();
        return { toggle: { x: Math.round(toggle.x + toggle.width / 2), y: Math.round(toggle.y + toggle.height / 2) },
            added: toggle.right - before.right, width: toggle.width, menu: document.querySelector('#snap-grid').getBoundingClientRect().width,
            enabled: snapPreferences.enabled, history: boardHistory.undo.length };
    });
    assert.deepEqual([scene.added, scene.width, scene.menu, scene.enabled], [50, 31, 64, true], 'a divider, the magnet, and its menu; snapping starts on');
    await click(page, scene.toggle);
    assert.equal(await page.evaluate(() => snapPreferences.enabled), false);
    // The menu hides while snapping is off, so the centered toolbar and its magnet move.
    await click(page, await page.evaluate(() => {
        const toggle = document.querySelector('#snap-toggle').getBoundingClientRect();
        return { x: Math.round(toggle.x + toggle.width / 2), y: Math.round(toggle.y + toggle.height / 2) };
    }));
    assert.deepEqual(await page.evaluate(() => [snapPreferences.enabled, document.querySelector('#snap-grid').hidden,
        JSON.parse(localStorage.getItem('terminal-canvas.snapping.v1')).enabled]), [true, false, true]);
    const box = selector => page.evaluate(selector => {
        const r = sessions.get(workspace.cards[1].id).element.querySelector(selector).getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, selector);
    const moving = () => page.evaluate(() => {
        const { x, y, w, h } = workspace.cards[1];
        return { x, y, w, h, guides: [...document.querySelectorAll('.snap-guide')].map(guide => guide.className) };
    });
    // Moved 50 world pixels right and 44 down: x goes to the grid at 48, and the top edge, 2 screen
    // pixels below the anchor's, snaps to it.
    const status = await box('.card-status'), grab = { x: Math.round(status.x + status.w / 2), y: Math.round(status.y + status.h / 2) };
    await ensureFocus(page);
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(grab.x + 25, grab.y + 22, { steps: 5 });
    assert.deepEqual(await moving(), { x: 48, y: 40, w: 660, h: 430, guides: ['snap-guide horizontal'] });
    await screenshot(page, 'snapping-move');
    await page.keyboard.down('Alt');
    assert.deepEqual(await moving(), { x: 50, y: 44, w: 660, h: 430, guides: [] }, 'Alt places freely without moving the pointer');
    await page.keyboard.up('Alt');
    assert.equal((await moving()).y, 40);
    await sendInput(page, () => page.mouse.up(), { point: { x: grab.x + 25, y: grab.y + 22 } });
    assert.deepEqual(await moving(), { x: 48, y: 40, w: 660, h: 430, guides: [] });
    // Resized to within 2 screen pixels of the anchor's size, it takes the anchor's size and bottom edge.
    const card = await box('.card-resize');
    const corner = { x: Math.round(card.x + card.w / 2), y: Math.round(card.y + card.h / 2) };
    await page.mouse.move(corner.x, corner.y); await page.mouse.down();
    await page.mouse.move(corner.x - 78, corner.y - 64, { steps: 5 });
    const resized = await moving();
    assert.deepEqual([resized.w, resized.h], [500, 300]);
    assert.equal(resized.guides.filter(name => name.endsWith(' size')).length, 4, 'both sizes are marked on both terminals');
    await screenshot(page, 'snapping-resize');
    await sendInput(page, () => page.mouse.up(), { point: { x: corner.x - 78, y: corner.y - 64 } });
    assert.equal(await page.evaluate(() => boardHistory.undo.length), scene.history + 2, 'one undo step for each drag');
    await page.evaluate(() => undo());
    assert.deepEqual(await moving(), { x: 48, y: 40, w: 660, h: 430, guides: [] });
});
