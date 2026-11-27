# Shared publication entry point: locking, gates, build and atomic export.
# Retry semantics: pipeline.release is idempotent for a given trading day (it re-checks
# existing days), so transient Tushare/network failures are retried here in-process.
# -Retries 2 means up to 3 total attempts; each attempt appends to the same log file.
# The exit code of the last attempt is returned, so the scheduled task can restart it too
# (see scripts/install_task.ps1 -RestartCount 3 -RestartInterval 10min).
param(
  [int]$Retries = 2,
  [int]$RetryDelaySec = 90
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("update_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
try {
  $py = & (Join-Path $PSScriptRoot "python.ps1")
} catch {
  "[update] FAILED: $_" | Tee-Object -FilePath $log
  exit 1
}

$attempts = [Math]::Max(1, $Retries + 1)
for ($attempt = 1; $attempt -le $attempts; $attempt++) {
  "[update] attempt $attempt/$attempts start $(Get-Date -Format o) (log: $log)" | Tee-Object -FilePath $log -Append
  & $py -m pipeline.release 2>&1 | Tee-Object -FilePath $log -Append
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    "[update] OK after $attempt attempt(s)" | Tee-Object -FilePath $log -Append
    break
  }
  if ($attempt -lt $attempts) {
    "[update] attempt $attempt failed (exit $code); retry in ${RetryDelaySec}s" | Tee-Object -FilePath $log -Append
    Start-Sleep -Seconds $RetryDelaySec
  } else {
    "[update] FAILED after $attempts attempt(s); previous HTML preserved; see $log" | Tee-Object -FilePath $log -Append
    exit $code
  }
}

try { & (Join-Path $PSScriptRoot "briefing.ps1") }
catch { Write-Warning "Dashboard published; briefing generation failed (see logs/)" }
Write-Host "[update] OK"
