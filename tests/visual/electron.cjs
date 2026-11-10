const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [source, output, label] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(output, 'reference.json')));
app.setPath('userData', path.join(output, 'electron-profile'));
app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true,
        webPreferences: { preload: path.join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const report = { engine: process.versions, scenes: {} };
    for (const [width, height] of config.viewports) {
        win.setContentSize(width, height);
        await win.loadFile(path.join(source, 'src/index.html'));
        await win.webContents.executeJavaScript(fs.readFileSync(path.join(output, 'probe.js'), 'utf8'));
        for (const scene of ['empty', 'launch', 'card']) {
            const key = `${width}x${height}-${scene}`;
            report.scenes[key] = await win.webContents.executeJavaScript(`window.captureLayout('${scene}')`);
            fs.writeFileSync(path.join(output, `${label}-${key}.png`), (await win.webContents.capturePage()).toPNG());
        }
    }
    fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
