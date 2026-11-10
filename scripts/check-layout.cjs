/* Render the immutable pre-migration UI in Electron, then compare current Electron/WebKit. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compare } = require('../tests/visual/compare.cjs');
const { arrowPaintFailures, reportArrowFailures, forcedColorsFailures } = require('../tests/visual/arrow-paint.cjs');

const root = path.resolve(__dirname, '..');
const harness = path.join(root, 'tests/visual');
const config = JSON.parse(fs.readFileSync(path.join(harness, 'reference.json')));
const output = path.join(root, '.cache/layout-check');
const reference = path.join(output, 'reference');
const arg = process.argv.find(value => value.startsWith('--electron='));
const repositoryArg = process.argv.find(value => value.startsWith('--reference-repo='));
const repository = repositoryArg ? path.resolve(repositoryArg.slice('--reference-repo='.length)) : root;
if (process.platform !== 'darwin') throw new Error('This cross-engine check requires macOS WebKit and Xcode command line tools.');
const testElectron = path.join(harness, 'node_modules/electron');
const electron = arg ? path.resolve(arg.slice('--electron='.length))
    : require(fs.existsSync(testElectron) ? testElectron : 'electron');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', timeout: 60000, ...options });

fs.mkdirSync(output, { recursive: true });
fs.rmSync(reference, { recursive: true, force: true });
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', config.commit, 'src'], { cwd: repository, encoding: 'utf8' }).trim().split('\n');
for (const file of files) {
    if (file.endsWith('.cjs')) continue;
    const target = path.join(reference, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync('git', ['show', `${config.commit}:${file}`], { cwd: repository }));
}
// The historical HTML points into node_modules. Supply just the same pinned xterm files.
for (const [vendored, original] of [
    ['xterm.js', '@xterm/xterm/lib/xterm.js'],
    ['xterm.css', '@xterm/xterm/css/xterm.css'],
    ['addon-fit.js', '@xterm/addon-fit/lib/addon-fit.js'],
]) {
    const target = path.join(reference, 'node_modules', original);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const vendor = path.join(root, 'src/vendor', vendored);
    fs.copyFileSync(fs.existsSync(vendor) ? vendor : path.join(root, 'node_modules', original), target);
}
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/golden/renderer.json')));
const mock = `window.layoutFixture = ${JSON.stringify(fixture)};
window.terminalCanvas = {
    invoke: async action => action === 'initialize' ? { ...window.layoutFixture, platform: 'darwin', home: '/tmp' } : { ok: true },
    input() {}, resize() {}, acknowledge() {}, onEvent() {}
};`;
fs.writeFileSync(path.join(output, 'mock.js'), mock);
fs.writeFileSync(path.join(output, 'preload.cjs'), `const { contextBridge } = require('electron');
const fixture = ${JSON.stringify(fixture)};
contextBridge.exposeInMainWorld('layoutFixture', fixture);
contextBridge.exposeInMainWorld('terminalCanvas', {
    invoke: async action => action === 'initialize' ? { ...fixture, platform: 'darwin', home: '/tmp' } : { ok: true },
    input() {}, resize() {}, acknowledge() {}, onEvent() {}
});`);
fs.copyFileSync(path.join(harness, 'probe.js'), path.join(output, 'probe.js'));
fs.writeFileSync(path.join(output, 'reference.json'), JSON.stringify({ ...config,
    verifyRegression: process.argv.includes('--verify-regression') }, null, 4) + '\n');
run('xcrun', ['swiftc', '-module-cache-path', path.join(output, 'swift-module-cache'), path.join(harness, 'webkit.swift'), '-o', path.join(output, 'webkit')]);
console.log(`Rendering previous JavaScript UI: ${config.commit}`);
run(electron, [path.join(harness, 'electron.cjs'), reference, output, 'legacy']);
run(electron, [path.join(harness, 'electron.cjs'), root, output, 'chromium']);
run(path.join(output, 'webkit'), [root, output, 'webkit']);
const read = name => JSON.parse(fs.readFileSync(path.join(output, `${name}.json`)));
for (const name of ['legacy', 'chromium', 'webkit']) {
    for (const [width, height] of config.viewports) {
        for (const scene of config.scenes) {
            const captured = read(name).scenes[`${width}x${height}-${scene}`];
            if (captured?.width !== width || captured?.height !== height) {
                throw new Error(`${name} did not retain requested viewport ${width}x${height} for ${scene}`);
            }
        }
    }
}
const failures = [
    ...compare(read('legacy'), read('chromium'), config.legacyTolerance).map(message => `Legacy: ${message}`),
    ...compare(read('chromium'), read('webkit'), config.engineTolerance).map(message => `WebKit: ${message}`),
    ...reportArrowFailures(read('legacy'), { requirePath: false }).map(message => `Legacy paint: ${message}`),
    ...reportArrowFailures(read('chromium')).map(message => `Chromium paint: ${message}`),
    ...reportArrowFailures(read('webkit')).map(message => `WebKit paint: ${message}`),
    ...forcedColorsFailures(read('chromium')),
];
let regressionDifferences;
const arrowFillRegressionDifferences = {};
if (process.argv.includes('--verify-regression')) {
    console.log('Checking that the original WebKit shift is detected…');
    run(path.join(output, 'webkit'), [reference, output, 'unfixed']);
    regressionDifferences = compare(read('legacy'), read('unfixed'), config.engineTolerance).length;
    if (!regressionDifferences) {
        failures.push('The negative control did not detect the original WebKit layout shift.');
    }
    for (const engine of ['chromium', 'webkit']) {
        const broken = Object.entries(read(engine).negativeArrowFill || {});
        if (broken.length !== config.viewports.length) failures.push(`${engine}: missing arrow-fill negative controls`);
        const differences = broken.flatMap(([name, scene]) => arrowPaintFailures(scene, `${engine} ${name} missing fill`));
        arrowFillRegressionDifferences[engine] = differences.length;
        if (!differences.length) failures.push(`${engine}: the pixel guard did not detect missing arrowhead fill`);
    }
}
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ reference: config.commit, platform: process.platform,
    electron: read('legacy').engine.electron, chrome: read('legacy').engine.chrome,
    viewports: config.viewports, scenes: config.scenes, regressionDifferences, arrowFillRegressionDifferences,
    forcedColorsScenes: Object.keys(read('chromium').forcedColors).length, failures }, null, 2) + '\n');
if (failures.length) throw new Error(`${failures.length} layout differences:\n${failures.slice(0, 24).join('\n')}\nSee ${output}`);
console.log(`Layout parity passed: ${config.viewports.length * config.scenes.length} scenes; previous UI within ${config.legacyTolerance}px, Chromium/WebKit within ${config.engineTolerance}px. Arrowhead pixels and forced colors passed.\nScreenshots and measurements: ${output}`);
