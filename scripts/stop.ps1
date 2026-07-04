. "$PSScriptRoot\common.ps1"

$processes = Get-ProxyProcesses
if ($processes.Count -eq 0) {
  Write-Output "DeepSeek bridge is not running."
  exit 0
}

foreach ($process in $processes) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
for ($i = 0; $i -lt 20; $i++) {
  if ((Get-ProxyProcesses).Count -eq 0) {
    Write-Output "DeepSeek bridge stopped: pid=$($processes.Id -join ',')"
    exit 0
  }
  Start-Sleep -Milliseconds 250
}
throw "DeepSeek bridge did not stop cleanly: pid=$($processes.Id -join ',')"
