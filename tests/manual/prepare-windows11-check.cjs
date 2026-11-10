/* Prepare disposable compatibility input; no app or provider process is started. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, '.cache/windows11-check-kit');
fs.mkdirSync(output);
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/host-workspace.json'), 'utf8')).portable;
fixture.name = 'Windows 11 migration fixture';
fixture.camera = { x: 40, y: 30, z: .65 };
fixture.cards[0] = { ...fixture.cards[0], profile: 'shell', title: 'Stopped compatibility shell', command: '', cwd: '' };
delete fixture.cards[0].session;
fs.writeFileSync(path.join(output, 'image-workspace.terminalcanvas'), JSON.stringify(fixture, null, 2) + '\n');
for (const [source, target] of [['windows11-checklist.md', 'README.md'], ['verify-windows-files.ps1', 'verify-windows-files.ps1']]) {
    fs.copyFileSync(path.join(__dirname, source), path.join(output, target));
}
console.log(output);
