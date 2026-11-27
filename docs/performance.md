# 性能实测（2026-11-27 集成后，v0.4.3）

> **测量时间**：2026-11-27（Asia/Shanghai，集成接管后、发布产物生成后）。
> **版本**：v0.4.3（数据 = 回补 192 个历史部分日后的生产库，`core_stock_day` 10,827,571 行；`mart_market_day` 2,425 日）。
> **产物**：`frontend/dist/ashare-radar.html` **63,231,201 B（约 63.2 MB）**、`data/static-data.json`
> **17,624,011 B（约 17.6 MB）**、`data/lake.duckdb` 4,264,833,024 B。测量在产物生成后执行。
> 证据：仓库内脱敏摘要 [validation/v0.4.3-final.json](validation/v0.4.3-final.json)；原始测量/浏览器记录**不随仓库分发**，
> 同机复跑可用 §4 命令得到数量级一致的结果（数值随机器负载波动）。

## 0. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 专业版 10.0.26300 |
| CPU | AMD Ryzen AI 9 HX 370（24 逻辑核） |
| RAM | 31.1 GB |
| 浏览器 | Microsoft Edge 146.0.3856.109（无头 `--headless=new`） |
| Python / DuckDB | 3.12.16 / 2.0.0 |
| Node | v24.15.0 |
| 测量方式 | API：Flask test client（进程内，每端点 1 次预热 + 20 次采样，`repeat=20`）；前端：无头 Edge `file://` 冷加载 3 次取中位（1600×1000，deviceScaleFactor=1） |

## 1. 前端加载（file://，无网络）

方法：`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf_web.ps1 -Runs 3 -Out <json>`
（每个 run 新建页面、等待 `.card` 渲染后 0.5s 采样 Performance API；取 3 次中位。

| 指标 | v0.4.3 实测（3 次中位） | 预算 | 结论 |
|---|---:|---:|---|
| First Contentful Paint | **912 ms** | < 2,500 ms | 达标 |
| DOMContentLoaded | **807 ms** | — | 参考 |
| load | **852 ms** | — | 参考 |
| Largest Contentful Paint | **1,060 ms** | < 2,500 ms | 达标 |

> 复核（E 代理同机复跑，2026-11-27 14:22）：FCP 884 / DCL 787 / load 831 / LCP 1,048 ms，
> 与上表同量级（差异约 3–6%，属正常波动）。

历史对照（**已过期，不作为现行性能承诺**）：2026-11-10 的 14.6MB 单文件包时代为
DCL 397 ms / load 401 ms / FCP 452 ms。当前包为 63.2MB（约 4.3 倍），首屏指标约为旧值的 2 倍；
体积主要来自字体子集 base64 内联（审核 W14-06：约 42MB 字符为字体 base64，其中 woff/woff2 双格式）。
优化方向：导出时只内联 woff2、按 unicode-range 裁剪 CJK 子集。

## 2. API（进程内，Flask test client）

方法：`python scripts/perf_api.py --repeat 20 --out <json>`（仓库根目录；交易日期自动取
`mart_market_day` 最新日 **2026-11-26**；每端点 1 次预热 + 20 次采样取 p50/p95，响应体取最大字节数）。
原始结果：本次修复的 API 测量记录（`generated_at=2026-11-27T14:19:26+08:00`；原始文件不随仓库分发，
摘要见 [validation/v0.4.3-final.json](validation/v0.4.3-final.json)）。

| 端点 | 状态 | p50 | p95 | 响应体 |
|---|---:|---:|---:|---:|
| `/api/quality` | 200 | 0.5 ms | **0.6 ms** | 3.2 KB |
| `/api/rotation?date=2026-11-26` | 200 | 41.7 ms | 54.7 ms | 58.4 KB |
| `/api/sectors?date=2026-11-26` | 200 | 43.6 ms | 56.9 ms | 12.0 KB |
| `/api/limit-quality?date=2026-11-26` | 200 | 39.5 ms | 57.8 ms | 36.2 KB |
| `/api/meta` | 200 | 45.0 ms | 54.9 ms | 1.7 KB |
| `/api/sector-ranks?date=2026-11-26` | 200 | 65.3 ms | 84.8 ms | 659 KB |
| `/api/sectors/series`（默认 750 行） | 200 | 85.1 ms | 103.0 ms | 291.5 KB |
| `/api/market/series` | 200 | 95.0 ms | 155.6 ms | 3.33 MB |
| `/api/sectors/series?start=2026-01-01&end=2026-11-26` | 200 | 136.9 ms | 158.7 ms | 2.61 MB |
| `/api/sectors/roll?end=2026-11-26` | 200 | 165.0 ms | 191.9 ms | 2.28 MB |
| `/api/stock/600519.SH` | 200 | 193.8 ms | 239.0 ms | 805.8 KB |
| `/api/market/day/2026-11-26` | 200 | 270.9 ms | 305.2 ms | 16.7 KB |
| `/api/stocks?date=2026-11-26&limit=6000` | 200 | 543.3 ms | **591.3 ms** | 1.61 MB |
| `/api/stocks?date=2026-11-26&limit=400` | 200 | 555.2 ms | **613.5 ms** | 123.5 KB |

**结论**：

1. **「全部端点 p95 < 150 ms」不成立**：`/api/stocks` p95 591–614 ms、`/api/market/day` 305 ms、
   `/api/sectors/roll` 192 ms、`/api/stock/<code>` 239 ms、`/api/market/series` 156 ms 均超过 150 ms。
   旧文档的 106/117 ms 等数字是 14.6MB / 9.9M 行时代且测试端点不同，不可直接比较；该旧结论已从现行文档删除。
2. **每请求连接开销是固定成本**：`/api/meta` p50 45.0 ms（旧文档 0.6 ms 为常驻连接时代），因为 v0.3.1 起
   API 改为「每请求一个只读 DuckDB 连接、请求结束释放」以避免挡住 17:35 更新（ADR-12）。本地连接开销约
   10–50 ms，对高频轮询应优先做连接复用/进程内缓存（Roadmap）。
3. **区间有界显著降低最坏响应**：`/api/sectors/series` 无区间时只返回最近 750 行（291 KB，p95 103 ms），
   旧版曾一次返回 29.4MB / p95 1,630 ms；带完整区间（2026 年内）时 2.61MB / 158.7 ms，仍属大响应，前端应按需请求。
4. 最大响应是 `/api/market/series`（全量 2,425 日，3.33MB，p95 155.6 ms），其次是 `/api/sectors/roll` 2.28MB。
   如需继续压缩：API 侧强制区间/分页、列式响应（Roadmap）。

## 3. 页面切换

本脚本只测首屏加载与 API；SPA 路由切换（含 ECharts 重绘）不在本表。旧版 2026-11-10 的
Market 474 ms / Sectors 485 ms / Stocks 515 ms / Watchlist 437 ms（14.6MB 包、含 400ms 等待）**已过期**，
不再作为现行指标。如需页面切换预算，使用 `frontend/scripts/e2e.mjs`（会写 `data/meta/e2e.json`，属本地验证产物）
或集成后的浏览器验收记录。

## 4. 复现

```powershell
# 项目解释器（DuckDB 2.0.0）；也可先 conda activate 后再用 python
$py = 'python'  # 任意已安装 requirements.txt 的解释器路径
$env:ASHARE_RADAR_LOAD_ENV = "0"

# API（Flask test client，进程内）
& $py -X utf8 scripts/perf_api.py --repeat 20 --out _perf_api.json

# 前端首屏（无头 Edge，file:// 冷加载 3 次取中位）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/perf_web.ps1 -Runs 3 -Out _perf_web.json

# 产物体积
Get-Item frontend/dist/ashare-radar.html, data/static-data.json | Select-Object Name, Length
```

测量脚本只读生产库；`--out` 建议指向临时目录，避免覆盖 `data/meta/` 下的其它证据。
数值随机器负载与磁盘缓存状态波动约 ±20%，容量判断请以量级与 p95 为准。
