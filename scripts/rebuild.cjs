const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

async function prepareNative({ platform, fromSource, verify, rebuild, log = console.log }) {
    if (platform === 'win32' && !fromSource) {
        try {
            verify();
            log('node-pty works in Electron; using the existing Windows binary.');
            return;
        } catch (error) {
            log('Existing node-pty binary could not run: ' + error.message);
        }
    }
    log('Rebuilding node-pty from source for Electron...');
    await rebuild();
    verify();
    log('node-pty rebuilt and verified in Electron.');
}

function verifyNative() {
    const result = spawnSync(require('electron'), [__filename, '--verify'], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Electron PTY check failed (exit ' + result.status + ').');
    }
}

function probe() {
    if (!process.versions.electron) throw new Error('The native check must run inside Electron.');
    const pty = require('node-pty');
    const marker = 'TERMINAL_CANVAS_PTY_OK';
    const windows = process.platform === 'win32';
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = pty.spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
        windows ? ['/d', '/q', '/c', 'echo ' + marker] : ['-c', 'echo ' + marker],
        { cols: 80, rows: 24, cwd: root, env });
    let output = '';
    const timeout = setTimeout(() => {
        try { child.kill(); } finally { console.error('PTY check timed out.'); process.exit(1); }
    }, 10000);
    child.onData(data => { output += data; });
    child.onExit(({ exitCode }) => {
        clearTimeout(timeout);
        if (exitCode !== 0 || !output.includes(marker)) {
            console.error('PTY check did not return the expected command output.');
            process.exit(1);
        }
        process.exit(0);
    });
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--verify') return probe();
    if (args.some(arg => arg !== '--from-source')) throw new Error('Usage: npm run rebuild [-- --from-source]');
    await prepareNative({
        platform: process.platform,
        fromSource: args.includes('--from-source') || process.env.npm_config_build_from_source === 'true',
        verify: verifyNative,
        rebuild: async () => {
            const { rebuild } = await import('@electron/rebuild');
            await rebuild({
                buildPath: root,
                electronVersion: require('electron/package.json').version,
                force: true,
                onlyModules: ['node-pty']
            });
        }
    });
}

if (require.main === module) main().catch(error => {
    console.error(error.message);
    if (process.platform === 'win32') {
        console.error('Source builds require Python and Visual Studio C++ Build Tools, a Windows SDK, and matching MSVC Spectre-mitigated libraries (MSB8040).');
    }
    process.exitCode = 1;
});

module.exports = { prepareNative };
