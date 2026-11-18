// Controlled lifecycle-hook stand-in. It never contacts a provider or reads user CLI settings.
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const readline = require('node:readline');
const args = process.argv.slice(3), provider = process.argv[2];
const session = provider === 'claude' ? '12345678-1234-4321-9876-123456789abc' : 'abcdef01-1234-4321-9876-123456789abc';
function command(event) {
    if (provider === 'claude') {
        const settings = args[args.indexOf('--settings') + 1];
        return JSON.parse(fs.readFileSync(settings, 'utf8')).hooks[event]?.[0].hooks[0].command;
    }
    const config = args.find(arg => arg.startsWith(`hooks.${event}=`));
    return config?.match(/command='([^']+)'/)?.[1];
}
function hook(event) {
    const cmd = command(event);
    if (!cmd) throw new Error(`Missing ${provider} ${event} hook`);
    const stdout = execSync(cmd, { input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: process.cwd(), last_assistant_message: `${provider} completed`, transcript_path: 'NEVER_KEEP' }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return stdout.trim() ? JSON.parse(stdout) : {};
}
hook('SessionStart'); hook('UserPromptSubmit');
console.log(`\n${provider.toUpperCase()}_BUSY`);
const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', line => {
    line = line.replace(/\x1b\[(?:200|201)~/g, '');
    if (line === 'quit') { hook('SessionEnd'); process.exit(0); }
    const result = hook('Stop');
    console.log(`${provider.toUpperCase()}_STOPPED`);
    if (result.decision === 'block') console.log(`CONTINUED:${result.reason}`);
});
