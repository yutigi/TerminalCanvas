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

module.exports = { isDirectory, fallbackDirectory };
