param(
  [string]$ApiKey = "",
  [switch]$ForcePrompt,
  [switch]$UseExistingAnthropicToken
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\scripts\one-key-api-key.ps1" @PSBoundParameters
