param(
  [string]$ApiKey = "",
  [switch]$UseExistingAnthropicToken
)

. "$PSScriptRoot\common.ps1"

$codexHome = Get-CodexHome
$projectRoot = Get-ProjectRoot
$proxyDir = Get-ProxyInstallDir $codexHome
$configPath = Join-Path $codexHome "config.toml"
$sourceProxy = Join-Path $projectRoot "src\proxy.js"
$proxyFile = Join-Path $proxyDir "proxy.js"
$defaults = Get-DeepSeekCodexDefaults

New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
if (!(Test-Path $configPath)) {
  New-Item -ItemType File -Force -Path $configPath | Out-Null
}
if (!(Test-Path $sourceProxy)) { throw "Proxy source not found: $sourceProxy" }

if ([string]::IsNullOrWhiteSpace($ApiKey) -and $UseExistingAnthropicToken) {
  $ApiKey = [Environment]::GetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "User")
}
if (![string]::IsNullOrWhiteSpace($ApiKey)) {
  Set-DeepSeekApiKey $ApiKey
}
if ([string]::IsNullOrWhiteSpace((Get-DeepSeekApiKey))) {
  throw "DEEPSEEK_API_KEY is not set. Pass -ApiKey or set the user environment variable first."
}

$runningProxy = Get-ProxyProcesses
if ($runningProxy.Count -gt 0) {
  & "$PSScriptRoot\stop.ps1"
}

New-Item -ItemType Directory -Force -Path $proxyDir | Out-Null
Copy-Item -LiteralPath $sourceProxy -Destination $proxyFile -Force

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$configPath.before-codex-deepseek-bridge-$timestamp.bak"
Copy-Item -LiteralPath $configPath -Destination $backup -Force

$config = Get-Content -LiteralPath $configPath -Raw
$config = Set-TomlTopLevel $config "model" "`"$($defaults.Model)`""
$config = Set-TomlTopLevel $config "model_provider" "`"$($defaults.Provider)`""
$config = Set-TomlTopLevel $config "model_reasoning_effort" "`"$($defaults.ReasoningEffort)`""

$providerBlock = @"
[model_providers.deepseek]
name = "$($defaults.ProviderName)"
base_url = "$($defaults.BaseUrl)"
env_key = "$($defaults.EnvKey)"
wire_api = "$($defaults.WireApi)"
"@

$config = Remove-TomlTable $config "model_providers.deepseek"
$insertAt = $config.IndexOf("[marketplaces.")
if ($insertAt -ge 0) {
  $config = $config.Insert($insertAt, $providerBlock + "`r`n`r`n")
} else {
  $config = $config.TrimEnd() + "`r`n`r`n" + $providerBlock + "`r`n"
}

Set-Content -LiteralPath $configPath -Value $config -Encoding UTF8

& "$PSScriptRoot\start.ps1"

Write-Output "Installed Codex DeepSeek Bridge."
Write-Output "config=$configPath"
Write-Output "backup=$backup"
Write-Output "proxy=$proxyFile"
