param(
  [string]$BackupPath = ""
)

. "$PSScriptRoot\common.ps1"

$codexHome = Get-CodexHome
$configPath = Join-Path $codexHome "config.toml"
$defaults = Get-ChatGptCodexDefaults

& "$PSScriptRoot\stop.ps1"

if ($BackupPath) {
  if (!(Test-Path $BackupPath)) { throw "Backup not found: $BackupPath" }
  Copy-Item -LiteralPath $BackupPath -Destination $configPath -Force
  Write-Output "Restored config from backup: $BackupPath"
  exit 0
}

$config = Get-Content -LiteralPath $configPath -Raw
$config = Set-TomlTopLevel $config "model" "`"$($defaults.Model)`""
$config = Set-TomlTopLevel $config "model_reasoning_effort" "`"$($defaults.ReasoningEffort)`""
$config = Remove-TomlTopLevel $config "model_provider"
$config = Remove-TomlTable $config "model_providers.deepseek"
Set-Content -LiteralPath $configPath -Value $config -Encoding UTF8
Write-Output "Restored Codex config to OpenAI defaults in $configPath"
