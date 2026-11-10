// One launcher for every AI CLI typed into an integrated terminal, whatever the shell.
// It must behave like running the real program: same arguments, same terminal, same
// exit code. Tracking and session options are only added to session launches.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INFO_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help']);
// A bare first word is a subcommand (`claude update`, `codex login`, `gemini mcp`), so
// new CLI subcommands keep working without a list to maintain. Only these words start
// a conversation that Terminal Canvas can resume.
const PROVIDERS = Object.freeze({
    claude: { sessionWords: [], idFlags: ['--resume', '-r', '--session-id'] },
    codex: { sessionWords: ['resume', 'fork', 'exec', 'e', 'review'], idWords: ['resume'] },
    // Gemini only gained --session-id recently; never add flags an installed version may reject.
    gemini: { sessionWords: [], idFlags: ['--resume', '-r', '--session-id'] }
});

function plan(provider, args, env = process.env) {
    const config = PROVIDERS[provider];
    const first = args[0];
    const passthrough = { track: false, args };
    // A launch from inside a tracked AI session (a tool call, a plugin) is not a new card session.
    if (!config || SESSION_ID.test(env.TC_LAUNCH_TOKEN || '')) return passthrough;
    if (args.some(arg => INFO_FLAGS.has(arg))) return passthrough;
    if (first !== undefined && /^[a-z][a-z0-9-]*$/i.test(first) && !config.sessionWords.includes(first)) return passthrough;
    let sessionId = null;
    args.forEach((arg, index) => {
        const next = args[index + 1];
        if (config.idFlags?.includes(arg) && SESSION_ID.test(next || '')) sessionId = next;
        const inline = /^(--[a-z-]+)=(.*)$/i.exec(arg);
        if (inline && config.idFlags?.includes(inline[1]) && SESSION_ID.test(inline[2])) sessionId = inline[2];
    });
    if (config.idWords?.includes(first) && SESSION_ID.test(args[1] || '')) sessionId = args[1];
    const extra = [];
    if (provider === 'claude') {
        if (args.length === 0) { sessionId = randomUUID(); extra.push('--session-id', sessionId); }
        const custom = args.some(arg => arg === '--settings' || arg.startsWith('--settings='));
        if (!custom && env.TC_SETTINGS) extra.push('--settings', env.TC_SETTINGS);
    }
    return { track: true, args: [...args, ...extra], sessionId: sessionId?.toLowerCase() || null };
}

const samePath = (a, b, windows) => {
    const normal = value => path.resolve(value).replace(/[\\/]+$/, '');
    return windows ? normal(a).toLowerCase() === normal(b).toLowerCase() : normal(a) === normal(b);
};

// Look past Terminal Canvas's own shims so the real program runs.
function resolveExecutable(name, env = process.env, platform = process.platform) {
    const windows = platform === 'win32';
    const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    const skip = env.TC_SHIM_DIR;
    const extensions = windows
        ? [...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase()), '.ps1']
        : [''];
    for (const directory of (env[key] || '').split(windows ? ';' : ':')) {
        if (!directory || (skip && samePath(directory, skip, windows))) continue;
        for (const extension of extensions) {
            const candidate = path.join(directory, name + extension);
            try {
                const stat = fs.statSync(candidate);
                if (!stat.isFile()) continue;
                if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch { /* Not here. */ }
        }
    }
    return null;
}

// cmd.exe re-parses batch arguments; escape them like cross-spawn does.
const META = /([()\][%!^"`<>&|;, *?])/g;
function cmdArgument(value, twice) {
    let arg = String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    arg = `"${arg}"`.replace(META, '^$1');
    return twice ? arg.replace(META, '^$1') : arg;
}
function command(executable, args, env = process.env, platform = process.platform) {
    if (platform !== 'win32') return { file: executable, args, options: {} };
    const extension = path.extname(executable).toLowerCase();
    if (extension === '.ps1') {
        const shell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        return { file: shell, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args], options: {} };
    }
    if (extension === '.cmd' || extension === '.bat') {
        // CLI batch wrappers forward %*, which cmd parses a second time.
        const line = [executable.replace(META, '^$1'), ...args.map(arg => cmdArgument(arg, true))].join(' ');
        return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
    }
    return { file: executable, args, options: {} };
}

function emit(event, stream = process.stdout) {
    try { stream.write('\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07'); } catch { /* Not a terminal. */ }
}

function run(provider, args, { env = process.env, platform = process.platform, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
    return new Promise(resolve => {
        // Report to the terminal, not into a redirected pipe or file (`claude -p ... > out.txt`).
        if (!stdout.isTTY && stderr.isTTY) stdout = stderr;
        const childEnv = { ...env };
        delete childEnv.ELECTRON_RUN_AS_NODE;
        const executable = resolveExecutable(provider, env, platform);
        const launch = plan(provider, args, env);
        if (!executable) {
            if (launch.track) emit({ type: 'warning', message: 'The AI tool is unavailable. Install it on PATH, or stop this terminal and use Start fresh shell. The saved ID is retained.' }, stdout);
            stderr.write(`${provider}: command not found\n`);
            return resolve(127);
        }
        let token = null;
        if (launch.track) {
            token = randomUUID();
            childEnv.TC_LAUNCH_TOKEN = token;
            emit({ type: 'launch', provider, token, cwd, sessionId: launch.sessionId }, stdout);
        }
        const { file, args: argv, options } = command(executable, launch.args, childEnv, platform);
        // Ctrl+C belongs to the AI tool; the launcher must outlive it to report the result.
        const ignore = () => {};
        const signals = ['SIGINT', 'SIGQUIT', 'SIGBREAK'].filter(signal => platform === 'win32' ? signal !== 'SIGQUIT' : signal !== 'SIGBREAK');
        signals.forEach(signal => process.on(signal, ignore));
        let done = false;
        const finish = code => {
            if (done) return;
            done = true;
            signals.forEach(signal => process.off(signal, ignore));
            if (token) emit({ type: 'end', token, exitCode: code }, stdout);
            resolve(code);
        };
        let child;
        try { child = spawn(file, argv, { ...options, cwd, env: childEnv, stdio: 'inherit', windowsHide: false }); }
        catch (error) { stderr.write(`${provider}: ${error.message}\n`); return finish(126); }
        const forward = signal => { try { child.kill(signal); } catch { /* Exited. */ } };
        const forwarded = platform === 'win32' ? [] : ['SIGTERM', 'SIGHUP'];
        forwarded.forEach(signal => process.on(signal, forward));
        child.on('error', error => {
            forwarded.forEach(s => process.off(s, forward));
            stderr.write(`${provider}: ${error.message}\n`);
            finish(126);
        });
        child.on('close', (code, signal) => {
            forwarded.forEach(s => process.off(s, forward));
            const number = signal ? os.constants.signals[signal] : 0;
            finish(code ?? (number ? 128 + number : 1));
        });
    });
}

if (require.main === module) {
    run(process.argv[2], process.argv.slice(3)).then(code => { process.exitCode = code; });
}
module.exports = { PROVIDERS, plan, resolveExecutable, command, cmdArgument, run };
