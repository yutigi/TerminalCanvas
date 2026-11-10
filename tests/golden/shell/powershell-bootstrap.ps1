
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
