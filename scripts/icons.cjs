const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Rasterize the actual logo with Chromium so native icons share its geometry.
async function render() {
    const { app, BrowserWindow } = require('electron');
    app.enableSandbox();
    await app.whenReady();
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
        await win.loadURL('data:text/html,<html></html>');
        const assets = path.resolve(__dirname, '../src/assets');
        const svg = await fs.readFile(path.join(assets, 'logo.svg'));
        const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512];
        const images = await win.webContents.executeJavaScript(`(async () => {
            const image = new Image();
            image.src = ${JSON.stringify(`data:image/svg+xml;base64,${svg.toString('base64')}`)};
            await image.decode();
            return ${JSON.stringify(sizes)}.map(size => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = size;
                canvas.getContext('2d').drawImage(image, 0, 0, size, size);
                return canvas.toDataURL('image/png').split(',')[1];
            });
        })()`);
        const pngs = images.map(image => Buffer.from(image, 'base64'));
        const frames = pngs.slice(0, -1);
        const directory = Buffer.alloc(6 + frames.length * 16);
        directory.writeUInt16LE(1, 2);
        directory.writeUInt16LE(frames.length, 4);
        let offset = directory.length;
        frames.forEach((png, index) => {
            const entry = 6 + index * 16;
            directory[entry] = directory[entry + 1] = sizes[index] % 256;
            directory.writeUInt16LE(1, entry + 4);
            directory.writeUInt16LE(32, entry + 6);
            directory.writeUInt32LE(png.length, entry + 8);
            directory.writeUInt32LE(offset, entry + 12);
            offset += png.length;
        });
        const outputs = { 'icon.png': pngs.at(-1), 'icon.ico': Buffer.concat([directory, ...frames]) };
        for (const [name, contents] of Object.entries(outputs)) {
            const file = path.join(assets, name);
            if (process.argv.includes('--check')) {
                if (!(await fs.readFile(file)).equals(contents)) throw new Error(`${name} differs from logo.svg; run npm run icons.`);
            } else await fs.writeFile(file, contents);
        }
        console.log(process.argv.includes('--check') ? 'Native icons match logo.svg.' : 'Generated native icons from logo.svg.');
    } finally { win.destroy(); app.quit(); }
}

if (process.versions.electron) {
    render().catch(error => { console.error(error); require('electron').app.exit(1); });
} else {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
}
