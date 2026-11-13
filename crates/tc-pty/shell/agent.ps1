
function global:__tc_emit($event) {
    $json = ConvertTo-Json -Compress -InputObject $event
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    [Console]::Write(([char]27).ToString() + ']633;TC;' + $encoded + [char]7)
}
function global:__tc_agent($provider, $arguments) {
    try {
        $executable = (Get-Command -Name $provider -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
        if (-not $executable) { $executable = (Get-Command -Name $provider -CommandType ExternalScript -ErrorAction Stop | Select-Object -First 1).Source }
    }
    catch { __tc_emit @{ type = 'warning'; message = 'The AI tool is unavailable. Install it on PATH, or stop this terminal and use Start fresh shell. The saved ID is retained.' }; Write-Error ($provider + ' is unavailable.'); return }
    $env:TC_LAUNCH_TOKEN = [guid]::NewGuid().ToString()
    $sessionId = $null
    $prefix = @()
    $extra = @()
    for ($i = 0; $i -lt $arguments.Count; $i++) {
        if ($arguments[$i] -match '^(--resume|-r|--session-id)$' -or ($provider -eq 'codex' -and $arguments[$i] -eq 'resume')) {
            if ($i + 1 -lt $arguments.Count -and $arguments[$i + 1] -match '^[a-fA-F0-9-]{36}$') { $sessionId = $arguments[$i + 1] }
        }
    }
    if ($provider -eq 'claude') {
        if ($arguments.Count -eq 0) { $sessionId = [guid]::NewGuid().ToString(); $extra += @('--session-id', $sessionId) }
        if (-not ($arguments -match '^--settings(=|$)')) { $extra += @('--settings', {{SETTINGS}}) }
    }
    if ($provider -eq 'codex') { $prefix = @('-c', {{CODEX_HOOK}}) }
    __tc_emit @{ type = 'launch'; provider = $provider; token = $env:TC_LAUNCH_TOKEN; cwd = (Get-Location).ProviderPath; sessionId = $sessionId }
    & $executable @prefix @arguments @extra
    $tcSucceeded = $?
    $tcExit = $LASTEXITCODE
    if (-not $tcSucceeded -and -not $tcExit) { $tcExit = 1 }
    __tc_emit @{ type = 'end'; token = $env:TC_LAUNCH_TOKEN; exitCode = $tcExit }
    $global:LASTEXITCODE = $tcExit
}
function global:claude { __tc_agent 'claude' $args }
function global:codex { __tc_agent 'codex' $args }
