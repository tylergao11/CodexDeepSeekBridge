. "$PSScriptRoot\common.ps1"

$port = Get-ProxyPort
$processes = Get-ProxyProcesses
if ($processes.Count -eq 0) {
  Write-Output "DeepSeek bridge: stopped"
  exit 0
}

Write-Output "DeepSeek bridge: running"
foreach ($process in $processes) {
  Write-Output "pid=$($process.Id) path=$($process.Path)"
}
try {
  $models = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 5
  Write-Output "models=$($models.models.slug -join ',')"
} catch {
  Write-Output "models endpoint failed: $($_.Exception.Message)"
}
