/* Test-only bootstrap around the untouched, pinned JavaScript host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, clipboard } = require('electron');
const { guardRestorationEnvironment, baselineShellInput, isolatePowerShellArguments } = require('./support.cjs');
const { sampleProcessTree } = require('./memory.cjs');
const [reference, output, mode] = process.argv.slice(2);
assert.equal(process.platform, 'win32', 'The baseline requires native Windows');
assert.ok(['smoke', 'save', 'reopen', 'measure'].includes(mode));
const pty = require(path.join(reference, 'node_modules/node-pty'));
const nativeSpawn = pty.spawn;
pty.spawn = (shell, args, options) => {
    if (mode === 'save' || mode === 'reopen') {
        guardRestorationEnvironment(options.env, path.join(reference, '.cache/restoration-project/tools'));
    }
    // Both native test hosts skip profiles; a profile must not replace the guarded PATH.
    if (/^(?:powershell|pwsh)(?:\.exe)?$/i.test(path.basename(shell))) {
        args = isolatePowerShellArguments(args);
    }
    const terminal = nativeSpawn(shell, args, options);
    if (mode === 'save' || mode === 'reopen') {
        // These profiles contain only generated fixture commands and local stand-ins.
        // Preserve control bytes in JSON so a failed Unicode cd can be diagnosed.
        terminal.onData(data => console.error('BASELINE_RESTORATION_OUTPUT', JSON.stringify(data)));
        const write = terminal.write;
        terminal.write = function (data) { return write.call(this, baselineShellInput(data)); };
    }
    return terminal;
};

if (mode === 'smoke') {
    assert.equal(process.env.TC_BASELINE_CLIPBOARD_GUARDED, '1', 'Native smoke requires the external clipboard guard');
    const smoke = require(path.join(reference, 'scripts/smoke.cjs'));
    const originalRun = smoke.run;
    smoke.run = async options => {
        // The original clipboard fixture cannot construct a ClipboardItem for an
        // empty native item. Give that unchanged fixture a controlled text item.
        await clipboard.writeText('Terminal Canvas baseline clipboard fixture');
        // Windows can clamp the initial BrowserWindow to the hosted display.
        // Reapply the original app's requested outer size for its fixed native fixtures.
        options.win.setSize(1500, 960);
        assert.deepEqual(options.win.getSize(), [1500, 960]);
        const contents = options.win.webContents;
        const sendInput = contents.sendInputEvent;
        let point;
        contents.sendInputEvent = function (event) {
            if (Number.isFinite(event.x) && Number.isFinite(event.y)) point = { x: event.x, y: event.y, type: event.type };
            return sendInput.call(this, event);
        };
        try { return await originalRun(options); }
        catch (error) {
            try {
                const diagnostics = await contents.executeJavaScript(`(() => {
                    const point = ${JSON.stringify(point || null)}, hit = point && document.elementFromPoint(point.x, point.y);
                    const rect = element => element && JSON.parse(JSON.stringify(element.getBoundingClientRect()));
                    return { workspace: workspace.name, width: innerWidth, height: innerHeight, focused: document.hasFocus(), point,
                        hit: hit && { tag: hit.tagName, className: String(hit.className), tool: hit.closest('[data-tool]')?.dataset.tool },
                        createToolbar: rect(document.querySelector('.create-toolbar')),
                        terminalScreen: rect(document.querySelector('.xterm-screen')) };
                })()`);
                console.error('BASELINE_SMOKE_DIAGNOSTICS', JSON.stringify(diagnostics));
                fs.writeFileSync(path.join(output, 'smoke-failure.png'), (await contents.capturePage()).toPNG());
            } catch (captureError) { console.error('Baseline failure capture:', captureError.message); }
            throw error;
        } finally { contents.sendInputEvent = sendInput; }
    };
}

if (mode === 'measure') {
    if (process.env.TC_BENCHMARK_PORT) {
        app.commandLine.appendSwitch('remote-debugging-port', process.env.TC_BENCHMARK_PORT);
        app.commandLine.appendSwitch('disable-background-timer-throttling');
        app.commandLine.appendSwitch('disable-renderer-backgrounding');
    }
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.join(output, 'profile'), { recursive: true });
    app.setPath('userData', path.join(output, 'profile'));
    const module = require(path.join(reference, 'src/terminal-manager.cjs'));
    const Original = module.TerminalManager;
    let manager;
    module.TerminalManager = class extends Original {
        constructor(options) { super(options); manager = this; }
    };
    const wait = async (check, message) => {
        const deadline = Date.now() + 60000;
        while (!await check()) {
            if (Date.now() > deadline) throw new Error(message);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    };
    app.once('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', () => measure(win).catch(error => {
            console.error(error); manager?.stopAll(); app.exit(1);
        }));
    });
    async function measure(win) {
        await wait(() => win.webContents.executeJavaScript('typeof ready !== "undefined" && ready'), 'The reference renderer did not initialize');
        const startupMs = Date.now() - Number(process.env.TC_BASELINE_SPAWN_MS);
        if (process.env.TC_BENCHMARK_PORT) {
            // Observe the empty, ready workspace before either benchmark starts
            // its four shells, avoiding asymmetric startup CPU contention.
            await wait(() => fs.existsSync(path.join(output, 'observer-ready')), 'The external startup observer did not acknowledge readiness');
        }
        const { createWorkspace, createCard } = require(path.join(reference, 'src/workspace.cjs'));
        const cwd = fs.realpathSync.native(output);
        const board = createWorkspace();
        board.cards = Array.from({ length: 4 }, (_, index) => createCard({ profile: 'shell', command: '',
            title: `Idle PowerShell ${index + 1}`, cwd, x: (index % 2) * 670, y: Math.floor(index / 2) * 430 }));
        await win.webContents.executeJavaScript(`loadWorkspace(${JSON.stringify(board)}); (async () => {
            for (const card of workspace.cards) await start(card, 'start');
        })()`);
        await wait(() => manager.sessions.size === 4 && [...manager.sessions.values()].every(entry => entry.ready),
            'Four idle PowerShell prompts did not become ready');
        await new Promise(resolve => setTimeout(resolve, 1000));
        const shells = [...manager.sessions.values()].map(entry => entry.terminal.pid);
        assert.equal(new Set(shells).size, 4);
        const seeds = [...new Set([process.pid, ...app.getAppMetrics().map(entry => entry.pid), ...shells])];
        const samples = [];
        for (let index = 0; index < 3; index++) {
            const sample = sampleProcessTree(seeds);
            assert.ok(sample.processes.length >= 5, 'The native tree must include the host and four shells');
            for (const pid of [process.pid, ...shells]) assert.ok(sample.processes.some(process => process.pid === pid), `Missing required process ${pid}`);
            samples.push(sample);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ startupMs, shells, samples,
            outerSize: win.getSize(), contentSize: win.getContentSize() }, null, 2));
        fs.writeFileSync(path.join(output, 'idle.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('void invoke("close", workspace)');
    }
}
require(path.join(reference, 'src/main.cjs'));
