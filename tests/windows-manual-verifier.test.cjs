const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the Windows file verifier accepts reordered exports and rejects layout/image mismatches', {
    skip: process.platform !== 'win32' ? 'Requires native Windows PowerShell 5.1' : false
}, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-win11-verifier-'));
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden/host-workspace.json'), 'utf8')).portable;
    const first = path.join(folder, 'electron.terminalcanvas'), second = path.join(folder, 'rust.terminalcanvas');
    const verify = () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        path.join(__dirname, 'manual/verify-windows-files.ps1'), '-ElectronExport', first, '-RustExport', second],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
    try {
        fs.writeFileSync(first, JSON.stringify(fixture));
        fs.writeFileSync(second, JSON.stringify(Object.fromEntries(Object.entries(fixture).reverse())));
        const equal = verify(); assert.ifError(equal.error); assert.equal(equal.status, 0, equal.stderr);
        assert.equal(JSON.parse(equal.stdout).imageBytesMatch, true);
        const changed = structuredClone(fixture); changed.items[0].text = 'Different layout';
        fs.writeFileSync(second, JSON.stringify(changed)); assert.notEqual(verify().status, 0);
        changed.items = fixture.items; changed.assets[Object.keys(changed.assets)[0]] = 'data:image/png;base64,AAAA';
        fs.writeFileSync(second, JSON.stringify(changed)); assert.notEqual(verify().status, 0);
        fs.writeFileSync(first, JSON.stringify({ ...fixture, assets: {} }));
        fs.writeFileSync(second, JSON.stringify({ ...fixture, assets: {} })); assert.notEqual(verify().status, 0);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
