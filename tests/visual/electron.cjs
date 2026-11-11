const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [source, output, label] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(output, 'reference.json')));
app.setPath('userData', path.join(output, 'electron-profile'));
app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, enableLargerThanScreen: true,
        webPreferences: { preload: path.join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const report = { engine: process.versions, scenes: {}, forcedColors: {}, negativeArrowFill: {} };
    const capture = async (scene, key, width, height) => {
        const metrics = await win.webContents.executeJavaScript(
            `window.waitForLayoutViewport(${width}, ${height}).then(() => window.captureLayout(${JSON.stringify(scene)}))`);
        const snapshot = await win.webContents.capturePage();
        metrics.pixels = await win.webContents.executeJavaScript(
            `window.sampleLayoutPixels(${JSON.stringify(snapshot.toDataURL())}, ${JSON.stringify(metrics.lines)})`);
        fs.writeFileSync(path.join(output, `${label}-${key}.png`), snapshot.toPNG());
        return metrics;
    };
    if (label === 'chromium') win.webContents.debugger.attach('1.3');
    for (const [width, height] of config.viewports) {
        win.setContentSize(width, height);
        await win.loadFile(path.join(source, 'src/index.html'));
        await win.webContents.executeJavaScript(fs.readFileSync(path.join(output, 'probe.js'), 'utf8'));
        for (const scene of config.scenes) {
            const key = `${width}x${height}-${scene}`;
            report.scenes[key] = await capture(scene, key, width, height);
            if (scene === 'board' && label === 'chromium') {
                await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
                    features: [{ name: 'forced-colors', value: 'active' }],
                });
                report.forcedColors[key] = await capture(scene, 'forced-colors-' + key, width, height);
                await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
                if (config.verifyRegression) {
                    await win.webContents.executeJavaScript('window.layoutArrowFillFault(true)');
                    report.negativeArrowFill[key] = await capture(scene, 'missing-fill-' + key, width, height);
                    await win.webContents.executeJavaScript('window.layoutArrowFillFault(false)');
                }
            }
        }
    }
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(report, null, 2) + '\n');
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
