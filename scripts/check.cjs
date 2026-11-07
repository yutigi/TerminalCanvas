const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const folder of ['src', 'scripts', 'tests']) {
    for (const file of fs.readdirSync(path.join(root, folder), { recursive: true })) {
        if (!/\.(?:cjs|mjs|js)$/.test(file)) continue;
        const result = spawnSync(process.execPath, ['--check', path.join(root, folder, file)], { stdio: 'inherit', windowsHide: true });
        if (result.status !== 0) process.exit(result.status || 1);
    }
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
console.log('JavaScript syntax and package.json checks passed.');
