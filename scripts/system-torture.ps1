param()

. "$PSScriptRoot\common.ps1"

$ErrorActionPreference = "Stop"
$projectRoot = Get-ProjectRoot
$oldCodexHome = $env:CODEX_HOME
$oldPort = $env:DEEPSEEK_RESPONSES_PROXY_PORT
$oldProcessDeepSeekKey = $env:DEEPSEEK_API_KEY
$testHome = Join-Path $projectRoot "tmp\system-codex-home"
$testPort = "19081"

function Assert-Text {
  param([string]$Text, [string]$Pattern, [string]$Message)
  if ($Text -notmatch $Pattern) { throw $Message }
}

try {
  if (Test-Path $testHome) {
    Remove-Item -LiteralPath $testHome -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $testHome | Out-Null
  Set-Content -LiteralPath (Join-Path $testHome "config.toml") -Encoding UTF8 -Value @"
model = "old-model"
model_reasoning_effort = "low"

[profiles.default]
approval_policy = "never"

[marketplaces.local]
enabled = true
"@

  $env:CODEX_HOME = $testHome
  $env:DEEPSEEK_RESPONSES_PROXY_PORT = $testPort

  & "$PSScriptRoot\install.ps1" -ApiKey "test-key-for-local-system-torture" -NoPersistApiKey
  $configPath = Join-Path $testHome "config.toml"
  $config = Get-Content -LiteralPath $configPath -Raw
  Assert-Text $config '(?m)^model_provider\s*=\s*"deepseek"\s*$' "install did not set model_provider."
  Assert-Text $config '(?m)^model\s*=\s*"deepseek-v4-pro"\s*$' "install did not set DeepSeek model."
  Assert-Text $config 'http://127\.0\.0\.1:19081/v1' "install did not use custom proxy port."
  Assert-Text $config '(?m)^\[model_providers\.deepseek\]\s*$' "install did not write provider block."
  Assert-Text $config '(?m)^\[marketplaces\.local\]\s*$' "install removed existing marketplace block."

  $status = & "$PSScriptRoot\status.ps1"
  if (($status -join "`n") -notmatch "running") { throw "temp bridge did not start on custom port." }
  $startAgain = & "$PSScriptRoot\start.ps1"
  if (($startAgain -join "`n") -notmatch "already running") { throw "start.ps1 is not idempotent when bridge is already running." }
  $models = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/v1/models" -TimeoutSec 5
  if ($models.models[0].slug -ne "deepseek-v4-pro") { throw "temp model endpoint returned wrong model." }

  & "$PSScriptRoot\restore.ps1"
  $restored = Get-Content -LiteralPath $configPath -Raw
  if ($restored -match "model_provider") { throw "restore did not remove model_provider." }
  if ($restored -match "\[model_providers\.deepseek\]") { throw "restore did not remove DeepSeek provider block." }
  Assert-Text $restored '(?m)^model\s*=\s*"gpt-5\.5"\s*$' "restore did not set default model."

  Write-Output "system torture temp CODEX_HOME passed"
} finally {
  try { & "$PSScriptRoot\stop.ps1" | Out-Null } catch {}
  if ($null -eq $oldCodexHome) { Remove-Item Env:\CODEX_HOME -ErrorAction SilentlyContinue } else { $env:CODEX_HOME = $oldCodexHome }
  if ($null -eq $oldPort) { Remove-Item Env:\DEEPSEEK_RESPONSES_PROXY_PORT -ErrorAction SilentlyContinue } else { $env:DEEPSEEK_RESPONSES_PROXY_PORT = $oldPort }
  if ($null -eq $oldProcessDeepSeekKey) { Remove-Item Env:\DEEPSEEK_API_KEY -ErrorAction SilentlyContinue } else { $env:DEEPSEEK_API_KEY = $oldProcessDeepSeekKey }
}
