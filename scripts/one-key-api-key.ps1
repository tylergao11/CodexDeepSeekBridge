param(
  [string]$ApiKey = "",
  [switch]$ForcePrompt,
  [switch]$UseExistingAnthropicToken
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

if ([string]::IsNullOrWhiteSpace($ApiKey) -and -not $ForcePrompt) {
  $ApiKey = Get-DeepSeekApiKey
}

if ([string]::IsNullOrWhiteSpace($ApiKey) -and $UseExistingAnthropicToken) {
  $ApiKey = [Environment]::GetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "User")
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  $secure = Read-Host "Paste DeepSeek API key" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $ApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
  throw "DeepSeek API key is empty."
}

& "$PSScriptRoot\install.ps1" -ApiKey $ApiKey
& "$PSScriptRoot\verify.ps1"
Write-Output "Done. Restart Codex to use DeepSeek V4 Pro with xhigh reasoning."
