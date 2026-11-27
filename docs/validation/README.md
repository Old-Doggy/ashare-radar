# 验收证据摘要（2026-11-12）— 历史文档

> **历史证据：as-of 2026-11-12，仅记录隔离数据库副本的检查摘要，不能作为 v0.4.3 交付许可。**
> 2026-11-27 审核确认：本目录自称的验收副本缺少其记录的 3.7GB `lake.duckdb` 与约 60.8MB 候选 HTML，
> `artifact-hashes.json` 中两个文件哈希对应的文件不存在（W12-02）；因此 C01「192 日修复」与浏览器验收
> **无法用这些文件独立复验**。v0.4.3 的接管与验证证据见 [v0.4.3-final.json](v0.4.3-final.json)
> 与 [known_limitations.md](../known_limitations.md)。
>
> 这些文件不包含凭据、个人持仓或行情明细。代码基线、修改范围与限制见[最终交付报告](../release_completion_report.md)（历史文档）。

## v0.4.3 最终发布证据（as-of 2026-11-27）

- [v0.4.3-final.json](v0.4.3-final.json)：集成接管后的最终数字摘要 —— core 10,827,571 行、192/192 部分日已回补、
  gate 18/18 通过、pytest 236 / node 117、audit_all 60 通过/0 失败/3 跳过、HTML 63,231,201 B、
  payload 17,624,011 B、性能与 payload meta（`n_partial_days=0`、`repaired_days=192`）。
  原始测量/浏览器证据（不随仓库分发）中的摘要字段已在此文件内脱敏收录；**本文件是 as-of 2026-11-27**，
  下方旧文件仍保持 as-of 2026-11-12，不混用。
- 复现：`data/meta/quality/latest.json`、`data/meta/marts.json`、`data/meta/history_repair.json` 与
  `Get-Item frontend/dist/ashare-radar.html` 可复核对应数字（见 [known_limitations.md](../known_limitations.md) §16）。

## 证据来源说明

| 目录 | 生成者/时间 | 内容 | 与另一目录的关系 |
|---|---|---|---|
| `docs/validation/`（本目录） | 2026-11-12 修复验收时人工整理 | 摘要 JSON（tests/浏览器/修复/对账计数） | **人工摘要**，不是机器生成的权威证据；部分原始文件未随交付保留 |
| `data/meta/` | 每次更新/发布由 pipeline 写入 | `quality/latest.json`、`marts.json`、`status.json`、`history_repair.json`、`reconcile.json`、`audit_report.md`、`promote_repair.json` 等 | **运行时权威证据**；按数据日期滚动更新，未纳入 Git，随本地数据目录变化 |

两者不是同一来源：本目录的数字是当时人工摘录，`data/meta/` 才是管线实际产物。引用时须注明来源与生成时间，
不得把本目录的旧数字当作当前 `data/meta/` 的现状。2026-11-12 交接时两者已出现不一致（如对账：本目录 n=0，
`data/meta/reconcile.json` 为 11-10 的 n=60），已在 [reconcile.md](../reconcile.md) 说明。

## 文件清单（均为 2026-11-12 前后历史快照）

- `checks.json`：安装、回归、构建与漏洞扫描摘要（pytest 121 / node 32 / npm audit 0 / export 60,763,473 B）。
  【as-of 2026-11-12】当时基线的测试数已过期（v0.4.2 为 139/52，v0.4.3 集成后 236/117）。
- `browser-acceptance.json`：API 和断网 file 模式 20 个路由检查、主题/色盲/英文、虚构持仓与 API/静态逐字段对比。
  注意：其声称的候选 HTML 未随交付保留。
- `repair-run.json`：最近 20 日实际更新的来源、告警与耗时（141.5 s，32 warnings）。
- `repair-summary.json`：192 个明显部分日期修复后剩余检测及行数（`remaining_partial=[]`、`core_rows=10,766,267`、
  `checkpoint_repaired_dates=212`）。**212 与 192 的口径不同**：212 为含重试/检查点的日期计数，不等于修复的唯一日期数。
- `full-history-audit.json`：全历史覆盖指标的差异计数；`0` 代表未检出差异，**不是全历史真值证明**
  （`unknown_listing_rows=3056/codes=3` 为当时修复副本口径，交付库为 2,720 行）。
- `independent-audit.json`：最新日 37 项派生核对（0 失败），只覆盖单个交易日。
- `reconcile.json`：独立源返回无重合记录（`n=0`），**不能算通过**。

## 逐日修复记录

逐日修复记录在修复副本的 `meta/history_repair.json`（v0.4.3 起为 `data/meta/history_repair.json`）。
2026-11-12 交接时：首轮已修 11 日后网络中断，续跑修复 181 日，因此该次运行明细不单独代表 192 日总数；
总修复量由前后行数、操作记录与最终剩余计划共同确定。**该限制已由 v0.4.3 的完整回补与 gate15 复核替代。**
