param()

$ErrorActionPreference = "Stop"

function Get-CodexHome {
  if ($env:CODEX_HOME) { return $env:CODEX_HOME }
  return Join-Path $env:USERPROFILE ".codex"
}

function Get-ProjectRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-ProxyInstallDir {
  param([string]$CodexHome = (Get-CodexHome))
  return Join-Path $CodexHome "deepseek-responses-proxy"
}

function Get-ProxyPort {
  if ($env:DEEPSEEK_RESPONSES_PROXY_PORT) { return [int]$env:DEEPSEEK_RESPONSES_PROXY_PORT }
  return 18081
}

function Get-DeepSeekCodexDefaults {
  $port = Get-ProxyPort
  return [pscustomobject]@{
    Model = "deepseek-v4-pro"
    Provider = "deepseek"
    ReasoningEffort = "xhigh"
    ProviderName = "DeepSeek Pro (local Responses proxy)"
    BaseUrl = "http://127.0.0.1:$port/v1"
    EnvKey = "DEEPSEEK_API_KEY"
    WireApi = "responses"
  }
}

function Get-ChatGptCodexDefaults {
  return [pscustomobject]@{
    Model = "gpt-5.5"
    ReasoningEffort = "medium"
  }
}

function Set-TomlTopLevel {
  param([string]$Text, [string]$Key, [string]$Value)
  $line = "$Key = $Value"
  if ($Text -match "(?m)^$([regex]::Escape($Key))\s*=") {
    return [regex]::Replace($Text, "(?m)^$([regex]::Escape($Key))\s*=.*$", $line, 1)
  }
  return "$line`r`n$Text"
}

function Remove-TomlTopLevel {
  param([string]$Text, [string]$Key)
  return [regex]::Replace($Text, "(?m)^$([regex]::Escape($Key))\s*=.*\r?\n?", "")
}

function Remove-TomlTable {
  param([string]$Text, [string]$TableName)
  $escaped = [regex]::Escape($TableName)
  return [regex]::Replace($Text, "(?ms)^\[$escaped\]\r?\n.*?(?=^\[|\z)", "")
}

function Get-CodexRuntimeNode {
  $codexHome = Get-CodexHome
  $candidates = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\runtimes") -Filter node.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($candidates -and $candidates.Count -gt 0) {
    return $candidates[0].FullName
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return $node.Source }
  throw "Node.js not found. Install Node or start Codex once so its bundled runtime exists."
}

function Get-CodexExe {
  $candidates = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin") -Filter codex.exe -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($candidates -and $candidates.Count -gt 0) {
    return $candidates[0].FullName
  }
  $command = Get-Command codex -ErrorAction SilentlyContinue
  if ($command -and $command.Source) { return $command.Source }
  throw "codex.exe not found. Install Codex Desktop/CLI first."
}

function Get-DeepSeekApiKey {
  $key = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
  if ([string]::IsNullOrWhiteSpace($key)) {
    $key = $env:DEEPSEEK_API_KEY
  }
  return $key
}

function Set-DeepSeekApiKey {
  param([string]$ApiKey)
  if ([string]::IsNullOrWhiteSpace($ApiKey)) { throw "ApiKey is empty." }
  [Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", $ApiKey, "User")
  $env:DEEPSEEK_API_KEY = $ApiKey
}

function Get-ProxyProcesses {
  $port = Get-ProxyPort
  $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
  if (-not $connections) { return @() }
  $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  return $pids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
}
