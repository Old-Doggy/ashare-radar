# Generate daily briefing PDF + PNG without a server.
# Edge is given an ASCII-only temp path to avoid code-page issues with Chinese paths.
# Each Edge invocation has a timeout; the two output files are copied atomically
# (write to *.tmp in the destination directory, then rename) and every run writes a log
# to logs/briefing_<stamp>.log. Failures throw so update.ps1 can warn; data publication
# is intentionally not blocked by briefing generation.
param(
  [int]$TimeoutSec = 180
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$log = Join-Path $logDir "briefing_$stamp.log"
function Write-BriefingLog([string]$message) {
  $line = "[briefing] $message"
  Write-Host $line
  $line | Out-File -LiteralPath $log -Encoding utf8 -Append
}

# Run a headless browser with a hard timeout; kill the process tree on expiry.
function Invoke-Headless([string]$filePath, [string]$arguments) {
  $errFile = Join-Path $tmp "edge_$([Guid]::NewGuid().ToString('N').Substring(0,6)).err.log"
  $proc = Start-Process -FilePath $filePath -ArgumentList $arguments -NoNewWindow -PassThru `
    -RedirectStandardError $errFile -RedirectStandardOutput (Join-Path $tmp "edge_out.log")
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
    throw "headless browser timed out after ${TimeoutSec}s (see $errFile)"
  }
  if (Test-Path -LiteralPath $errFile) {
    Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue | Out-File -LiteralPath $log -Encoding utf8 -Append
  }
  return $proc.ExitCode
}

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) { throw "Edge/Chrome not found" }
Write-BriefingLog "start; edge=$edge; timeout=${TimeoutSec}s"

$html = Join-Path $root "frontend\dist\ashare-radar.html"
if (-not (Test-Path $html)) { throw "Run python -m pipeline.export_static first" }

$stampDay = Get-Date -Format "yyyyMMdd"
$outDir = Join-Path $root "data\snapshots\$stampDay"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tmp = Join-Path $env:TEMP "ashare-radar_briefing"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$tmpHtml = Join-Path $tmp "dashboard.html"
$tmpPdf = Join-Path $tmp "briefing.pdf"
$tmpPng = Join-Path $tmp "briefing.png"
Copy-Item $html $tmpHtml -Force
Remove-Item $tmpPdf, $tmpPng -Force -ErrorAction SilentlyContinue

$url = "file:///" + ($tmpHtml -replace "\\", "/") + "#/briefing"
$common = "--headless=new --disable-gpu --no-first-run --allow-file-access-from-files --virtual-time-budget=12000"

$pdfArgs = "$common --no-pdf-header-footer --print-to-pdf=`"$tmpPdf`" `"$url`""
$code = Invoke-Headless $edge $pdfArgs
Write-BriefingLog "pdf edge exit=$code"
if ($code -ne 0 -or -not (Test-Path $tmpPdf)) { throw "PDF generation failed (edge exit $code; log: $log)" }

$pngArgs = "$common --hide-scrollbars --window-size=1240,1754 --screenshot=`"$tmpPng`" `"$url`""
$code = Invoke-Headless $edge $pngArgs
Write-BriefingLog "png edge exit=$code"
if ($code -ne 0 -or -not (Test-Path $tmpPng)) { throw "PNG generation failed (edge exit $code; log: $log)" }

# Atomic publish: copy next to the destination, then rename over the final name.
$pdf = Join-Path $outDir "briefing.pdf"
$png = Join-Path $outDir "briefing.png"
Copy-Item $tmpPdf (Join-Path $outDir "briefing.pdf.tmp") -Force
Move-Item -LiteralPath (Join-Path $outDir "briefing.pdf.tmp") -Destination $pdf -Force
Copy-Item $tmpPng (Join-Path $outDir "briefing.png.tmp") -Force
Move-Item -LiteralPath (Join-Path $outDir "briefing.png.tmp") -Destination $png -Force
Write-BriefingLog "PDF -> $pdf ($((Get-Item $pdf).Length) bytes)"
Write-BriefingLog "PNG -> $png ($((Get-Item $png).Length) bytes)"
Write-BriefingLog "OK"
Write-Host "[briefing] PDF -> $pdf"
Write-Host "[briefing] PNG -> $png"
