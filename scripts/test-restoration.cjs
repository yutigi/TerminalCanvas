const { spawnSync } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const phase of ['save', 'reopen']) {
    const result = spawnSync(electron, [path.resolve(__dirname, '..'), `--restoration-smoke=${phase}`], { env, stdio: 'inherit', windowsHide: true, timeout: 45000 });
    if (result.status !== 0) { console.error(result.error?.message || `Restoration smoke ${phase} failed (exit ${result.status}, signal ${result.signal}).`); process.exit(result.status || 1); }
}
