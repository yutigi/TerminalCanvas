const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { powershellArgs } = require('./terminal-cwd.cjs');
const { PROVIDERS } = require('./agent-launcher.cjs');
const AGENTS = Object.keys(PROVIDERS);
const LAUNCHER = path.join(__dirname, 'agent-launcher.cjs');
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const shQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const fishQuote = value => "'" + value.replace(/[\\']/g, '\\$&') + "'";
const shellName = shell => path.win32.basename(shell || '').replace(/\.exe$/i, '').toLowerCase();

// PATH shims reach the launcher from any shell, nested shell, or script in the terminal.
// The interactive shells below also re-add them after profiles that rewrite PATH.
function shimSources(name) {
    const posix = `#!/bin/sh
# Terminal Canvas: run the real ${name} through the session launcher.
if [ -n "$TC_NODE" ] && [ -n "$TC_LAUNCHER" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$TC_NODE" "$TC_LAUNCHER" ${name} "$@"
fi
self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IFS=:
for directory in $PATH; do
    [ "$directory" = "$self" ] && continue
    [ -x "$directory/${name}" ] && exec "$directory/${name}" "$@"
done
printf '%s: command not found\\n' ${name} >&2
exit 127
`;
    const windows = [
        '@echo off',
        `rem Terminal Canvas: run the real ${name} through the session launcher.`,
        'if not defined TC_NODE goto unavailable',
        'if not defined TC_LAUNCHER goto unavailable',
        'setlocal',
        'set ELECTRON_RUN_AS_NODE=1',
        `"%TC_NODE%" "%TC_LAUNCHER%" ${name} %*`,
        'exit /b %ERRORLEVEL%',
        ':unavailable',
        `echo ${name}: the Terminal Canvas launcher is unavailable. Open a new terminal. 1>&2`,
        'exit /b 9009',
        ''
    ].join('\r\n');
    return { [name]: posix, [`${name}.cmd`]: windows };
}

// A running batch file is re-read while it executes; only rewrite shims that changed.
function writeShims(folder) {
    const bin = path.join(folder, 'bin');
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    for (const name of AGENTS) {
        for (const [file, source] of Object.entries(shimSources(name))) {
            const target = path.join(bin, file);
            let current;
            try { current = fs.readFileSync(target, 'utf8'); } catch { /* New shim. */ }
            if (current !== source) fs.writeFileSync(target, source, { mode: 0o755 });
        }
    }
    return bin;
}

function powershellSource(bin) {
    // Share directory reporting with plain PowerShell cards, including strict-mode
    // prompts, custom prompt output, provider locations and native exit status.
    // Functions call the launcher directly so PowerShell passes arguments natively.
    return Buffer.from(powershellArgs().at(-1), 'base64').toString('utf16le') + `
if ($env:PATH -and -not $env:PATH.StartsWith(${psQuote(bin)} + [IO.Path]::PathSeparator)) { $env:PATH = ${psQuote(bin)} + [IO.Path]::PathSeparator + $env:PATH }
function global:__tc_agent($provider, $arguments) {
    $tcPrevious = $env:ELECTRON_RUN_AS_NODE
    $env:ELECTRON_RUN_AS_NODE = '1'
    try { & $env:TC_NODE $env:TC_LAUNCHER $provider @arguments }
    finally {
        if ($null -eq $tcPrevious) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction Ignore } else { $env:ELECTRON_RUN_AS_NODE = $tcPrevious }
    }
}
${AGENTS.map(name => `function global:${name} { __tc_agent '${name}' $args }`).join('\n')}
`;
}

const cwdReport = `printf '\\033]7;file://localhost%s\\007' "$(pwd -P | sed 's/%/%25/g; s/ /%20/g; s/#/%23/g; s/?/%3F/g')"`;
const posixPath = bin => `case "$PATH" in ${shQuote(bin)}:*) ;; *) PATH=${shQuote(bin)}:"$PATH"; export PATH;; esac`;

function bashSource(bin) {
    return `
${posixPath(bin)}
hash -r 2>/dev/null
__tc_cwd() { ${cwdReport}; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(__tc_cwd "\${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__tc_cwd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
`;
}

function zshSource(bin) {
    return `
${posixPath(bin)}
rehash 2>/dev/null
__tc_cwd() { ${cwdReport}; }
typeset -ga precmd_functions
precmd_functions=(__tc_cwd \${precmd_functions:#__tc_cwd})
`;
}

function fishSource(bin) {
    return `
if test "$PATH[1]" != ${fishQuote(bin)}
    set -gx PATH ${fishQuote(bin)} $PATH
end
function __tc_cwd --on-event fish_prompt
    printf '\\e]7;file://localhost%s\\a' (pwd -P | string replace -a '%' '%25' | string replace -a ' ' '%20' | string replace -a '#' '%23' | string replace -a '?' '%3F')
end
`;
}

// Intercept ordinary CLI launches without changing global CLI settings.
function prepareIntegration({ folder, executable = process.execPath, platform = process.platform, shell }) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const bin = writeShims(folder);
    const stem = path.join(folder, randomUUID());
    const sessionFile = `${stem}.json`, settings = `${stem}.settings.json`;
    const hook = path.join(__dirname, 'session-hook.cjs');
    const windows = platform === 'win32';
    const ps = `$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); $payload = $reader.ReadToEnd(); $reader.Dispose(); $OutputEncoding = New-Object Text.UTF8Encoding $false; $env:ELECTRON_RUN_AS_NODE = '1'; $payload | & ${psQuote(executable)} ${psQuote(hook)} claude`;
    const command = windows
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
        : `ELECTRON_RUN_AS_NODE=1 ${shQuote(executable)} ${shQuote(hook)} claude`;
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }), { mode: 0o600 });
    const files = [sessionFile, settings];
    const name = shellName(shell);
    let args, initializeCommand;
    if (name === 'powershell' || name === 'pwsh') {
        const source = powershellSource(bin);
        args = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
    } else if (['bash', 'zsh', 'fish'].includes(name)) {
        // Login profiles keep control of environment setup and whether rc files are sourced.
        // Queue integration as the first input command, after the shell finishes those profiles.
        const source = { bash: bashSource, zsh: zshSource, fish: fishSource }[name](bin);
        const script = `${stem}.${name}`;
        fs.writeFileSync(script, source, { mode: 0o600 });
        files.push(script);
        args = name === 'bash' ? ['--login', '-i'] : ['-l', '-i'];
        initializeCommand = `source ${name === 'fish' ? fishQuote(script) : shQuote(script)}`;
    }
    // Other shells (cmd, sh, nu, ...) still find the PATH shims set in their environment.
    return {
        args, command: initializeCommand, sessionFile, pathPrepend: bin,
        env: { TC_SESSION_FILE: sessionFile, TC_NODE: executable, TC_LAUNCHER: LAUNCHER, TC_SETTINGS: settings, TC_SHIM_DIR: bin },
        cleanup() { for (const file of files) { try { fs.unlinkSync(file); } catch {} } }
    };
}
module.exports = { prepareIntegration, powershellSource, bashSource, zshSource, fishSource, writeShims, shimSources };
