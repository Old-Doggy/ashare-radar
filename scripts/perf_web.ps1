# 前端首屏性能实测：无头 Edge 加载离线单文件，输出 FCP / DCL / load / LCP。
# 依赖：frontend/node_modules/puppeteer-core（npm ci 后即有）、Edge 或 Chrome。
# 用法：
#   pwsh -NoProfile -File scripts/perf_web.ps1
#   pwsh -NoProfile -File scripts/perf_web.ps1 -Html frontend/dist/ashare-radar.html -Runs 5 -Out _perf_web.json
# 说明：数据为 file:// 本地加载（无网络）；测量时间、环境与包体积需与结果一起记录到 docs/performance.md。
param(
  [string]$Html = "frontend/dist/ashare-radar.html",
  [int]$Runs = 3,
  [string]$Out = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$htmlPath = if ([System.IO.Path]::IsPathRooted($Html)) { $Html } else { Join-Path $root $Html }
if (-not (Test-Path -LiteralPath $htmlPath)) { throw "HTML not found: $htmlPath (run npm run build + python -m pipeline.export_static first)" }

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Edge/Chrome not found" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found (Node 22.18+ required)" }

$frontend = Join-Path $root "frontend"
if (-not (Test-Path -LiteralPath (Join-Path $frontend "node_modules\puppeteer-core"))) {
  throw "frontend/node_modules/puppeteer-core missing; run: cd frontend; npm ci"
}

# 临时脚本放在 frontend/ 下，让 Node 能解析到 frontend/node_modules（ESM 不使用 NODE_PATH）。
$tmpScript = Join-Path $frontend (".perf_web_{0}.mjs" -f ([Guid]::NewGuid().ToString("N").Substring(0, 8)))
$fileUrl = "file:///" + ($htmlPath -replace "\\", "/")
$env:PERF_EDGE = $edge
$env:PERF_URL = $fileUrl
$env:PERF_RUNS = "$Runs"

$js = @'
import puppeteer from "puppeteer-core";

const edge = process.env.PERF_EDGE;
const url = process.env.PERF_URL;
const runs = Math.max(1, parseInt(process.env.PERF_RUNS || "3", 10));
const browser = await puppeteer.launch({
  executablePath: edge,
  headless: "new",
  pipe: true,
  args: ["--disable-gpu", "--hide-scrollbars", "--no-sandbox", "--no-first-run", "--allow-file-access-from-files"],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});
const results = [];
try {
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__lcp = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__lcp = Math.max(window.__lcp, e.startTime);
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch (e) { /* LCP unsupported */ }
    });
    await page.goto(url, { waitUntil: "load", timeout: 180000 });
    await page.waitForFunction(() => document.querySelectorAll(".card").length > 0, { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 500));
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const fcp = performance.getEntriesByType("paint").find((p) => p.name === "first-contentful-paint");
      const lcp = (performance.getEntriesByType("largest-contentful-paint") || []).at(-1);
      return {
        fcp: Math.round(fcp ? fcp.startTime : 0),
        dcl: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
        lcp: Math.round(lcp ? lcp.startTime : (window.__lcp || 0)),
        dom: document.querySelectorAll("*").length,
        cards: document.querySelectorAll(".card").length,
      };
    });
    results.push(m);
    await page.close();
  }
} finally {
  await browser.close();
}
const pick = (key) => {
  const vals = results.map((r) => r[key]).sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
};
const out = {
  measured_at: new Date().toISOString(),
  url,
  runs,
  edge,
  median: { fcp_ms: pick("fcp"), dcl_ms: pick("dcl"), load_ms: pick("load"), lcp_ms: pick("lcp") },
  runs_detail: results,
  dom_nodes: results[0].dom,
  cards: results[0].cards,
};
console.log(JSON.stringify(out, null, 2));
'@
$js | Set-Content -LiteralPath $tmpScript -Encoding utf8
try {
  $raw = & $node.Source $tmpScript
  if ($LASTEXITCODE -ne 0) { throw "node perf script failed with exit code $LASTEXITCODE" }
  if ($Out) {
    $outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $root $Out }
    $dir = Split-Path -Parent $outPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $raw | Set-Content -LiteralPath $outPath -Encoding utf8
    Write-Host "[perf_web] wrote $outPath"
  }
  $raw
} finally {
  Remove-Item -LiteralPath $tmpScript -Force -ErrorAction SilentlyContinue
}
