const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// node-pty 1.1.0 forks this helper while killing a Windows terminal. The helper attaches to the
// shell's console, which has usually already closed, so AttachConsole throws and the helper prints
// an uncaught stack trace. node-pty 1.2 catches that error; this applies the same one-line guard.
const unguarded = /^var consoleProcessList = getConsoleProcessList\(shellPid\);(\r?\n)/m;
const guarded = /try\s*\{\s*consoleProcessList\s*=\s*getConsoleProcessList\(shellPid\)/;

function patchAgentSource(source) {
    if (guarded.test(source)) return { status: 'already-guarded', source };
    const match = source.match(unguarded);
    if (!match) return { status: 'unrecognized', source };
    const eol = match[1];
    const replacement = [
        '// Patched by Terminal Canvas (scripts/patch-node-pty.cjs), matching node-pty 1.2.',
        'var consoleProcessList = [];',
        'if (shellPid > 0) {',
        '    try {',
        '        consoleProcessList = getConsoleProcessList(shellPid);',
        '    }',
        '    catch (_a) {',
        '        // AttachConsole can fail if the process already exited or is invalid.',
        '        consoleProcessList = [];',
        '    }',
        '}'
    ].join(eol) + eol;
    return { status: 'patched', source: source.replace(unguarded, replacement) };
}

function patchNodePty({ base = root, log = console.log } = {}) {
    let agent;
    try {
        agent = path.join(path.dirname(require.resolve('node-pty/package.json', { paths: [base] })), 'lib', 'conpty_console_list_agent.js');
    } catch {
        return 'missing';
    }
    if (!fs.existsSync(agent)) return 'missing';
    const result = patchAgentSource(fs.readFileSync(agent, 'utf8'));
    if (result.status === 'patched') {
        fs.writeFileSync(agent, result.source);
        log('Patched node-pty console list helper to ignore AttachConsole failures.');
    } else if (result.status === 'unrecognized') {
        log('node-pty console list helper has an unexpected layout; left unchanged.');
    }
    return result.status;
}

if (require.main === module) patchNodePty();

module.exports = { patchAgentSource, patchNodePty };
