/* A local stand-in for manual native restoration checks. Never invokes a provider. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const [log, provider, ...args] = process.argv.slice(2);
assert.ok(['claude', 'codex'].includes(provider));
const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const sessionId = provider === 'claude'
    ? value('--resume') || value('--session-id') || '12345678-1234-4321-9876-123456789abc'
    : args[0] === 'resume' ? args[1] : '0f1e2d3c-4b5a-4968-8776-655443322110';
assert.match(sessionId, /^[0-9a-f-]{36}$/i);
let hookExitCode = null;
if (provider === 'claude') {
    const settings = value('--settings');
    assert.ok(settings, 'Bash integration must supply Claude hook settings.');
    const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const command = config.hooks.SessionStart[0].hooks[0].command;
    const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
    assert.ok(process.env.TC_HOOK && process.env.TC_SESSION_FILE && process.env.TC_LAUNCH_TOKEN);
    assert.equal(command, quote(process.env.TC_HOOK) + ' record claude', 'Only the native test hook may run.');
    const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId,
        cwd: process.cwd(), transcript_path: 'MUST_NOT_BE_SAVED' });
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', command], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    hookExitCode = result.status;
} else {
    console.log('session id: ' + sessionId);
}
fs.appendFileSync(log, JSON.stringify({ provider, args, sessionId, cwd: process.cwd(),
    phase: process.env.TC_MANUAL_PHASE, hookExitCode }) + '\n');
console.log('LOCAL_SESSION_CHECK_DONE:' + provider);
