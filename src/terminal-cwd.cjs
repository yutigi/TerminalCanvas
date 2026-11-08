const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { fileURLToPath } = require('node:url');
const runFile = promisify(execFile);

function validDirectory(value, platform) {
    return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
        && (platform === 'win32' ? path.win32 : path.posix).isAbsolute(value) ? value : null;
}

// Observe metadata without changing the PTY bytes or its backpressure accounting.
// Bound retained data even if a program emits an unterminated/oversized OSC.
function directoryReports(platform, report, reportReady = () => {}) {
    let state = 'text', payload = '', overflow = false;
    function finish() {
        if (!overflow && /^777;tc-ready;[01]$/.test(payload)) {
            reportReady(payload.endsWith('1'));
        } else if (!overflow && payload.startsWith('9;9;')) {
            let value = payload.slice(4);
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            report(validDirectory(value, platform));
        } else if (!overflow && payload.startsWith('7;')) {
            try {
                const uri = payload.slice(2);
                const url = new URL(uri);
                const localHost = !url.hostname || ['localhost', os.hostname().toLowerCase()].includes(url.hostname.toLowerCase());
                if (url.protocol === 'file:' && (localHost || platform === 'win32')) {
                    // Windows file authorities remain UNC hosts, even on this machine.
                    if (localHost && platform !== 'win32') url.hostname = '';
                    let directory;
                    if (platform === 'win32' && /^file:\/\/localhost\//i.test(uri) && !/^\/[a-z]:/i.test(url.pathname)) {
                        // WHATWG URLs erase localhost. Keep its UNC meaning for a
                        // share path, while file://localhost/C:/... stays a drive path.
                        if (/%5c/i.test(url.pathname)) throw new TypeError('Encoded path separator.');
                        directory = '\\\\localhost' + fileURLToPath(url, { windows: false }).replaceAll('/', '\\');
                    } else directory = fileURLToPath(url, { windows: platform === 'win32' });
                    report(validDirectory(directory, platform));
                }
            } catch { report(null); }
        }
        state = 'text'; payload = ''; overflow = false;
    }
    return data => {
        for (const char of data) {
            if (state === 'text') { if (char === '\x1b') state = 'escape'; }
            else if (state === 'escape') { state = char === ']' ? 'osc' : char === '\x1b' ? 'escape' : 'text'; }
            else if (state === 'osc') {
                if (char === '\x07') finish();
                else if (char === '\x1b') state = 'osc-escape';
                else if (payload.length < 16384) payload += char;
                else overflow = true;
            } else if (state === 'osc-escape') {
                if (char === '\\') finish();
                else { state = char === ']' ? 'osc' : 'text'; payload = ''; overflow = false; }
            }
        }
    };
}

// Profiles load normally before -Command runs; wrap the resulting prompt only in
// this process. Keep the existing line reader and its bindings: PSReadLine can
// buffer pasted input itself, beyond what Console.KeyAvailable can observe.
const powershellBootstrap = `
$global:__TerminalCanvasPrompt = $function:prompt
$global:__TerminalCanvasReadLine = $function:PSConsoleHostReadLine
$global:__TerminalCanvasReader = $null
if ($null -ne $global:__TerminalCanvasReadLine) {
    function global:PSConsoleHostReadLine {
        try { & $global:__TerminalCanvasReadLine }
        finally {
            try { [Console]::Write(([char]27).ToString() + ']777;tc-ready;0' + [char]7) } catch { }
        }
    }
    $global:__TerminalCanvasReader = $function:PSConsoleHostReadLine
}
function global:prompt {
    $tcPrompt = & $global:__TerminalCanvasPrompt
    $tcExitVariable = Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction Ignore
    $tcExitCode = $null
    if ($null -ne $tcExitVariable) { $tcExitCode = $tcExitVariable.Value }
    $tcDirectory = ''
    try {
        $tcLocation = $executionContext.SessionState.Path.CurrentLocation
        if ($tcLocation.Provider.Name -eq 'FileSystem') { $tcDirectory = ([System.Uri]$tcLocation.ProviderPath).AbsoluteUri }
    } catch { }
    # Every accepted input line invalidates this prompt before execution, even
    # when PSReadLine already drained the console into its own paste buffer.
    # Without that reader (or if a profile/tool replaces it), require review.
    $tcReady = '0'
    if ($null -ne $global:__TerminalCanvasReader -and $function:PSConsoleHostReadLine -eq $global:__TerminalCanvasReader) { $tcReady = '1' }
    try {
        [Console]::Write(([char]27).ToString() + ']7;' + $tcDirectory + [char]7)
        [Console]::Write(([char]27).ToString() + ']777;tc-ready;' + $tcReady + [char]7)
    } catch { }
    if ($null -ne $tcExitVariable) { $global:LASTEXITCODE = $tcExitCode }
    $tcPrompt
}
`;
// Windows PowerShell defaults to Restricted, which blocks npm.ps1 and similar shims.
// A process-scoped RemoteSigned policy fixes that for this shell only; Group Policy still wins.
function powershellArgs() {
    return ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(powershellBootstrap, 'utf16le').toString('base64')];
}

async function processDirectory(pid, platform, { readlink = fs.readlink, run = runFile } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
        if (platform === 'linux') return validDirectory(await readlink(`/proc/${pid}/cwd`), platform);
        if (platform === 'darwin') {
            const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn0'], { timeout: 800, maxBuffer: 65536, windowsHide: true });
            const name = stdout.split('\0').find(field => field.replace(/^\n/, '').startsWith('n'));
            return validDirectory(name?.replace(/^\n?n/, ''), platform);
        }
    } catch { /* Missing permissions, exited processes, and unavailable tools are unknown. */ }
    return null;
}

// Never overlap lookups. Disposing invalidates in-flight results as well as timers.
function watchDirectory(pid, platform, report, { read = processDirectory, schedule = setTimeout, cancel = clearTimeout } = {}) {
    let disposed = false, timer;
    async function poll() {
        let cwd = null;
        try { cwd = validDirectory(await read(pid, platform), platform); } catch { /* Unknown. */ }
        if (disposed) return;
        report(cwd);
        timer = schedule(poll, 1000);
        timer?.unref?.();
    }
    void poll();
    return { dispose() { disposed = true; cancel(timer); } };
}
module.exports = { directoryReports, powershellArgs, processDirectory, watchDirectory };
