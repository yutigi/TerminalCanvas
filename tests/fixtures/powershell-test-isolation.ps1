# Test shells must neither read/write personal history nor predict prior test commands.
$tcReadLine = Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue
if ($null -ne $tcReadLine) {
    Set-PSReadLineOption -HistorySaveStyle SaveNothing
    if ($tcReadLine.Parameters.ContainsKey('PredictionSource')) {
        Set-PSReadLineOption -PredictionSource None
    }
}
