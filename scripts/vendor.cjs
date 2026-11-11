/* Copies the pinned xterm.js files into src/vendor/, where the page loads them from. The Rust
   build does the same in src-tauri/build.rs; this keeps the Electron build working. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const FILES = [
    ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
    ['@xterm/xterm/css/xterm.css', 'xterm.css'],
    ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js']
];
function vendor() {
    const target = path.join(root, 'src', 'vendor');
    fs.mkdirSync(target, { recursive: true });
    for (const [source, name] of FILES) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(target, name));
}
if (require.main === module) vendor();
module.exports = { vendor, FILES };
