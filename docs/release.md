# 发布说明（GitHub）

当前发布候选版本为 **v0.4.3**（2026-11-27）。`v0.4.0` 新增行业强度云，审核结果见 [v0.4.0 终审](release_review_v0.4.0.md)；
`v0.4.1` 修交互光标；`v0.4.2` 加市场结构页时间轴缩放/平移、涨跌停价格口径与官方名单缺口审计、KPI 字号；
`v0.4.3` 修复审核发现的 P0/P1 数据完整性问题（192 个历史部分交易日回补并由 gate15 保证、两融只汇总 SSE+SZSE、
缺失交易所日输出 NULL、`data_quality` 质量标记、历史代码/未分类/`fd_amount` 等披露）、API 安全头与未知路径 404、
排序确定性、数据许可/免责声明（[NOTICE](../NOTICE)）与 [已知限制](known_limitations.md) 文档。均为向后兼容的小版本。
上一版 `v0.3.0` 已发布；`v0.4.2` 为上一候选。

## 1. 仓库名

**最终：`ashare-radar`（A股雷达）**

- 12 字符、全小写、连字符分隔；`ashare` + `radar` 一眼能读出用途
- 替代早期名称：不再只强调“广度/实验室”，产品覆盖广度、行业、个股、情绪与持仓
- 与 Python 包名 `ashare-radar`、单文件 `ashare-radar.html` 保持一致

## 2. 仓库描述

> A-share market breadth & structure terminal — DuckDB + Flask + React/ECharts. 8 pages, auto daily update, single-file offline build.

## 3. Topics

`a-share` `tushare` `market-breadth` `duckdb` `echarts` `dashboard` `quant` `data-visualization`

## 4. 推送与发布检查

发布前必须全部通过（在候选分支/副本上执行）：

1. `python -m pytest -q`（v0.4.3 集成后 **236 passed / 0 failed / 0 skipped**；v0.4.2 历史基线 139）
   与 `python -m ruff check`；`cd frontend && npm ci && npm run check`（typecheck + node tests + build；
   v0.4.3 集成后 node tests **117 passed / 0 fail**、tsc 0 error；v0.4.2 历史基线 52）。
2. 在数据库副本验证 `python -m pipeline.release --rebuild`。该入口依次验质、重建分析表和导出。
3. `python scripts/audit_all.py --lake <副本路径> --offline` 确认滚动表和静态包一致
   （v0.4.3 集成后：**60 通过 / 0 失败 / 3 跳过**，verdict=`pass_with_skips`；v0.4.2 历史基线为 59/0/3（共 62 项））。
   v0.4.3 的 `audit_all.py` 已改为「派生表重算」并新增全历史完整性检查（gate15 同口径）与独立
   `sector_roll` 投影重算（W12-09）；但跨源对账仍是抽样单日，**skip 不算 pass**，报告 verdict 会标
   `pass_with_skips`，不能替代 gate15 的发布阻断。
   发布前请在**最新数据日**重跑，并确认 `data/meta/audit_report.md` 的审计日与 `status.json` 的最新交易日一致
   （避免历史「审计报告落后一日」问题，W12-12）。
4. 历史完整性：`pipeline.repair_history` 检测 `incomplete_dates()==[]`（v0.4.3 回补后应为空），
   新发布跑 gate15（全历史完整性，block）与 gate16–18（限价档稳定性/封单额量纲/行数趋势，warn）；
   确认 `data_quality.partial_days==[]`。
5. 性能与体积：`python scripts/perf_api.py --out <临时文件>` 记录 API p50/p95；
   `Get-Item frontend/dist/ashare-radar.html, data/static-data.json` 记录体积
   （v0.4.2 实测：62,507,567 B / 16,944,296 B；v0.4.3 集成后 63,231,201 / 17,624,011）。
   前端首屏用无头 Edge 测（方法见 [performance.md](performance.md)）。
6. 检查变更清单，提交源代码、回归测试和文档。将验证产物保留在临时目录。
7. 推送源码后等待 GitHub Actions 通过，在已验证的提交上创建 **`v0.4.3`** tag 和 Release
   （不要再用 `v0.4.0`/`v0.4.2` 等已有 tag；tag 号以 `git tag --list` 与 `pyproject.toml`/`frontend/package.json` 版本一致为准）。

## 5. 部署已发布的版本

**构建会清空 `frontend/dist/`。** `npm run check` 也包含构建。请在最后一次构建之后导出，并确认 `frontend/dist/ashare-radar.html` 存在。

1. 更新代码和依赖，在 `frontend` 执行 `npm ci` 和 `npm run build`。
2. 回到仓库根目录执行 `python -m pipeline.release --rebuild`。旧库可继续浏览既有页面，行业强度云需本步生成 `mart_sector_roll`。如果存在未解决的行情更新失败，先完成 `python -m pipeline.release` 并检查门禁再发布。
3. （仅 v0.4.3 接管修复库时）执行 `python -m pipeline.promote_repair --source <修复副本>`：要求源库完整、
   复制/备份生产库、`publish_lock`、原子替换、切换后重建 marts、校验行数，失败可回滚。生产库不手工覆盖。
4. 重启 Flask。检查 `/api/sectors/roll` 返回含数据的 200，并打开 `#/sectors?mode=rot` 与新导出的 `frontend/dist/ashare-radar.html`。
5. Windows 每日更新、周日重建继续使用原发布入口；v0.4.3 的计划任务含 `-RestartCount 3 -RestartInterval 10min
   -AllowStartIfOnBatteries`，重装任务请重新执行 `scripts/install_task.ps1`。
6. 部署目录勿放在共享/多用户可写路径；收紧密码/数据文件 ACL（见 [known_limitations.md](known_limitations.md) §14）。

## 6. 不随仓库分发的内容

- `data/`（DuckDB、parquet、快照、简报、导出 payload）——体积大且含行情数据，**不再分发原始数据**
- `.env`（Tushare token）
- `frontend/dist/`（构建产物，可由 `npm run build` + `pipeline.export_static` 重建）

数据许可与再分发限制见 [NOTICE](../NOTICE)。新用户按 README「快速开始」：建 conda 环境 → 填 token →
`python -m pipeline.bootstrap` → `python -m backend.main` 或 `python -m pipeline.export_static`。
