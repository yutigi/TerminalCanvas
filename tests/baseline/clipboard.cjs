/* Keep the native snapshot outside Electron, including when the smoke process exits. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function withSavedClipboard(task, log, launch = spawn) {
    const stream = fs.createWriteStream(log);
    const child = launch('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File',
        path.join(__dirname, '../e2e/clipboard-guard.ps1')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', errors = '', ended = false, failure;
    child.stdout.on('data', data => { output += data; stream.write(data); });
    child.stderr.on('data', data => { errors += data; stream.write(data); });
    child.stdin.on('error', error => { errors += error.message; });
    const exited = new Promise(resolve => {
        child.once('error', error => { failure = error; ended = true; resolve(null); });
        child.once('exit', code => { ended = true; resolve(code); });
    });
    const wait = async (check, message) => {
        const deadline = Date.now() + 30000;
        while (!check()) {
            if (Date.now() > deadline) throw new Error(message);
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    };
    try {
        await wait(() => {
            if (ended) throw failure || new Error(`Clipboard snapshot failed: ${errors}`);
            return output.includes('CLIPBOARD_SAVED');
        }, 'The native clipboard guard did not finish its snapshot');
        return await task();
    } finally {
        try {
            if (!ended) child.stdin.end('restore\n');
            await wait(() => ended, 'The clipboard guard has not restored the native clipboard');
            assert.equal(await exited, 0, errors);
            assert.ok(output.includes('CLIPBOARD_RESTORED'), 'The native clipboard must be restored');
        } finally { await new Promise(resolve => stream.end(resolve)); }
    }
}
module.exports = { withSavedClipboard };
