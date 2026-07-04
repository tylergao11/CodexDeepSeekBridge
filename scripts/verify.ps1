. "$PSScriptRoot\common.ps1"

$projectRoot = Get-ProjectRoot
$node = Get-CodexRuntimeNode
& $node --check (Join-Path $projectRoot "src\proxy.js")
& $node (Join-Path $projectRoot "tests\proxy-contract.test.js")

$defaults = Get-DeepSeekCodexDefaults
$configPath = Join-Path (Get-CodexHome) "config.toml"
$config = Get-Content -LiteralPath $configPath -Raw
if ($config -notmatch "(?m)^model\s*=\s*`"$([regex]::Escape($defaults.Model))`"\s*$") {
  throw "Codex config is not using model $($defaults.Model): $configPath"
}
if ($config -notmatch "(?m)^model_provider\s*=\s*`"$([regex]::Escape($defaults.Provider))`"\s*$") {
  throw "Codex config is not using model_provider $($defaults.Provider): $configPath"
}
if ($config -notmatch '(?m)^\[model_providers\.deepseek\]\s*$') {
  throw "Codex config is missing [model_providers.deepseek]: $configPath"
}
if ($config -notmatch "(?m)^base_url\s*=\s*`"$([regex]::Escape($defaults.BaseUrl))`"\s*$") {
  throw "Codex DeepSeek provider base_url is not $($defaults.BaseUrl): $configPath"
}

& "$PSScriptRoot\status.ps1"

try {
  $codexExe = Get-CodexExe
  $env:DEEPSEEK_API_KEY = Get-DeepSeekApiKey
  & $codexExe --strict-config doctor --summary --no-color --ascii
} catch {
  Write-Output "codex.exe not found in PATH; skipped doctor."
}
