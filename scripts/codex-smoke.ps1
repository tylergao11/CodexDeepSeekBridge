param(
  [string]$Prompt = "只输出 OK，不要解释。",
  [string]$Sandbox = "read-only"
)

. "$PSScriptRoot\common.ps1"

$key = Get-DeepSeekApiKey
if ([string]::IsNullOrWhiteSpace($key)) {
  throw "DEEPSEEK_API_KEY is not set in this process or the user environment."
}

$env:DEEPSEEK_API_KEY = $key
$codexExe = Get-CodexExe
& $codexExe -a never -s $Sandbox -C (Get-ProjectRoot) exec --skip-git-repo-check $Prompt
