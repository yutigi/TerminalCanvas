# Loaded after the user's profile. Keep its prompt and report FileSystem locations only.
$global:TerminalCanvasOriginalPrompt = $function:prompt
$global:TerminalCanvasDirectoryToken = $env:TERMINAL_CANVAS_CWD_TOKEN
Remove-Item Env:\TERMINAL_CANVAS_CWD_TOKEN -ErrorAction SilentlyContinue
function global:prompt {
    $location = Get-Location
    $directory = ''
    if ($location.Provider.Name -eq 'FileSystem') { $directory = $location.ProviderPath }
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($directory))
    [Console]::Write(([string][char]27) + ']777;tc-cwd;' + $global:TerminalCanvasDirectoryToken + ';' + $encoded + [char]7)
    if ($global:TerminalCanvasOriginalPrompt) { & $global:TerminalCanvasOriginalPrompt }
    else { 'PS ' + $location + '> ' }
}

# Invalidate the prompt's location when an actual command is accepted, including
# queued launch commands and multiline PSReadLine input. Preserve the user's reader.
if (Test-Path Function:\PSConsoleHostReadLine) {
    $global:TerminalCanvasOriginalReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
        $line = & $global:TerminalCanvasOriginalReadLine
        [Console]::Write(([string][char]27) + ']777;tc-cwd;' + $global:TerminalCanvasDirectoryToken + ';' + [char]7)
        $line
    }
}
