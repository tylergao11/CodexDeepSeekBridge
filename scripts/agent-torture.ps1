param(
  [int]$TimeoutSeconds = 240
)

. "$PSScriptRoot\common.ps1"

$ErrorActionPreference = "Stop"
$projectRoot = Get-ProjectRoot
$codexExe = Get-CodexExe
$key = Get-DeepSeekApiKey
if ([string]::IsNullOrWhiteSpace($key)) {
  throw "DEEPSEEK_API_KEY is not set in this process or the user environment."
}
$env:DEEPSEEK_API_KEY = $key

$tortureRoot = Join-Path $projectRoot "tmp\agent-torture"
if (Test-Path $tortureRoot) {
  Remove-Item -LiteralPath $tortureRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tortureRoot | Out-Null

function Write-Utf8File {
  param([string]$Path, [string]$Text)
  $dir = Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Set-Content -LiteralPath $Path -Value $Text -Encoding UTF8
}

function Invoke-AgentCase {
  param(
    [string]$Name,
    [string]$Prompt,
    [string]$Sandbox = "read-only",
    [scriptblock]$Verify
  )

  Write-Output "=== CASE $Name ==="
  $outFile = Join-Path $tortureRoot "$Name.out.txt"
  $errFile = Join-Path $tortureRoot "$Name.err.txt"
  $args = @(
    "-a", "never",
    "-s", $Sandbox,
    "-C", $tortureRoot,
    "exec",
    "--skip-git-repo-check",
    $Prompt
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $codexExe @args > $outFile 2> $errFile
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $stdout = if (Test-Path $outFile) { Get-Content -LiteralPath $outFile -Raw } else { "" }
  $stderr = if (Test-Path $errFile) { Get-Content -LiteralPath $errFile -Raw } else { "" }
  if ($exitCode -ne 0) {
    Write-Output $stdout
    Write-Output $stderr
    throw "Case $Name failed with exit code $exitCode."
  }
  if ($Verify) {
    & $Verify $stdout $stderr
  }
  Write-Output "PASS $Name"
}

Write-Utf8File (Join-Path $tortureRoot "README.md") @"
# Agent Torture Fixture

This fixture is used to verify Codex can read, write, patch, and run shell commands through the DeepSeek bridge.
"@

Write-Utf8File (Join-Path $tortureRoot "package.json") @"
{
  "name": "agent-torture-fixture",
  "private": true,
  "scripts": {
    "test": "node calc.test.js"
  }
}
"@

Write-Utf8File (Join-Path $tortureRoot "calc.js") @"
function add(a, b) {
  return a - b;
}

module.exports = { add };
"@

Write-Utf8File (Join-Path $tortureRoot "calc.test.js") @"
const assert = require('assert');
const { add } = require('./calc');
assert.strictEqual(add(2, 3), 5);
console.log('fixture tests passed');
"@

Invoke-AgentCase -Name "01_ok" -Prompt "只输出 OK，不要解释。" -Verify {
  param($stdout)
  if ($stdout -notmatch "(?m)^OK\s*$") { throw "OK response not found." }
}

Invoke-AgentCase -Name "02_read_summary" -Prompt "读取 README.md 和 package.json，然后用两条短句说明这个 fixture 是做什么的。" -Verify {
  param($stdout)
  if ($stdout -notmatch "fixture|Fixture|测试|verify|验证") { throw "Expected fixture summary not found." }
}

Invoke-AgentCase -Name "03_write_file" -Sandbox "workspace-write" -Prompt "新建 result.md，内容必须包含一行：bridge-agent-write-ok。完成后只回复 done。" -Verify {
  $file = Join-Path $tortureRoot "result.md"
  if (!(Test-Path $file)) { throw "result.md was not created." }
  if ((Get-Content -LiteralPath $file -Raw) -notmatch "bridge-agent-write-ok") { throw "result.md missing expected marker." }
}

Invoke-AgentCase -Name "04_patch_and_test" -Sandbox "workspace-write" -Prompt "calc.js 里的 add 函数是错的。请修复它，然后运行 npm test。成功后只回复 fixed。" -Verify {
  $calc = Get-Content -LiteralPath (Join-Path $tortureRoot "calc.js") -Raw
  if ($calc -notmatch "return a \+ b") { throw "calc.js was not patched to addition." }
}

Invoke-AgentCase -Name "05_error_recovery" -Sandbox "workspace-write" -Prompt "先检查 missing-file.txt 是否存在。如果不存在，不要失败；请创建 recovered.txt，内容为 recovered-from-missing-file，然后只回复 recovered。" -Verify {
  $file = Join-Path $tortureRoot "recovered.txt"
  if (!(Test-Path $file)) { throw "recovered.txt was not created." }
  if ((Get-Content -LiteralPath $file -Raw) -notmatch "recovered-from-missing-file") { throw "recovered marker missing." }
}

Invoke-AgentCase -Name "06_multistep_context" -Sandbox "workspace-write" -Prompt "读取 calc.js、calc.test.js 和 result.md；然后新建 SUMMARY.md，列出 add 函数当前行为、测试命令、result.md 标记。最后只回复 summarized。" -Verify {
  $file = Join-Path $tortureRoot "SUMMARY.md"
  if (!(Test-Path $file)) { throw "SUMMARY.md was not created." }
  $text = Get-Content -LiteralPath $file -Raw
  if ($text -notmatch "add" -or $text -notmatch "npm test" -or $text -notmatch "bridge-agent-write-ok") {
    throw "SUMMARY.md missing expected context."
  }
}

Write-Output "agent torture workspace=$tortureRoot"
Write-Output "agent torture passed"
