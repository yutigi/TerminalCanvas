// Controlled native child used only by the Windows E2E suite. No provider tools or network calls.
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
if (process.argv.includes('--child')) {
    setInterval(() => {}, 1000);
} else {
    const child = spawn(process.execPath, [__filename, '--child'], { stdio: 'ignore', windowsHide: true });
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`\r\nIO_READY ${process.pid} ${child.pid}\r\n`);
    let pending = '';
    process.stdin.on('data', bytes => {
        pending += bytes.toString('utf8');
        let line;
        while ((line = pending.indexOf('\r')) >= 0) {
            const input = pending.slice(0, line); pending = pending.slice(line + 1);
            if (input === 'flood') {
                process.stdout.write('x'.repeat(2 * 1024 * 1024));
                process.stdout.write('\r\nFLOOD_DONE\r\n');
            } else {
                const hash = createHash('sha256').update(input).digest('hex');
                process.stdout.write(`\r\nINPUT_RECORD ${input.length} ${hash}\r\n`);
            }
        }
        if (pending.includes('\x03')) { child.kill(); process.exit(0); }
    });
}
