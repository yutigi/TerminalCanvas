const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCard, LIMITS } = require('./workspace.cjs');
const { directoryReports, powershellArgs, watchDirectory } = require('./terminal-cwd.cjs');

// Terminal processes belong to the desktop host; renderers only receive this lifecycle API.
class TerminalManager {
    constructor({ spawn, emit, platform = process.platform, env = process.env, home = os.homedir(), watchCwd = watchDirectory }) {
        this.spawn = spawn;
        this.emit = emit;
        this.platform = platform;
        this.env = env;
        this.home = home;
        this.watchCwd = watchCwd;
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
        let shell = windows
            ? path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : (this.env.SHELL || '/bin/bash');
        let args = windows ? powershellArgs() : ['-l'];
        let command = card.command;
        // An explicit plain shell launcher can be integrated directly. More complex
        // launch commands keep their existing PowerShell execution semantics.
        if (windows && /^(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(command.trim())) {
            shell = /\.exe$/i.test(command.trim()) ? command.trim() : command.trim() + '.exe'; command = '';
            args = /^cmd/i.test(shell) ? [] : powershellArgs();
        }
        const env = { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERMINAL_CANVAS: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        if (windows) env.PROMPT = '$E]9;9;$P$E\\' + (env.PROMPT || '$P$G');
        const terminal = this.spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env });
        const entry = { terminal, cwd: undefined, pending: 0, paused: false, subscriptions: [] };
        this.sessions.set(card.id, entry);
        const report = cwd => {
            if (this.sessions.get(card.id) !== entry || entry.cwd === cwd) return;
            entry.cwd = cwd;
            this.emit({ type: 'cwd', id: card.id, cwd });
        };
        const observe = directoryReports(this.platform, report);
        entry.subscriptions.push(terminal.onData(data => {
            if (this.sessions.get(card.id) !== entry) return;
            entry.pending += data.length;
            if (entry.pending > 256000 && !entry.paused) {
                entry.paused = true;
                terminal.pause();
            }
            this.emit({ type: 'data', id: card.id, data });
            if (windows) observe(data);
        }));
        entry.subscriptions.push(terminal.onExit(({ exitCode, signal }) => {
            if (this.sessions.get(card.id) !== entry) return;
            this.sessions.delete(card.id);
            this.dispose(entry);
            this.emit({ type: 'exit', id: card.id, exitCode, signal });
        }));
        if (!windows) entry.subscriptions.push(this.watchCwd(terminal.pid, this.platform, report));
        try {
            if (command) terminal.write(command + '\r');
        } catch (error) {
            this.stop(card.id);
            throw error;
        }
        return { id: card.id, pid: terminal.pid, cwd, shell };
    }
    dimensions(cols, rows) {
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new Error('Invalid terminal dimensions.');
    }
    write(id, data) {
        if (typeof data !== 'string' || data.length > 65536) throw new Error('Input exceeds 64 KB.');
        this.sessions.get(id)?.terminal.write(data);
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
