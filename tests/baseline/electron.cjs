/* Test-only bootstrap around the untouched, pinned JavaScript host. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, clipboard } = require('electron');
const { guardRestorationEnvironment } = require('./support.cjs');
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
        args = ['-NoProfile', ...args];
    }
    const terminal = nativeSpawn(shell, args, options);
    if (mode === 'save' || mode === 'reopen') {
        // These profiles contain only generated fixture commands and local stand-ins.
        // Preserve control bytes in JSON so a failed Unicode cd can be diagnosed.
        terminal.onData(data => console.error('BASELINE_RESTORATION_OUTPUT', JSON.stringify(data)));
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
            const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process);
$ids=[Collections.Generic.HashSet[int]]::new(); ${seeds.map(pid => `[void]$ids.Add(${pid})`).join('; ')};
$observer=[Collections.Generic.HashSet[int]]::new(); [void]$observer.Add($PID);
do { $added=$false; foreach($p in $all) {
    if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true }
    if($observer.Contains([int]$p.ParentProcessId) -and $observer.Add([int]$p.ProcessId)) { $added=$true }
} } while($added);
@($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and -not $observer.Contains([int]$_.ProcessId) } | ForEach-Object {
    $p=Get-Process -Id $_.ProcessId -ErrorAction Stop;
    [pscustomobject]@{ pid=$p.Id; name=$p.ProcessName; privateBytes=$p.PrivateMemorySize64; workingSetBytes=$p.WorkingSet64 }
}) | ConvertTo-Json -Compress`;
            const snapshot = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
                { encoding: 'utf8', timeout: 30000, windowsHide: true });
            assert.ifError(snapshot.error);
            assert.equal(snapshot.status, 0, snapshot.stderr);
            const processes = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, ''));
            assert.ok(Array.isArray(processes) && processes.length >= 5, 'The native process tree must include the host and four shells');
            for (const pid of shells) assert.ok(processes.some(process => process.pid === pid), `Missing shell ${pid}`);
            samples.push({ processes, privateBytes: processes.reduce((sum, process) => sum + process.privateBytes, 0),
                workingSetBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0) });
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ startupMs, shells, samples }, null, 2));
        fs.writeFileSync(path.join(output, 'idle.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('void invoke("close", workspace)');
    }
}
require(path.join(reference, 'src/main.cjs'));
