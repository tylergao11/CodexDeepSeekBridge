. "$PSScriptRoot\common.ps1"

$processes = Get-ProxyProcesses
if ($processes.Count -eq 0) {
  Write-Output "DeepSeek bridge is not running."
  exit 0
}

foreach ($process in $processes) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
Write-Output "DeepSeek bridge stopped: pid=$($processes.Id -join ',')"
