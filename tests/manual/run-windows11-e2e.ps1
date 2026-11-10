# Portable, test-only runtime. It never opens normal Terminal Canvas user data.
$ErrorActionPreference='Stop'
$kit=$PSScriptRoot
$previousPath=$env:PATH
$previousTarget=$env:CARGO_TARGET_DIR
$previousTelemetry=$env:POWERSHELL_TELEMETRY_OPTOUT
Push-Location $kit
try {
    $env:PATH=(Join-Path $kit 'tools\pwsh')+';'+(Join-Path $kit 'tools\node')+';'+$env:PATH
    $env:CARGO_TARGET_DIR=Join-Path $kit 'target'
    $env:POWERSHELL_TELEMETRY_OPTOUT='1'
    $node=Join-Path $kit 'tools\node\node.exe'
    New-Item -ItemType Directory -Force -Path (Join-Path $kit '.cache') | Out-Null
    $os=Get-CimInstance Win32_OperatingSystem
    Write-Host "Native test OS: $($os.Caption), build $($os.BuildNumber)"
    & $node tests/e2e/preflight.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Portable test startup failed' }
    $files=@(Get-ChildItem -LiteralPath tests/e2e -Filter '*.test.cjs' | Sort-Object Name | ForEach-Object { $_.FullName })
    & $node --test --test-concurrency=1 @files 2>&1 | Tee-Object -FilePath .cache/windows11-e2e.log
    if ($LASTEXITCODE -ne 0) { throw "Desktop parity failed; retain .cache\windows11-e2e.log and screenshots" }
    Write-Host 'Portable desktop parity passed. Retain the log and OS edition/build.'
} finally {
    Pop-Location
    $env:PATH=$previousPath
    $env:CARGO_TARGET_DIR=$previousTarget
    $env:POWERSHELL_TELEMETRY_OPTOUT=$previousTelemetry
}
