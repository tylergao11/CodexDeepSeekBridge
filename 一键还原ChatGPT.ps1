param(
  [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\scripts\one-key-chatgpt-default.ps1" @PSBoundParameters
