const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
const shQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function powershellSource(settings) {
    return `
function global:__tc_emit($event) {
    $json = ConvertTo-Json -Compress -InputObject $event
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Console]::Write(([char]27).ToString() + ']633;TC;' + $encoded + [char]7)
}
$script:tcOriginalPrompt = $function:prompt
function global:prompt {
    if ((Get-Location).Provider.Name -eq 'FileSystem') { __tc_emit @{ type = 'cwd'; cwd = (Get-Location).ProviderPath } }
    if ($script:tcOriginalPrompt) { & $script:tcOriginalPrompt } else { 'PS ' + (Get-Location) + '> ' }
}
function global:__tc_agent($provider, $arguments) {
    try {
        $executable = (Get-Command -Name $provider -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $executable) { $executable = (Get-Command -Name $provider -CommandType ExternalScript -ErrorAction Stop | Select-Object -First 1).Source }
    }
    catch { __tc_emit @{ type = 'warning'; message = 'The AI tool is unavailable. Install it on PATH, or stop this terminal and use Start fresh shell. The saved ID is retained.' }; Write-Error ($provider + ' is unavailable.'); return }
    $env:TC_LAUNCH_TOKEN = [guid]::NewGuid().ToString()
    $sessionId = $null
    $extra = @()
    for ($i = 0; $i -lt $arguments.Count; $i++) {
        if ($arguments[$i] -match '^(--resume|-r|--session-id)$' -or ($provider -eq 'codex' -and $arguments[$i] -eq 'resume')) {
            if ($i + 1 -lt $arguments.Count -and $arguments[$i + 1] -match '^[a-fA-F0-9-]{36}$') { $sessionId = $arguments[$i + 1] }
        }
    }
    if ($provider -eq 'claude') {
        if ($arguments.Count -eq 0) { $sessionId = [guid]::NewGuid().ToString(); $extra += @('--session-id', $sessionId) }
        if (-not ($arguments -match '^--settings(=|$)')) { $extra += @('--settings', ${psQuote(settings)}) }
    }
    __tc_emit @{ type = 'launch'; provider = $provider; token = $env:TC_LAUNCH_TOKEN; cwd = (Get-Location).ProviderPath; sessionId = $sessionId }
    & $executable @arguments @extra
    $tcSucceeded = $?
    $tcExit = $LASTEXITCODE
    if (-not $tcSucceeded -and -not $tcExit) { $tcExit = 1 }
    __tc_emit @{ type = 'end'; token = $env:TC_LAUNCH_TOKEN; exitCode = $tcExit }
    $global:LASTEXITCODE = $tcExit
}
function global:claude { __tc_agent 'claude' $args }
function global:codex { __tc_agent 'codex' $args }
`;
}

function bashSource(settings) {
    return `
__tc_agent() {
    local provider="$1"; shift
    local executable session_id="" token previous="" argument code
    executable=$(type -P "$provider")
    if [ -z "$executable" ]; then printf '%s is unavailable. Install it on PATH, or use Start fresh to open a shell.\\n' "$provider" >&2; return 127; fi
    token=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
    export TC_LAUNCH_TOKEN="$token"
    for argument in "$@"; do
        case "$previous" in --resume|-r|--session-id|resume) session_id="$argument";; esac
        previous="$argument"
    done
    local extra=()
    if [ "$provider" = claude ]; then
        if [ "$#" -eq 0 ]; then session_id="$token"; extra+=(--session-id "$session_id"); fi
        case " $* " in *' --settings '*|*' --settings='*) ;; *) extra+=(--settings ${shQuote(settings)});; esac
    fi
    ELECTRON_RUN_AS_NODE=1 "$TC_NODE" "$TC_HOOK" emit launch "$provider" "$session_id"
    "$executable" "$@" "\${extra[@]}"
    code=$?
    ELECTRON_RUN_AS_NODE=1 "$TC_NODE" "$TC_HOOK" emit end "$code"
    return "$code"
}
claude() { __tc_agent claude "$@"; }
codex() { __tc_agent codex "$@"; }
__tc_cwd() { printf '\\033]7;file://localhost%s\\007' "$(pwd -P | sed 's/%/%25/g; s/ /%20/g; s/#/%23/g; s/?/%3F/g')"; }
if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(__tc_cwd "\${PROMPT_COMMAND[@]}")
else
    PROMPT_COMMAND="__tc_cwd\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
`;
}

// Intercept ordinary CLI launches without changing global CLI settings.
function prepareIntegration({ folder, executable = process.execPath, platform = process.platform, shell }) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stem = path.join(folder, randomUUID());
    const sessionFile = `${stem}.json`, settings = `${stem}.settings.json`;
    const hook = path.join(__dirname, 'session-hook.cjs');
    const windows = platform === 'win32';
    const ps = `$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8); $payload = $reader.ReadToEnd(); $reader.Dispose(); $OutputEncoding = New-Object Text.UTF8Encoding $false; $env:ELECTRON_RUN_AS_NODE = '1'; $payload | & ${psQuote(executable)} ${psQuote(hook)} claude`;
    const command = windows
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`
        : `ELECTRON_RUN_AS_NODE=1 ${shQuote(executable)} ${shQuote(hook)} claude`;
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }), { mode: 0o600 });
    const source = windows ? powershellSource(settings) : bashSource(settings);
    const script = `${stem}.${windows ? 'ps1' : 'bash'}`;
    fs.writeFileSync(script, source, { mode: 0o600 });
    let args, initializeCommand;
    if (windows) args = ['-NoLogo', '-NoExit', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
    else if (path.basename(shell) === 'bash') {
        // Login profiles keep control of environment setup and whether .bashrc is sourced.
        // Queue integration as the first input command, after Bash finishes those profiles.
        args = ['--login', '-i'];
        initializeCommand = `source ${shQuote(script)}`;
    }
    return {
        args, command: initializeCommand, sessionFile,
        env: { TC_SESSION_FILE: sessionFile, TC_NODE: executable, TC_HOOK: hook },
        cleanup() { for (const file of [sessionFile, settings, script]) { try { fs.unlinkSync(file); } catch {} } }
    };
}
module.exports = { prepareIntegration, powershellSource, bashSource };
