param([Parameter(Mandatory=$true)][string]$DataDir,[int]$ParentPid)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tray=[Windows.Forms.NotifyIcon]::new();$tray.Icon=[Drawing.SystemIcons]::Information;$tray.Text='Codex 用量看板 v2';$tray.Visible=$true
$menu=[Windows.Forms.ContextMenuStrip]::new();[void]$menu.Items.Add('显示Codex 用量看板');[void]$menu.Items.Add('退出');$tray.ContextMenuStrip=$menu
$menu.Items[0].Add_Click({[Console]::Out.WriteLine('show');[Console]::Out.Flush()});$tray.Add_DoubleClick({[Console]::Out.WriteLine('show');[Console]::Out.Flush()})
$menu.Items[1].Add_Click({[Console]::Out.WriteLine('quit');[Console]::Out.Flush();[Windows.Forms.Application]::Exit()})
$seen=[Collections.Generic.HashSet[string]]::new();$first=$true
function Compact($n){if($null-eq $n){return '待核实'};if($n-ge 1e8){return ('{0:0.##}亿' -f ($n/1e8))};if($n-ge 1e4){return ('{0:0.##}万' -f ($n/1e4))};return [string]$n}
$timer=[Windows.Forms.Timer]::new();$timer.Interval=2000
$timer.Add_Tick({
 try{$process=[Diagnostics.Process]::GetProcessById($ParentPid);$process.Dispose()}catch{[Windows.Forms.Application]::Exit();return}
 try {
  $status=Get-Content -LiteralPath (Join-Path $DataDir 'status.json') -Raw -Encoding UTF8|ConvertFrom-Json
  $notices=Get-Content -LiteralPath (Join-Path $DataDir 'usage-notices.json') -Raw -Encoding UTF8|ConvertFrom-Json
  foreach($n in @($notices.notices)){if($n.id -and $seen.Add($n.id) -and !$script:first -and $n.accountScope -eq $status.accountKey -and $n.endedAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-60000){$points=if($null-eq $n.weekly.observedPoints){'待核实'}else{'{0:0.00}%*' -f $n.weekly.observedPoints};$tray.BalloonTipTitle='本轮已完成';$tray.BalloonTipText='Token '+(Compact $n.usage.total)+' · 周额 '+$points;$tray.ShowBalloonTip(5000)}}
  $script:first=$false
 }catch{}
})
try{$timer.Start();[Windows.Forms.Application]::Run()}finally{$timer.Dispose();$tray.Visible=$false;$tray.Dispose();$menu.Dispose()}
