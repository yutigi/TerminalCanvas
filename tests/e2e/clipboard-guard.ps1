# Keep a materialized copy of every native format in an STA process until the Node test is done.
# EOF on stdin also restores the clipboard if the parent exits unexpectedly.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$snapshot = New-Object System.Windows.Forms.DataObject
$source = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $source) {
    foreach ($format in $source.GetFormats($false)) {
        $value = $source.GetData($format, $false)
        if ($null -eq $value) { throw "Could not materialize clipboard format: $format" }
        if ($value -is [System.IO.Stream]) {
            $copy = New-Object System.IO.MemoryStream
            if ($value.CanSeek) { $value.Position = 0 }
            $value.CopyTo($copy)
            $copy.Position = 0
            $value = $copy
        } elseif ($value -is [System.Drawing.Image]) {
            $value = $value.Clone()
        } elseif ($value -is [System.Array]) {
            $value = $value.Clone()
        }
        $snapshot.SetData($format, $false, $value)
    }
}
[Console]::Out.WriteLine('CLIPBOARD_SAVED')
try { [void][Console]::In.ReadLine() }
finally {
    if ($snapshot.GetFormats($false).Length -gt 0) {
        [System.Windows.Forms.Clipboard]::SetDataObject($snapshot, $true, 10, 100)
    } else { [System.Windows.Forms.Clipboard]::Clear() }
    [Console]::Out.WriteLine('CLIPBOARD_RESTORED')
}
