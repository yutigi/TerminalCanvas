const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

function sampleProcessTree(seeds) {
    assert.ok(seeds.length && seeds.every(pid => Number.isSafeInteger(pid) && pid > 0));
    const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process);
$ids=[Collections.Generic.HashSet[int]]::new(); ${seeds.map(pid => `[void]$ids.Add(${pid})`).join('; ')};
$observer=[Collections.Generic.HashSet[int]]::new(); [void]$observer.Add($PID);
do { $added=$false; foreach($p in $all) {
    if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added=$true }
    if($observer.Contains([int]$p.ParentProcessId) -and $observer.Add([int]$p.ProcessId)) { $added=$true }
} } while($added);
@($all | Where-Object { $ids.Contains([int]$_.ProcessId) -and -not $observer.Contains([int]$_.ProcessId) } | ForEach-Object {
    $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;
    if($null -ne $p) {
        [pscustomobject]@{ pid=$p.Id; name=$p.ProcessName; privateBytes=$p.PrivateMemorySize64; workingSetBytes=$p.WorkingSet64 }
    }
}) | ConvertTo-Json -Compress`;
    const snapshot = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.ifError(snapshot.error); assert.equal(snapshot.status, 0, snapshot.stderr);
    const processes = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, ''));
    assert.ok(Array.isArray(processes));
    return { processes, privateBytes: processes.reduce((sum, process) => sum + process.privateBytes, 0),
        workingSetBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0) };
}
module.exports = { sampleProcessTree };
