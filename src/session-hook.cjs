// CLI hook input can contain private fields. Retain only recovery metadata.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { sessionMetadata, SESSION_ID } = require('./session-metadata.cjs');

function recordSession(input, provider, env = process.env) {
    const session = sessionMetadata({ provider, sessionId: input.session_id, cwd: input.cwd });
    if (!session || input.hook_event_name !== 'SessionStart' || !SESSION_ID.test(env.TC_LAUNCH_TOKEN) || !env.TC_SESSION_FILE) return false;
    const temporary = `${env.TC_SESSION_FILE}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify({ ...session, token: env.TC_LAUNCH_TOKEN }), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, env.TC_SESSION_FILE);
        return true;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
}
if (require.main === module) {
    if (process.argv[2] === 'emit') {
        const type = process.argv[3];
        const event = type === 'launch'
            ? { type, provider: process.argv[4], sessionId: process.argv[5], cwd: process.cwd(), token: process.env.TC_LAUNCH_TOKEN }
            : { type, exitCode: Number(process.argv[4]), token: process.env.TC_LAUNCH_TOKEN };
        process.stdout.write('\x1b]633;TC;' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x07');
    } else {
        let input = '', oversized = false;
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', data => { if (input.length + data.length > 65536) { oversized = true; input = ''; } else if (!oversized) input += data; });
        process.stdin.on('end', () => {
            try { if (!oversized) recordSession(JSON.parse(input), process.argv[2]); } catch { /* Hooks never block the agent. */ }
        });
    }
}
module.exports = { recordSession };
