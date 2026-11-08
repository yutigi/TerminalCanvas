const fs = require('node:fs');
const path = require('node:path');

function isDirectory(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !path.isAbsolute(value)) return false;
    try {
        if (!fs.statSync(value).isDirectory()) return false;
        fs.accessSync(value, fs.constants.R_OK);
        return true;
    } catch { return false; }
}
function fallbackDirectory(...candidates) {
    return candidates.find(isDirectory) || '';
}

// Only consume this session's private reports, preserving ordinary terminal output.
// Reports can be split across PTY chunks; keep the pending prefix bounded.
class DirectoryReporter {
    constructor(token, skipFirstReport = false) {
        this.prefix = `\x1b]777;tc-cwd;${token};`;
        this.pending = '';
        this.cwd = null;
        this.skipFirstReport = skipFirstReport;
        this.hasReport = false;
    }
    read(data) {
        let input = this.pending + data, output = '';
        this.pending = '';
        while (input) {
            const index = input.indexOf(this.prefix);
            if (index < 0) {
                let length = Math.min(input.length, this.prefix.length - 1);
                while (length && !input.endsWith(this.prefix.slice(0, length))) length--;
                this.pending = length ? input.slice(-length) : '';
                return output + input.slice(0, input.length - length);
            }
            output += input.slice(0, index);
            input = input.slice(index);
            const end = /\x07|\x1b\\/.exec(input);
            if (!end) {
                if (input.length <= this.prefix.length + 16384 + 2) { this.pending = input; return output; }
                this.cwd = null;
                return output + input;
            }
            const encoded = input.slice(this.prefix.length, end.index);
            const valid = encoded.length <= 16384 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded);
            const decoded = valid ? Buffer.from(encoded, 'base64').toString('utf8') : '';
            this.cwd = !this.skipFirstReport && valid && decoded && decoded.length <= 4096 && !/[\x00-\x1f\x7f]/.test(decoded) ? decoded : null;
            this.skipFirstReport = false;
            this.hasReport = true;
            input = input.slice(end.index + end[0].length);
        }
        return output;
    }
}
module.exports = { isDirectory, fallbackDirectory, DirectoryReporter };
