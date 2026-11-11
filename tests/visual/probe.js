/* Shared by the Electron and WKWebView fixtures. No terminals or OS services run. */
window.waitForLayoutViewport = async function (width, height) {
    const deadline = Date.now() + 5000;
    while (innerWidth !== width || innerHeight !== height) {
        if (Date.now() >= deadline) throw new Error(`Requested viewport ${width}x${height}; received ${innerWidth}x${innerHeight}`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
};

window.captureLayout = async function (scene) {
    for (let tries = 0; typeof ready === 'undefined' || !ready; tries++) {
        if (tries === 200) throw new Error('The renderer did not initialize.');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    loadWorkspace(structuredClone(window.layoutFixture.workspace));
    if (scene === 'launch') openLaunch('claude');
    if (scene === 'card') {
        const board = structuredClone(window.layoutFixture.workspace);
        board.cards = [{ ...window.layoutFixture.cards.shell, cwd: '/tmp/project' }];
        loadWorkspace(board);
    }
    if (scene === 'board') {
        const board = structuredClone(window.layoutFixture.workspace);
        board.camera = { x: 40, y: 20, z: 0.9 };
        board.items = [
            { id: 'source', type: 'note', x: 0, y: 80, w: 120, h: 80, text: 'Source' },
            { id: 'target', type: 'shape', shape: 'rect', x: 440, y: 80, w: 120, h: 80, text: 'Target' },
            { id: 'connector', type: 'line', start: { id: 'source' }, end: { id: 'target' }, arrow: true, color: 'blue' },
            { id: 'plain-arrow', type: 'line', start: { x: 200, y: 30 }, end: { x: 320, y: 150 }, arrow: true },
            { id: 'colored-arrow', type: 'line', start: { x: 0, y: 230 }, end: { x: 320, y: 230 }, arrow: true, color: 'purple' },
            { id: 'selected-plain', type: 'line', start: { x: 0, y: 310 }, end: { x: 320, y: 310 }, arrow: true },
            { id: 'selected-colored', type: 'line', start: { x: 0, y: 390 }, end: { x: 320, y: 390 }, arrow: true, color: 'blue' },
            { id: 'plain-line', type: 'line', start: { x: 0, y: 440 }, end: { x: 320, y: 440 }, arrow: false },
        ];
        loadWorkspace(board);
        setSelection(['selected-plain', 'selected-colored']);
    }
    if (scene === 'style') {
        const board = structuredClone(window.layoutFixture.workspace);
        board.items = [{ id: 'styled-note', type: 'note', x: 100, y: 100, w: 220, h: 140, text: 'Selected note' }];
        loadWorkspace(board);
        setSelection(['styled-note']);
    }
    // WebKit can suspend transitions in an automation window. Measure the final style.
    if (!document.querySelector('#layout-still')) {
        const style = document.createElement('style');
        style.id = 'layout-still';
        style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;pointer-events:none!important;caret-color:transparent!important}';
        document.head.append(style);
    }
    document.activeElement?.blur();
    await document.fonts.ready;
    await new Promise(resolve => setTimeout(resolve, 100));
    const selectors = [
        '.sidebar', '.brand', '.workspace-badge', '.section-label', '.nav-item',
        '#profile-list', '.profile-button', '.search', '#search', '#outline',
        '.sidebar-bottom', '.plugin-card', '.local-label', '.topbar', '.board-heading',
        '.breadcrumb', '#workspace-name', '.top-actions', '#save-state', '#save',
        '#add-terminal', '.canvas-bar', '.bar-actions button', '#viewport',
        '.empty-eyebrow', '.empty-state h1', '.empty-state > p', '#empty-add',
        '.empty-features', '.canvas-toolbar', '.canvas-toolbar button',
        '.create-toolbar', '.create-toolbar button', '.style-toolbar',
        '.style-toolbar .swatch', '.style-toolbar .size-button', 'footer', '#launch-dialog',
        '.dialog-heading', '.eyebrow', 'h2', '.dialog-description', '.field-label',
        '#profile', '#terminal-title', '#cwd', '#command', '#browse-folder',
        '.field-hint', '.dialog-footer', '.dialog-footer button', '.icon-button',
        '.terminal-card', '.card-header', '.card-title', '.card-directory',
        '.terminal-placeholder .button', '.minimap', '.canvas-item',
    ];
    const rect = box => [box.x, box.y, box.width, box.height].map(n => Math.round(n * 1000) / 1000);
    const elements = {};
    for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((element, index) => {
            const style = getComputedStyle(element);
            if (!element.getClientRects().length || style.visibility === 'hidden') return;
            const box = element.getBoundingClientRect();
            if (!box.width || !box.height) return;
            elements[`${selector}[${index}]`] = {
                rect: rect(box), background: style.backgroundColor, color: style.color,
                icons: Array.from(element.children).flatMap(child => {
                    const svg = child.matches('svg') ? child : child.querySelector(':scope > svg');
                    return svg ? [rect(svg.getBoundingClientRect())] : [];
                }),
            };
        });
    }
    const count = selector => Object.keys(elements).filter(key => key.startsWith(selector + '[')).length;
    if (count('.create-toolbar button') !== 8) throw new Error('The eight creation controls were not captured');
    if (['board', 'style'].includes(scene) && count('.style-toolbar .swatch') !== 8) {
        throw new Error('The eight visible style colors were not captured');
    }
    if (scene === 'style' && count('.style-toolbar .size-button') !== 4) {
        throw new Error('The four visible text-size controls were not captured');
    }
    const colors = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = color => {
        colors.clearRect(0, 0, 1, 1); colors.fillStyle = color; colors.fillRect(0, 0, 1, 1);
        return Array.from(colors.getImageData(0, 0, 1, 1).data);
    };
    const lines = workspace.items.filter(item => item.type === 'line').map(item => {
        const view = itemViews.get(item.id), style = getComputedStyle(view.stroke);
        const selected = selection.has(item.id), groupStyle = getComputedStyle(view.element);
        const expectedColor = selected ? getComputedStyle(document.documentElement).getPropertyValue('--accent')
            : item.color ? groupStyle.getPropertyValue('--item-color') : '#8fa3b8';
        const headStyle = view.head && getComputedStyle(view.head);
        const { start, end } = linePoints(item), length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const ux = (end.x - start.x) / length, uy = (end.y - start.y) / length;
        // Inside the filled triangle, off the shaft: a missing fill cannot pass this pixel check.
        const x = end.x - 10 * ux - 3 * uy, y = end.y - 10 * uy + 3 * ux;
        const area = viewport.getBoundingClientRect(), camera = workspace.camera;
        return { id: item.id, arrow: item.arrow, selected, expected: rgba(expectedColor), stroke: rgba(style.stroke),
            strokeWidth: parseFloat(style.strokeWidth), pathHead: !!view.head,
            headVisible: headStyle ? headStyle.display !== 'none' && !!view.head.getAttribute('d') : !!view.stroke.getAttribute('marker-end'),
            headFill: headStyle?.fill, point: { x: area.left + camera.x + x * camera.z, y: area.top + camera.y + y * camera.z } };
    });
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, elements, lines,
        forcedColorsActive: matchMedia('(forced-colors: active)').matches };
};

window.sampleLayoutPixels = async function (dataURL, lines) {
    if (!lines.length) return [];
    const snapshot = new Image(); snapshot.src = dataURL; await snapshot.decode();
    const canvas = document.createElement('canvas'); canvas.width = snapshot.naturalWidth; canvas.height = snapshot.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(snapshot, 0, 0);
    return lines.filter(line => line.arrow).map(line => ({ id: line.id,
        rgba: Array.from(context.getImageData(Math.round(line.point.x * canvas.width / innerWidth),
            Math.round(line.point.y * canvas.height / innerHeight), 1, 1).data) }));
};

window.layoutArrowFillFault = function (enabled) {
    document.querySelector('#layout-arrow-fill-fault')?.remove();
    if (enabled) {
        const style = document.createElement('style'); style.id = 'layout-arrow-fill-fault';
        style.textContent = '.line-head{fill:none!important}'; document.head.append(style);
    }
};
void 0;
