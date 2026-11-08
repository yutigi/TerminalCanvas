const { fileURLToPath } = require('node:url');

const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validDirectory = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f]/.test(value);
function sessionMetadata(raw) {
    if (!raw || !['codex', 'claude'].includes(raw.provider) || typeof raw.sessionId !== 'string' || !SESSION_ID.test(raw.sessionId) || !validDirectory(raw.cwd)) return null;
    return { provider: raw.provider, sessionId: raw.sessionId.toLowerCase(), cwd: raw.cwd };
}

// Inspect a bounded rolling buffer; never save terminal text or infer IDs from unrelated files.
class MetadataParser {
    constructor({ cwd, onChange, onLaunch = () => {}, onEnd = () => {}, onWarning = () => {}, platform = process.platform, directories = true }) {
        Object.assign(this, { cwd, onChange, onLaunch, onEnd, onWarning, platform, directories });
        this.buffer = '';
        this.text = '';
    }
    feed(data) {
        this.buffer = (this.buffer + data).slice(-32768);
        let match;
        while ((match = /\x1b\]([^\x07]*?)(?:\x07|\x1b\\)/.exec(this.buffer))) {
            this.inspectText(this.buffer.slice(0, match.index));
            this.control(match[1]);
            this.buffer = this.buffer.slice(match.index + match[0].length);
        }
        const pending = this.buffer.indexOf('\x1b]');
        const end = pending >= 0 ? pending : this.buffer.endsWith('\x1b') ? this.buffer.length - 1 : this.buffer.length;
        this.inspectText(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end);
    }
    control(value) {
        try {
            if (this.directories && value.startsWith('7;file://')) {
                const url = new URL(value.slice(2));
                if (!url.hostname || url.hostname === 'localhost') {
                    const cwd = fileURLToPath(url, { windows: this.platform === 'win32' });
                    if (validDirectory(cwd)) { this.cwd = cwd; this.onChange({ cwd }); }
                }
            }
            if (value.startsWith('633;TC;')) {
                const event = JSON.parse(Buffer.from(value.slice(7), 'base64').toString('utf8'));
                if (event.type === 'warning' && typeof event.message === 'string' && event.message.length <= 512) this.onWarning(event.message);
                if (event.type === 'cwd' && validDirectory(event.cwd)) { this.cwd = event.cwd; this.onChange({ cwd: event.cwd }); }
                if (event.type === 'launch' && ['codex', 'claude'].includes(event.provider) && SESSION_ID.test(event.token) && validDirectory(event.cwd)) {
                    this.launch = { provider: event.provider, token: event.token };
                    this.cwd = event.cwd;
                    this.text = '';
                    this.onLaunch(event);
                    this.onChange({ cwd: event.cwd, session: sessionMetadata({ ...event, sessionId: event.sessionId }) });
                }
                if (event.type === 'end' && this.launch && event.token === this.launch.token) {
                    this.onEnd(event);
                    this.launch = null;
                    this.text = '';
                }
            }
        } catch { /* Malformed or non-local metadata must not break terminal output. */ }
    }
    inspectText(data) {
        // A configured profile or a command mentioned in arbitrary output is not a launch.
        // Claude reports IDs through its launch event and hook instead of output heuristics.
        if (this.launch?.provider !== 'codex') return;
        this.text = (this.text + data).slice(-4096).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const patterns = [
            /(?:^|[\r\n])[ \t]*To continue this session, run codex resume ([a-f0-9-]{36})\b/gi,
            /(?:^|[\r\n])[ \t]*session id:[ \t]*([a-f0-9-]{36})\b/gi
        ];
        const matches = [];
        for (const pattern of patterns) {
            for (const match of this.text.matchAll(pattern)) {
                const session = sessionMetadata({ provider: 'codex', sessionId: match[1], cwd: this.cwd });
                if (session) matches.push({ session, index: match.index, end: match.index + match[0].length });
            }
        }
        matches.sort((a, b) => a.index - b.index);
        for (const match of matches) this.onChange({ session: match.session });
        if (matches.length) this.text = this.text.slice(matches.at(-1).end);
    }
}
module.exports = { SESSION_ID, validDirectory, sessionMetadata, MetadataParser };
