/* Native Phase 0 evidence from the immutable pre-migration host, never the working tree host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { testSummary } = require('../tests/baseline/support.cjs');
const { withSavedClipboard } = require('../tests/baseline/clipboard.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.cache/windows-baseline');
const reference = path.join(output, 'reference');
const bootstrap = path.join(root, 'tests/baseline/electron.cjs');
const report = { schema: 1, status: 'incomplete', capturedAt: new Date().toISOString(),
    reference: require('../tests/visual/reference.json').commit,
    platform: { os: os.release(), arch: os.arch(), cpus: os.cpus().map(cpu => cpu.model), totalMemoryBytes: os.totalmem(), node: process.version },
    configuration: 'Unpackaged development host; isolated profiles; PowerShell -NoProfile; controlled text clipboard with external native restoration; no provider calls',
    measurements: 'Startup: process spawn to renderer ready. Memory: three native process-tree samples after four idle prompts; private commit and summed working sets (shared pages may be counted more than once). No OS cache flush.',
    stages: {} };
let ownsOutput = false;
const save = () => { if (ownsOutput) fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };

async function run(name, executable, args, { cwd = reference, timeout = 120000, env = {} } = {}) {
    console.log(`Baseline: ${name}`);
    const log = path.join(output, `${name}.log`);
    const stream = fs.createWriteStream(log);
    const childEnv = { ...process.env, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (Object.hasOwn(env, 'TC_BASELINE_SPAWN_MS')) childEnv.TC_BASELINE_SPAWN_MS = String(Date.now());
    const child = spawn(executable, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        // These are exclusively this script's test processes and descendants.
        if (child.pid) spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }, timeout);
    let result;
    try { result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
    finally { clearTimeout(timer); await new Promise(resolve => stream.end(resolve)); }
    report.stages[name] = { ...result, timedOut, log: path.basename(log) }; save();
    assert.ok(!timedOut && result.code === 0, `${name} failed; see ${log}`);
    return fs.readFileSync(log, 'utf8');
}

function size(folder) {
    return fs.readdirSync(folder, { withFileTypes: true }).reduce((bytes, entry) => {
        const file = path.join(folder, entry.name);
        assert.ok(!entry.isSymbolicLink(), `Unexpected link in packaged app: ${file}`);
        return bytes + (entry.isDirectory() ? size(file) : fs.statSync(file).size);
    }, 0);
}

async function main() {
    assert.equal(process.platform, 'win32', 'Capture the baseline on native Windows');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(output); ownsOutput = true; save();
    await run('archive', 'git', ['archive', '--format=tar', `--output=${path.join(output, 'reference.tar')}`, report.reference], { cwd: root });
    fs.mkdirSync(reference);
    await run('extract', 'tar.exe', ['-xf', path.join(output, 'reference.tar'), '-C', reference], { cwd: root });
    // Track the original host and test source bytes before npm prepares generated dependencies.
    const sources = new Map();
    const collect = folder => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) collect(file);
            else sources.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
        }
    };
    for (const folder of ['src', 'scripts', 'tests']) collect(path.join(reference, folder));
    for (const name of ['package.json', 'package-lock.json']) {
        const file = path.join(reference, name);
        sources.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    }
    await run('install', 'cmd.exe', ['/d', '/s', '/c', 'npm ci'], { timeout: 600000 });
    await run('native-pty', process.execPath, ['scripts/rebuild.cjs'], { timeout: 600000 });
    const tests = fs.readdirSync(path.join(reference, 'tests')).filter(name => name.endsWith('.test.cjs')).map(name => path.join('tests', name));
    report.tests = testSummary(await run('tests', process.execPath, ['--test', '--test-reporter=tap', ...tests])); save();
    const electron = require(path.join(reference, 'node_modules/electron'));
    await withSavedClipboard(() => run('smoke', electron, [bootstrap, reference, output, 'smoke', '--smoke-test'],
        { timeout: 600000, env: { TC_BASELINE_CLIPBOARD_GUARDED: '1' } }), path.join(output, 'clipboard-guard.log'));
    report.smokeClipboardRestored = true; save();
    for (const phase of ['save', 'reopen']) {
        await run(`restoration-${phase}`, electron, [bootstrap, reference, output, phase, `--restoration-smoke=${phase}`], { timeout: 120000 });
    }
    report.runs = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
        const folder = path.join(output, `measure-${attempt}`);
        await run(`measure-${attempt}`, electron, [bootstrap, reference, folder, 'measure'],
            { timeout: 120000, env: { TC_BASELINE_SPAWN_MS: String(Date.now()) } });
        const metrics = JSON.parse(fs.readFileSync(path.join(folder, 'metrics.json'), 'utf8'));
        assert.ok(metrics.startupMs > 0 && metrics.startupMs < 60000, 'Startup timing must reach a ready renderer');
        fs.copyFileSync(path.join(folder, 'idle.png'), path.join(output, `idle-${attempt}.png`));
        const gone = await run(`cleanup-${attempt}`, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$alive=@(${metrics.shells.join(',')}) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }; if($alive) { throw 'Idle benchmark shells outlived normal host shutdown' }; 'All four shells ended'`]);
        assert.ok(gone.includes('All four shells ended'));
        report.runs.push(metrics); save();
    }
    await run('package', 'cmd.exe', ['/d', '/s', '/c', 'npm run build -- --publish never'],
        { timeout: 1200000, env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    const release = path.join(reference, 'release');
    const portable = fs.readdirSync(release).filter(name => name.endsWith('.exe'));
    assert.equal(portable.length, 1, 'Expected the single original portable artifact');
    report.package = { portable: portable[0], portableBytes: fs.statSync(path.join(release, portable[0])).size,
        unpackedAppBytes: size(path.join(release, 'win-unpacked')) };
    for (const [file, hash] of sources) {
        assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash,
            `The captured reference source was modified: ${path.relative(reference, file)}`);
    }
    report.referenceSourceFiles = sources.size;
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    report.medians = { startupMs: median(report.runs.map(run => run.startupMs)),
        privateBytes: median(report.runs.flatMap(run => run.samples.map(sample => sample.privateBytes))),
        workingSetBytes: median(report.runs.flatMap(run => run.samples.map(sample => sample.workingSetBytes))) };
    report.status = 'passed'; save();
    copyScreenshots();
    console.log(`Windows reference baseline captured: ${path.join(output, 'report.json')}`);
}
function copyScreenshots() {
    const cache = path.join(reference, '.cache');
    if (!fs.existsSync(cache)) return;
    const visit = folder => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
            const file = path.join(folder, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && entry.name.endsWith('.png')) {
                fs.copyFileSync(file, path.join(output, 'reference-' + path.relative(cache, file).replace(/[\\/]/g, '-')));
            }
        }
    };
    visit(cache);
}
main().catch(error => {
    report.status = 'failed'; report.error = error.message; save();
    if (ownsOutput) { try { copyScreenshots(); } catch (copyError) { console.error(copyError); } }
    console.error(error); process.exitCode = 1;
});
