param(
  [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"

if ($BackupPath) {
  & "$PSScriptRoot\restore.ps1" -BackupPath $BackupPath
} else {
  & "$PSScriptRoot\restore.ps1"
}
Write-Output "Done. Codex is back to the default ChatGPT login provider config. Restart Codex."
