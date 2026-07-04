param(
  [int]$TimeoutSeconds = 300
)

. "$PSScriptRoot\common.ps1"

$ErrorActionPreference = "Stop"
$projectRoot = Get-ProjectRoot
$codexExe = Get-CodexExe
$key = Get-DeepSeekApiKey
if ([string]::IsNullOrWhiteSpace($key)) {
  throw "DEEPSEEK_API_KEY is not set in this process or the user environment."
}

$root = Join-Path $projectRoot "tmp\agent-concurrency"
if (Test-Path $root) {
  Remove-Item -LiteralPath $root -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
Set-Content -LiteralPath (Join-Path $root "README.md") -Encoding UTF8 -Value "concurrency fixture"

$cases = @(
  [pscustomobject]@{
    Name = "read"
    Sandbox = "read-only"
    Prompt = "Read README.md. After reading it, reply exactly read-ok."
    MarkerFile = ""
    MarkerText = "read-ok"
  },
  [pscustomobject]@{
    Name = "alpha"
    Sandbox = "workspace-write"
    Prompt = "Create alpha.txt with exactly this content: alpha-ok. Then reply exactly alpha-done."
    MarkerFile = "alpha.txt"
    MarkerText = "alpha-ok"
  },
  [pscustomobject]@{
    Name = "beta"
    Sandbox = "workspace-write"
    Prompt = "Create beta.txt with exactly this content: beta-ok. Run a directory listing. Then reply exactly beta-done."
    MarkerFile = "beta.txt"
    MarkerText = "beta-ok"
  }
)

$jobs = foreach ($case in $cases) {
  Start-Job -Name $case.Name -ArgumentList $codexExe,$root,$case.Sandbox,$case.Prompt,$key -ScriptBlock {
    param($codexExe,$root,$sandbox,$prompt,$key)
    $env:DEEPSEEK_API_KEY = $key
    $args = @(
      "-a", "never",
      "-s", $sandbox,
      "-C", $root,
      "exec",
      "--skip-git-repo-check",
      $prompt
    )
    & $codexExe @args
    if ($LASTEXITCODE -ne 0) {
      throw "codex exited with $LASTEXITCODE"
    }
  }
}

$completed = Wait-Job -Job $jobs -Timeout $TimeoutSeconds
if ($completed.Count -ne $jobs.Count) {
  $jobs | Stop-Job -ErrorAction SilentlyContinue
  throw "Only $($completed.Count)/$($jobs.Count) concurrent Codex jobs completed within $TimeoutSeconds seconds."
}

foreach ($job in $jobs) {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = Receive-Job -Job $job -Keep 2>&1 | Out-String
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($job.State -ne "Completed") {
    Write-Output $output
    throw "Concurrent job $($job.Name) ended in state $($job.State)."
  }
  $case = $cases | Where-Object { $_.Name -eq $job.Name } | Select-Object -First 1
  if ($output -notmatch [regex]::Escape($case.MarkerText)) {
    Write-Output $output
    throw "Concurrent job $($job.Name) output missing $($case.MarkerText)."
  }
  if ($case.MarkerFile) {
    $file = Join-Path $root $case.MarkerFile
    if (!(Test-Path $file)) { throw "Concurrent job $($job.Name) did not create $($case.MarkerFile)." }
    $text = Get-Content -LiteralPath $file -Raw
    if ($text -notmatch [regex]::Escape($case.MarkerText)) {
      throw "Concurrent job $($job.Name) file missing $($case.MarkerText)."
    }
  }
  Write-Output "PASS concurrent $($job.Name)"
}

Remove-Job -Job $jobs -Force
Write-Output "agent concurrency passed"
