/* Shared by the Electron and WKWebView fixtures. No terminals or OS services run. */
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
        '.element-tools', '.element-tools button', 'footer', '#launch-dialog',
        '.dialog-heading', '.eyebrow', 'h2', '.dialog-description', '.field-label',
        '#profile', '#terminal-title', '#cwd', '#command', '#browse-folder',
        '.field-hint', '.dialog-footer', '.dialog-footer button', '.icon-button',
        '.terminal-card', '.card-header', '.card-title', '.card-directory',
        '.terminal-placeholder .button', '.minimap',
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
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, elements };
};
void 0;
