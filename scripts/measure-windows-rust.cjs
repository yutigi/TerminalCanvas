/* Paired development-host measurements, on the same runner as the original baseline. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launch, until, root } = require('../tests/e2e/harness.cjs');
const { sampleProcessTree } = require('../tests/baseline/memory.cjs');
const output = path.join(root, '.cache/windows-baseline');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function main() {
    assert.equal(process.platform, 'win32', 'This measurement requires native Windows');
    const reference = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
    assert.equal(reference.status, 'passed');
    assert.equal(reference.harnessCommit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    assert.ok(reference.measurementProtocol, 'Capture the reference with --compare-rust for the shared readiness observer');
    const report = { schema: 1, status: 'incomplete', source: reference.harnessCommit,
        reference: reference.reference, platform: reference.platform, protocol: reference.measurementProtocol,
        configuration: 'Rust debug/e2e and original unpackaged Electron; matched content viewport, four idle PowerShell shells, no profiles/history/prediction, no OS cache flush. Development instrumentation is included; these are not release startup figures.',
        runs: [], referenceMedians: reference.medians };
    const target = path.join(output, 'comparison.json');
    const save = () => fs.writeFile(target, JSON.stringify(report, null, 2) + '\n');
    await save();
    try {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const host = await launch({ clean: true });
            let shells = [], code;
            try {
                const contentSize = await host.page.evaluate(() => [innerWidth, innerHeight]);
                assert.deepEqual(contentSize, reference.runs[0].contentSize, 'Both hosts must render the same viewport');
                const folder = path.join(output, `rust-measure-${attempt}`); await fs.mkdir(folder);
                const cwd = await fs.realpath(folder);
                const cards = await host.page.evaluate(async cwd => {
                    const board = (await invoke('new')).workspace;
                    for (let index = 0; index < 4; index++) {
                        const { card } = await invoke('create-card', { profile: 'shell', command: '', cwd,
                            title: `Idle PowerShell ${index + 1}`, x: (index % 2) * 670, y: Math.floor(index / 2) * 430 });
                        board.cards.push(card);
                    }
                    loadWorkspace(board);
                    for (const card of workspace.cards) await start(card, 'start');
                    return workspace.cards;
                }, cwd);
                await until(async () => {
                    const choices = await host.page.evaluate(cards => Promise.all(cards.map(card => invoke('duplicate-directory', card))), cards);
                    return choices.every(choice => !choice.warning);
                }, 'Four idle Rust-host PowerShell prompts did not become ready.', 60000);
                await new Promise(resolve => setTimeout(resolve, 1000));
                const state = await host.state();
                assert.equal(state.host.running, 4);
                shells = state.host.terminals.map(terminal => terminal.pid);
                assert.equal(new Set(shells).size, 4);
                const browserSession = await host.page.context().browser().newBrowserCDPSession();
                const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
                await browserSession.detach();
                const browserPids = processInfo.map(process => Number(process.id));
                const samples = [];
                for (let index = 0; index < 3; index++) {
                    const sample = sampleProcessTree([...new Set([host.child.pid, ...shells, ...browserPids])]);
                    for (const pid of [host.child.pid, ...shells]) assert.ok(sample.processes.some(process => process.pid === pid), `Missing required process ${pid}`);
                    assert.ok(sample.processes.some(process => process.name.toLowerCase() === 'msedgewebview2'), 'The WebView2 browser processes must be measured');
                    samples.push(sample);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                await host.page.screenshot({ path: path.join(output, `rust-idle-${attempt}.png`) });
                report.runs.push({ startupMs: host.startupMs, contentSize, shells, samples });
                await host.page.evaluate(() => { void invoke('close', workspace); });
                code = await host.waitExit();
                assert.equal(code, 0, 'The measured Rust host must close normally');
            } finally { await host.dispose(); }
            for (const pid of shells) assert.ok(!alive(pid), `Measured shell ${pid} outlived host shutdown`);
            await save();
        }
        report.medians = { startupMs: median(report.runs.map(run => run.startupMs)),
            privateBytes: median(report.runs.flatMap(run => run.samples.map(sample => sample.privateBytes))),
            workingSetBytes: median(report.runs.flatMap(run => run.samples.map(sample => sample.workingSetBytes))) };
        report.ratios = Object.fromEntries(Object.entries(report.medians).map(([name, value]) => [name, value / reference.medians[name]]));
        report.status = 'passed'; await save();
        console.log(`Matched Windows development-host comparison: ${target}`);
    } catch (error) { report.status = 'failed'; report.error = error.message; await save(); throw error; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
