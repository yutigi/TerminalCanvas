const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDirectory, fallbackDirectory, DirectoryReporter } = require('./directories.cjs');
const { validateCard, LIMITS } = require('./workspace.cjs');

// Terminal processes belong to the desktop host; renderers only receive this lifecycle API.
class TerminalManager {
    constructor({ spawn, emit, platform = process.platform, env = process.env, home = os.homedir() }) {
        this.spawn = spawn;
        this.emit = emit;
        this.platform = platform;
        this.env = env;
        this.home = home;
        this.sessions = new Map();
    }
    start(raw, cols = 80, rows = 24) {
        const card = validateCard(raw);
        this.dimensions(cols, rows);
        if (this.sessions.has(card.id)) throw new Error('This terminal is already running.');
        if (this.sessions.size >= LIMITS.cards) throw new Error('Terminal limit reached.');
        const cwd = card.cwd || this.home;
        if (!fs.statSync(cwd).isDirectory()) throw new Error('Working directory must be a folder.');
        const windows = this.platform === 'win32';
        const shell = windows
            ? path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : (this.env.SHELL || '/bin/bash');
        const token = randomUUID();
        const script = windows ? fs.readFileSync(path.join(__dirname, 'shell-integration.ps1'), 'utf8') : '';
        const args = windows ? ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-l'];
        const env = { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERMINAL_CANVAS: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        if (windows) env.TERMINAL_CANVAS_CWD_TOKEN = token;
        const terminal = this.spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env });
        const entry = { terminal, reporter: windows ? new DirectoryReporter(token, Boolean(card.command)) : null, pending: 0, paused: false, subscriptions: [] };
        this.sessions.set(card.id, entry);
        entry.subscriptions.push(terminal.onData(data => {
            if (this.sessions.get(card.id) !== entry) return;
            data = entry.reporter ? entry.reporter.read(data) : data;
            if (!data) return;
            entry.pending += data.length;
            if (entry.pending > 256000 && !entry.paused) {
                entry.paused = true;
                terminal.pause();
            }
            this.emit({ type: 'data', id: card.id, data });
        }));
        entry.subscriptions.push(terminal.onExit(({ exitCode, signal }) => {
            if (this.sessions.get(card.id) !== entry) return;
            this.sessions.delete(card.id);
            this.dispose(entry);
            this.emit({ type: 'exit', id: card.id, exitCode, signal });
        }));
        try {
            if (card.command) terminal.write(card.command + '\r');
        } catch (error) {
            this.stop(card.id);
            throw error;
        }
        return { id: card.id, pid: terminal.pid, cwd, shell };
    }
    directory(raw) {
        const card = validateCard(raw);
        const entry = this.sessions.get(card.id);
        let current;
        if (entry) {
            if (this.platform === 'win32') current = entry.reporter.cwd;
            else if (this.platform === 'linux') {
                try { current = fs.readlinkSync(`/proc/${entry.terminal.pid}/cwd`); } catch { /* Process may have exited. */ }
            }
        }
        if (isDirectory(current)) return { cwd: current };
        const cwd = fallbackDirectory(card.cwd, this.home, process.cwd());
        const reason = current ? 'The current directory is no longer available.' : 'The current directory could not be determined. The terminal may be busy, stopped, or using a shell without directory reporting.';
        return { cwd, warning: `${reason} Review the suggested folder before starting a new shell.` };
    }
    dimensions(cols, rows) {
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new Error('Invalid terminal dimensions.');
    }
    write(id, data) {
        if (typeof data !== 'string' || data.length > 65536) throw new Error('Input exceeds 64 KB.');
        const entry = this.sessions.get(id);
        // A submitted command can enter a nested shell or change location before its next prompt.
        if (entry?.reporter && /[\r\n]/.test(data)) {
            entry.reporter.cwd = null;
            if (!entry.reporter.hasReport) entry.reporter.skipFirstReport = true;
        }
        entry?.terminal.write(data);
    }
    resize(id, cols, rows) {
        this.dimensions(cols, rows);
        this.sessions.get(id)?.terminal.resize(cols, rows);
    }
    acknowledge(id, amount) {
        const entry = this.sessions.get(id);
        if (!entry || !Number.isInteger(amount) || amount < 0 || amount > 1024 * 1024) return;
        entry.pending = Math.max(0, entry.pending - amount);
        if (entry.paused && entry.pending < 32000) {
            entry.paused = false;
            entry.terminal.resume();
        }
    }
    dispose(entry) { entry.subscriptions.forEach(s => s.dispose()); }
    stop(id) {
        const entry = this.sessions.get(id);
        if (!entry) return;
        this.sessions.delete(id);
        this.dispose(entry);
        try { entry.terminal.kill(); } catch { /* The process can exit before kill. */ }
    }
    stopAll() { for (const id of this.sessions.keys()) this.stop(id); }
}
module.exports = { TerminalManager };
