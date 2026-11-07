const { spawn } = require('node:child_process');
const path = require('node:path');
let electron;
try { electron = require('electron'); }
catch { console.error('Dependencies are missing. Run npm install, then npm run rebuild.'); process.exit(1); }
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.resolve(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
