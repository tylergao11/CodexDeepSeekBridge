. "$PSScriptRoot\common.ps1"

$codexHome = Get-CodexHome
$proxyDir = Get-ProxyInstallDir $codexHome
$proxyFile = Join-Path $proxyDir "proxy.js"
$sourceProxy = Join-Path (Get-ProjectRoot) "src\proxy.js"
$defaults = Get-DeepSeekCodexDefaults
New-Item -ItemType Directory -Force -Path $proxyDir | Out-Null
Copy-Item -LiteralPath $sourceProxy -Destination $proxyFile -Force
Write-Output "Deployed proxy.js to $proxyFile"

$existing = Get-ProxyProcesses
if ($existing.Count -gt 0) {
  Write-Output "DeepSeek bridge already running: pid=$($existing.Id -join ',')"
  exit 0
}

$key = Get-DeepSeekApiKey
if ([string]::IsNullOrWhiteSpace($key)) {
  throw "DEEPSEEK_API_KEY is not set. Run scripts\install.ps1 -ApiKey <your-key> or set the user environment variable."
}

$node = Get-CodexRuntimeNode
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "`"$proxyFile`""
$psi.WindowStyle = "Hidden"
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DEEPSEEK_API_KEY"] = $key
$psi.EnvironmentVariables["DEEPSEEK_MODEL"] = $defaults.Model
$process = [System.Diagnostics.Process]::Start($psi)
Start-Sleep -Milliseconds 800
Write-Output "DeepSeek bridge started: pid=$($process.Id) url=$($defaults.BaseUrl)"
