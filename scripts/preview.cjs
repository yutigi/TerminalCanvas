// Layout preview only. This server exposes static assets, never terminal access.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PROFILES, createWorkspace } = require('../src/workspace.cjs');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const previewBridge = `
const profiles = ${JSON.stringify(PROFILES)};
const empty = ${JSON.stringify(createWorkspace())};
window.terminalCanvas = {
    async invoke(action, payload) {
        if (action === 'initialize') {
            let workspace = structuredClone(empty);
            try { workspace = JSON.parse(localStorage.getItem('terminal-canvas-preview')) || workspace; } catch {}
            return { workspace, profiles, home: '', preview: true };
        }
        if (action === 'create-card') {
            return { card: { ...payload, id: crypto.randomUUID(), type: 'terminal', w: 660, h: 430 } };
        }
        if (action === 'autosave') { localStorage.setItem('terminal-canvas-preview', JSON.stringify(payload)); return { ok: true }; }
        if (action === 'new') return { workspace: structuredClone(empty) };
        if (action === 'stop') return { ok: true };
        return { error: 'This feature requires the desktop app. Run npm install, npm run rebuild, then npm start.' };
    },
    onEvent() { return () => {}; }, input() {}, resize() {}, acknowledge() {}
};`;
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/preview-bridge.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(previewBridge); }
        const pathname = decodeURIComponent(url.pathname === '/' ? '/src/index.html' : url.pathname);
        const file = path.resolve(root, '.' + pathname);
        const allowed = file.startsWith(path.join(root, 'src') + path.sep) || file.startsWith(path.join(root, 'node_modules/@xterm') + path.sep);
        if (!allowed || !mime[path.extname(file)] || /\.(?:cjs)$/.test(file)) { res.writeHead(404); return res.end('Not found'); }
        let content = await fs.readFile(file);
        if (file === path.join(root, 'src/index.html')) {
            content = content.toString().replace('<script src="./renderer.js"', '<script src="/preview-bridge.js" defer></script><script src="./renderer.js"');
            // The root URL needs a base for the same relative assets as file:// desktop.
            content = content.replace('<meta charset="UTF-8">', '<meta charset="UTF-8"><base href="/src/">').replace("base-uri 'none'", "base-uri 'self'");
        }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
        res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(Number(process.env.PORT || 4174), '127.0.0.1', () => console.log(`Terminal Canvas layout preview: http://127.0.0.1:${server.address().port}\nLive interactive terminals require npm start.`));
