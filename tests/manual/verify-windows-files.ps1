# Read-only file checks; PowerShell 5.1 is sufficient. No Node/Rust/provider tools required.
param(
    [Parameter(Mandatory=$true)][string]$ElectronExport,
    [Parameter(Mandatory=$true)][string]$RustExport
)
$ErrorActionPreference = 'Stop'

function Assert-Equivalent($Left, $Right, [string]$At) {
    if ($null -eq $Left -or $null -eq $Right) {
        if ($null -ne $Left -or $null -ne $Right) { throw "Layout mismatch at $At" }
        return
    }
    if ($Left -is [Array] -or $Right -is [Array]) {
        if ($Left -isnot [Array] -or $Right -isnot [Array] -or $Left.Count -ne $Right.Count) { throw "Array mismatch at $At" }
        for ($index=0; $index -lt $Left.Count; $index++) { Assert-Equivalent $Left[$index] $Right[$index] "$At[$index]" }
        return
    }
    if ($Left -is [pscustomobject] -or $Right -is [pscustomobject]) {
        if ($Left -isnot [pscustomobject] -or $Right -isnot [pscustomobject]) { throw "Object mismatch at $At" }
        $names=@($Left.PSObject.Properties.Name | Sort-Object)
        $other=@($Right.PSObject.Properties.Name | Sort-Object)
        if (($names -join '|') -cne ($other -join '|')) { throw "Property mismatch at $At" }
        foreach ($name in $names) { Assert-Equivalent $Left.$name $Right.$name "$At.$name" }
        return
    }
    if ($Left -is [string] -or $Right -is [string]) {
        if ($Left -isnot [string] -or $Right -isnot [string] -or $Left -cne $Right) { throw "Text mismatch at $At" }
    } elseif ($Left -ne $Right) { throw "Value mismatch at $At" }
}

function Read-Layout([string]$File) {
    $data=Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($data.version -ne 3) { throw 'The exported workspace must retain format 3' }
    if ($null -eq $data.assets -or @($data.assets.PSObject.Properties).Count -lt 1) { throw 'The portable export must contain an embedded image' }
    return $data
}

function Image-Hashes($Assets) {
    $result=[ordered]@{}
    foreach ($property in @($Assets.PSObject.Properties | Sort-Object Name)) {
        if ($property.Value -notmatch '^data:image/(png|jpeg|gif|webp);base64,(.+)$') { throw 'Unexpected embedded image format' }
        $bytes=[Convert]::FromBase64String($Matches[2])
        $sha=[Security.Cryptography.SHA256]::Create()
        try { $hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if (-not $property.Name.StartsWith($hash + '.')) { throw 'Embedded image name does not match its bytes' }
        $result[$property.Name]=$hash
    }
    return $result
}

$electron=Read-Layout $ElectronExport
$rust=Read-Layout $RustExport
foreach ($name in @('version','name','camera','cards','items')) { Assert-Equivalent $electron.$name $rust.$name $name }
$original=Image-Hashes $electron.assets
$restored=Image-Hashes $rust.assets
if (($original.Keys -join '|') -cne ($restored.Keys -join '|')) { throw 'Image sets differ' }
foreach ($name in $original.Keys) { if ($original[$name] -cne $restored[$name]) { throw 'Image bytes differ' } }
$os=Get-CimInstance Win32_OperatingSystem
$folders=@()
foreach ($name in @('terminal-canvas','Terminal Canvas')) {
    $file=Join-Path (Join-Path $env:APPDATA $name) 'workspace.terminalcanvas'
    if (Test-Path -LiteralPath $file) {
        $saved=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        $folders += [pscustomobject]@{ folder=$name; workspace=$saved.name; cards=@($saved.cards).Count; items=@($saved.items).Count }
    }
}
[pscustomobject]@{
    passed=$true; layoutMatch=$true; imageBytesMatch=$true; images=$original.Count
    windows=$os.Caption; version=$os.Version; build=$os.BuildNumber
    dataFolders=$folders
    note='Native launch, rendering, zero running cards, installer, shutdown, and automatic restoration must be observed separately.'
} | ConvertTo-Json -Depth 20
