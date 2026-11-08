const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCard, LIMITS } = require('./workspace.cjs');
const { MetadataParser, sessionMetadata } = require('./session-metadata.cjs');
const { directoryReports, powershellArgs, watchDirectory } = require('./terminal-cwd.cjs');

// Terminal processes belong to the desktop host; renderers only receive this lifecycle API.
class TerminalManager {
    constructor({ spawn, emit, platform = process.platform, env = process.env, home = os.homedir(), integration, watchCwd = watchDirectory }) {
        this.spawn = spawn;
        this.emit = emit;
        this.platform = platform;
        this.env = env;
        this.home = home;
        this.watchCwd = watchCwd;
        this.sessions = new Map();
        this.stopping = new Set();
        this.metadata = new Map();
        this.integration = integration;
    }
    start(raw, cols = 80, rows = 24, mode = 'start') {
        const card = validateCard(raw);
        if (!['start', 'resume', 'fresh'].includes(mode)) throw new Error('Unknown terminal start mode.');
        if (mode === 'resume' && !card.session) throw new Error('No valid saved session ID. Start a fresh shell instead.');
        this.dimensions(cols, rows);
        if (this.sessions.has(card.id)) throw new Error('This terminal is already running.');
        if (this.sessions.size >= LIMITS.cards) throw new Error('Terminal limit reached.');
        let cwd = (mode === 'resume' ? card.session.cwd : card.cwd) || this.home;
        try { if (!fs.statSync(cwd).isDirectory()) throw new Error('Not a directory'); }
        catch {
            if (mode !== 'fresh') throw new Error('Working directory is unavailable. Start a fresh shell to use your home folder.');
            cwd = this.home;
        }
        const windows = this.platform === 'win32';
        let shell = windows
            ? path.win32.join(this.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
            : (this.env.SHELL || '/bin/bash');
        let command = mode === 'fresh' ? '' : mode === 'resume'
            ? (card.session.provider === 'codex' ? `codex resume ${card.session.sessionId}` : `claude --resume ${card.session.sessionId}`)
            : card.command;
        // Integrate explicit shell launchers directly, preserving their selected shell.
        if (windows && /^(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(command.trim())) {
            shell = /\.exe$/i.test(command.trim()) ? command.trim() : command.trim() + '.exe'; command = '';
        }
        const integration = this.integration?.({ shell, platform: this.platform });
        const args = integration?.args || (windows ? (/^cmd(?:\.exe)?$/i.test(shell) ? [] : powershellArgs()) : ['-l']);
        const env = { ...this.env, ...integration?.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERMINAL_CANVAS: '1' };
        delete env.ELECTRON_RUN_AS_NODE;
        if (windows) env.PROMPT = '$E]9;9;$P$E\\' + (env.PROMPT || '$P$G');
        let terminal;
        try { terminal = this.spawn(shell, args, { name: 'xterm-256color', cwd, cols, rows, env }); }
        catch (error) { integration?.cleanup(); throw error; }
        const entry = { terminal, integration, cwd: undefined, pending: 0, paused: false, subscriptions: [] };
        this.sessions.set(card.id, entry);
        this.metadata.set(card.id, { cwd, session: card.session || null });
        entry.parser = new MetadataParser({
            cwd, platform: this.platform, directories: false,
            onChange: patch => this.updateMetadata(card.id, patch),
            onLaunch: event => { entry.launch = event; },
            onWarning: message => this.emit({ type: 'error', id: card.id, message }),
            onEnd: event => {
                if (event.token !== entry.launch?.token) return;
                this.pollMetadata(card.id);
                if (event.exitCode) this.emit({ type: 'error', id: card.id, message: 'The AI tool exited with an error. See the terminal for details; the saved ID is retained. You can stop this terminal and retry Resume or open a fresh shell.' });
            }
        });
        this.emit({ type: 'metadata', id: card.id, ...this.metadata.get(card.id), initial: true });
        if (integration) { entry.poll = setInterval(() => this.pollMetadata(card.id), 500); entry.poll.unref(); }
        const report = cwd => {
            if (this.sessions.get(card.id) !== entry || entry.cwd === cwd) return;
            entry.cwd = cwd;
            // Unknown live locations change the label, while the last usable folder
            // remains available for restoration and host-side shutdown persistence.
            if (cwd) { entry.parser.cwd = cwd; this.updateMetadata(card.id, { cwd }); }
            this.emit({ type: 'cwd', id: card.id, cwd });
        };
        const observe = directoryReports(this.platform, report);
        entry.subscriptions.push(terminal.onData(data => {
            if (this.sessions.get(card.id) !== entry) return;
            entry.parser.feed(data);
            entry.pending += data.length;
            if (entry.pending > 256000 && !entry.paused) {
                entry.paused = true;
                terminal.pause();
            }
            this.emit({ type: 'data', id: card.id, data });
            observe(data);
        }));
        entry.subscriptions.push(terminal.onExit(({ exitCode, signal }) => {
            if (this.sessions.get(card.id) !== entry) return;
            this.pollMetadata(card.id);
            this.sessions.delete(card.id);
            this.dispose(entry);
            this.emit({ type: 'exit', id: card.id, exitCode, signal });
        }));
        if (!windows) entry.subscriptions.push(this.watchCwd(terminal.pid, this.platform, report));
        try {
            if (integration?.command) terminal.write(integration.command + '\r');
            if (command) terminal.write(command + '\r');
        } catch (error) {
            this.stop(card.id);
            throw error;
        }
        return { id: card.id, pid: terminal.pid, cwd, shell, ...this.metadata.get(card.id) };
    }
    updateMetadata(id, patch) {
        const previous = this.metadata.get(id);
        if (!previous) return;
        // A launch without an ID must not replace a known conversation with a guess.
        const next = { ...previous, ...patch };
        if (!patch.session) next.session = previous.session;
        if (JSON.stringify(previous) === JSON.stringify(next)) return;
        this.metadata.set(id, next);
        this.emit({ type: 'metadata', id, ...next });
    }
    pollMetadata(id) {
        const entry = this.sessions.get(id);
        if (!entry?.integration?.sessionFile || !entry.launch) return;
        try {
            const file = entry.integration.sessionFile;
            if (fs.statSync(file).size > 8192) return;
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            const session = sessionMetadata(raw);
            if (session && raw.token === entry.launch.token && session.provider === entry.launch.provider) this.updateMetadata(id, { session });
        } catch { /* Missing, partial, or unavailable hook metadata is expected. */ }
    }
    snapshot() {
        for (const id of this.sessions.keys()) this.pollMetadata(id);
        return this.metadata;
    }
    forget() { this.metadata.clear(); }
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
    dispose(entry) { clearInterval(entry.poll); entry.subscriptions.forEach(s => s.dispose()); entry.integration?.cleanup(); }
    stop(id, timeoutMs = 5000) {
        const entry = this.sessions.get(id);
        if (!entry) return;
        this.pollMetadata(id);
        this.sessions.delete(id);
        this.dispose(entry);
        // Track native cleanup even when Stop or a workspace switch precedes quit.
        const exit = new Promise(resolve => {
            let subscription;
            const finish = () => { clearTimeout(timer); subscription?.dispose(); resolve(); };
            const timer = setTimeout(finish, timeoutMs);
            subscription = entry.terminal.onExit(finish);
        });
        this.stopping.add(exit);
        exit.then(() => this.stopping.delete(exit));
        try { entry.terminal.kill(); } catch { /* The process can exit before kill. */ }
    }
    stopAll() { for (const id of this.sessions.keys()) this.stop(id); }
    async shutdown(timeoutMs = 5000) {
        // kill() returns before native PTY exit/pipe cleanup completes. Keep the
        // Electron host alive for that completion instead of tearing down V8 first.
        for (const id of this.sessions.keys()) this.stop(id, timeoutMs);
        await Promise.all(this.stopping);
    }
}
module.exports = { TerminalManager };
