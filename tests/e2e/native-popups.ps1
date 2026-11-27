# Lists the visible top-level windows that the app's WebView2 processes show, such as WebView2's own
# context menu, waiting up to -WaitMs for one to appear. Prints one line per window and nothing when
# there is none. The app's window and the webview inside it belong to the app process, not to these.
param([Parameter(Mandatory = $true)][int]$AppPid, [int]$WaitMs = 1000)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class TerminalCanvasPopups {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    public static List<string> Visible(HashSet<uint> pids) {
        var found = new List<string>();
        EnumWindows((window, data) => {
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pids.Contains(pid) && IsWindowVisible(window)) {
                var name = new StringBuilder(256);
                GetClassName(window, name, name.Capacity);
                Rect rect;
                GetWindowRect(window, out rect);
                found.Add(name + " " + (rect.Right - rect.Left) + "x" + (rect.Bottom - rect.Top));
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
$processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)
$tree = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$tree.Add([uint32]$AppPid)
do {
    $added = $false
    foreach ($process in $processes) {
        if ($tree.Contains([uint32]$process.ParentProcessId) -and $tree.Add([uint32]$process.ProcessId)) { $added = $true }
    }
} while ($added)
# Terminal shells descend from the app too; only WebView2's processes draw browser menus.
$webview = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($process in $processes) {
    if ($process.Name -eq 'msedgewebview2.exe' -and $tree.Contains([uint32]$process.ProcessId)) { [void]$webview.Add([uint32]$process.ProcessId) }
}
if ($webview.Count -eq 0) { throw "No WebView2 process descends from $AppPid." }
$deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMs)
do {
    $found = [TerminalCanvasPopups]::Visible($webview)
    if ($found.Count -gt 0) { break }
    Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
$found | ForEach-Object { [Console]::Out.WriteLine($_) }
