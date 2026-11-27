# 技术说明

**当前版本 v0.4.3（2026-11-27）**：在 v0.4.2 基础上修复审核发现的 P0/P1 数据完整性与口径问题，并补充数据许可/免责声明。
数据事实与修复状态以 [已知限制](known_limitations.md) 为准；历史报告（[最终交付报告](release_completion_report.md)、
[v0.4.0 终审](release_review_v0.4.0.md)）已加历史横幅，只作过程证据。门禁通过不代表事件权限齐全、历史行业为时点数据或独立源已确认。

## 架构

```
Tushare API / akshare 备用源 / 本地 parquet 快照
        │  bootstrap / bootstrap_api / update_daily（幂等、按日批量、质量门禁）
        ▼
data/lake.duckdb
        │  core_stock_day / core_index_day / core_limit_event / core_flow_day / core_margin_day
        ▼
feat_stock（复权、均线、新高、涨跌停、连板）
mart_market_day / mart_sector_day / mart_sector_month / mart_stock_latest
                    └──► mart_sector_roll（按行业观测行计算滚动窗口）
        ▼
Flask API ──► React + ECharts（深/浅主题、中/英）
        └──► export_static.py ──► 单文件 HTML
```

技术栈：DuckDB（本地列存）、Flask（同步 API）、React + TypeScript + Tailwind + ECharts、Vite。
历史数据修复与接管：`pipeline/repair_history.py`（按局部交易日股票数中位数识别部分日并回补）与
`pipeline/promote_repair.py`（隔离副本 → 备份 → 原子替换 → 重建 marts → 校验 → 可回滚）。

## 页面

| 页面 | 内容 |
|---|---|
| 今日盘面 | 当日结论、5 个 KPI、收益×广度、贡献 Top5 |
| 市场结构 | 收益/广度序列、集中度、分化度 |
| 市场状态 | 四象限散点、30 日轨迹、状态持续与后续统计 |
| 行业参与 | 当日气泡、行业强度云连播、累计收益、排名迁移、轮动强度 |
| 个股分化 | 市值×收益、收益分布、明细表、K 线（前复权）、PE 分位 |
| 情绪极端 | 涨跌停、连板、新高新低、封板质量、两融 |
| 自选组合 | 行业暴露、盈亏贡献、持仓明细、CSV |
| 方法与数据 | 血缘、质量门禁、更新日志、源间对账（含 as-of） |
| `/labs` | 图表实验页，`#/labs?demo=rotation` 可单独查看行业强度云 |
| `/briefing` | A4 每日简报，图表动画关闭 |

## 更新链路

`python -m pipeline.release`（前四步由 update_daily 执行，后两步由发布入口衔接）：

1. 扩展交易日历，找出缺口交易日
2. 逐日抓取 `daily / daily_basic / adj_factor / stk_limit / limit_list_d / moneyflow / margin`
3. 写入 core 层
4. 同一日事务内运行 18 条质量门禁（v0.4.2 为 14 条）；block 失败回滚，可重试该日，不发布
5. `build_marts` 重算 feat 与 mart
6. `export_static` 重新生成单文件

`pipeline.release` 是 API/Windows 共用完整入口；`--rebuild` 仅验质、重建和导出。逐数据集记录完成状态，
重查近 20 个交易日及旧缺口；两融/资金流/事件另行回补。历史部分日由 `repair_history` 在隔离副本回补，
经 `promote_repair` 受控接管生产库（v0.4.3）。Windows 工作日 17:35 触发，周日 02:00 重建；任务账户应使用上海时区。

`GET /api/sectors/roll` 返回滚动强度和展示用当日成交额。显式传 `start` 可查询更长区间，只有 `end` 时取截止该日最近 250 个有滚动行的交易日。非法日期或反向范围返回 400，合法空区间返回 200 `[]`，旧库缺表返回 409 并提示重建。静态包带最近 250 日，缺表时其余页面仍可导出，行业强度云提示重建后重新导出。

`python -m pipeline.export_static --allow-failed` 是**诊断出口**（绕过 quality/status 守卫导出），正式发布禁用；
发布链（`pipeline.release`）必须门禁全通过。失败导出的 HTML 不携带“已失败”横幅，不要分发。

Windows 下双击 `start.bat` 启动 Web 端：脚本验证解释器、复用已运行服务、必要时构建前端并打开浏览器；`stop.bat` 停止。端口可用 `ASHARE_RADAR_PORT` 覆盖（默认 8000）。只有离线单文件时脚本会提示「离线快照，非实时」。

## 质量门禁

v0.4.3 发布作用域（`scope="publish"`）共 **18 条**门禁（v0.4.2 为 14 条）；历史回补作用域（`scope="history"`）
对 gate7/gate14 记录实际值并标 `not_applicable_historical`（不 block），gate15–18 逐日跳过、批次结束后统一跑 gate15，
**阈值本身不放宽**（见 `pipeline/quality_gates.py` 顶部契约）。

| # | 检查 | 级别 |
|---|---|---|
| 1 | 单日行数 ≥3,000；相对前一日 0.95–1.05；相对前 20 日中位数（不含当日）≥0.95 | 阻断 |
| 2 | 主键唯一 | 阻断 |
| 3 | 有限正 OHLC 与价格关系；in-scope 上市前（pre-listing）行阻断；IPO 豁免要求 `trade_date >= list_date` 且 ≤上市后 30 日；北交所/NEEQ 期上市前历史单独计数披露、不阻断 | 阻断 |
| 4 | 可比较样本收益冲突比例 <1%（容差 0.1pp） | 阻断 |
| 5 | 正且有限复权因子、市值、复权价覆盖 ≥99% | 阻断 |
| 6 | 广度与前 5 日广度中位数差 ≤0.50；全平盘日 breadth 未定义并显式 warn | 警告 |
| 7 | 行业覆盖 ≥97% | 阻断 |
| 8 | 所有复权因子有效 | 警告 |
| 9 | 同口径 core 样本日 EW 变化 ≤8pp，不依赖旧 mart | 警告 |
| 10 | 成交额、成交量有限且非负 | 阻断 |
| 11 | 成熟有效样本正限价覆盖 ≥99% | 阻断 |
| 12 | 四个基准指数完整 | 警告 |
| 13 | 指数 pct_chg 与 close/pre_close 一致 | 阻断 |
| 14 | 沪深主池上市日期齐全 | 阻断 |
| 15 | 全历史完整性：`count(*)` 相对局部中位数（窗口 ±10、不含当日）<0.85 的日期清单非空即 block（与当日更新无关的全表扫描） | 阻断（v0.4.3 新增） |
| 16 | 限价档稳定性：较前一交易日 5%/10%/20%/30% 档切换的股票数超阈值 → warn，并写明数量 | 警告（v0.4.3 新增） |
| 17 | `fd_amount` 量纲：官方名单事件中 `fd_amount/float_mv > 2` 占比 >1% → warn | 警告（v0.4.3 新增） |
| 18 | 行数趋势：当日 core 行数 / 前 20 日中位数 <0.98 → warn（<0.95 已由 gate1 阻断） | 警告（v0.4.3 新增） |

门禁结果写入 `data/meta/quality/YYYYMMDD.json`，About 页展示最近一次；payload 的 `meta.data_quality`
携带 `partial_days/n_partial_days/repaired_at/history_gate` 摘要（v0.4.3；本次接管后
`n_partial_days=0`、`repaired_days=192`；2026-11-26 质量报告 18/18 通过、`blocking=[]`）。
历史回补日使用 `scope="history"`：gate7/gate14 因 2016–2022 的静态行业映射与上市日期本就不满足当前阈值，
记录实际值并标 `not_applicable_historical`（不阻断）；gate15 在整批回补完成后统一执行。
**这是“历史不适用项显式标注”，不是放宽阈值**。详见 [known_limitations.md](known_limitations.md) §1。

## 并发与锁

DuckDB 同一时刻只允许一个写连接。

- API：每个请求开只读连接，请求结束立即释放
- 更新器：`connect_wait` 每 5 秒重试，默认等 300 秒（`ASHARE_RADAR_LOCK_TIMEOUT` 可调）
- 更新期间 API 返回 `503 + Retry-After: 10`
- 发布链由操作系统文件锁覆盖（拉取→验质→重建→导出），冲突非零退出，无「跳过即成功」
- 计划任务：v0.4.3 起 `-RestartCount 3 -RestartInterval 10min -AllowStartIfOnBatteries`；入口脚本失败重试并保留日志

## 失败告警

- 失败写 `data/meta/alert.json`：时间、阶段、原因、日志路径
- `/api/meta` 与静态 payload 都会带上 `alert`
- API 透传受控告警。失败保留上一份完整 HTML，不将部分新数据重新烘焙；已分发或打开的离线 HTML 不会收到未来告警。
- HTML 成功原子替换后才清除磁盘告警；候选 HTML 排除旧告警。

## 数据源

主源 Tushare Pro；备用源 akshare（东方财富，免费无 token），覆盖 `daily / daily_basic / stk_limit / adj_factor`
的当日降级。详见 [data_sources.md](data_sources.md)。数据许可与再分发限制见仓库根目录 [NOTICE](../NOTICE)：
本项目不随仓库分发原始行情数据，使用者须自行持有 Tushare 权限。

指标定义见 [metric_contracts.md](metric_contracts.md)，数据准备见 [data_setup.md](data_setup.md)。

## 已知限制

完整量化列表（15 条）见 [known_limitations.md](known_limitations.md)。要点：

- 历史部分交易日：v0.4.2 及以前 192 天（2016-12-08..2022-11-16），v0.4.3 已回补并由 gate15 保证；
  回补后历史行业覆盖仍 93–97%（静态映射非 PIT）
- ST 5% 档：Tushare `stk_limit` 自 2026-07-06 对 ST 名称股票返回 10% 档（已核实上游），
  `limit_up_5pct_n` 连续 98 日为 0；不伪造回补，仅披露 + gate16 告警
- `limit_list_d` 需额外积分/权限：无权限时炸板率、封单额显示 `—`（仅 1,569/2,425 天有值）；
  连板高度改用价格判定
- 两融 T+1，最新日可为空；2026-05-11/18/21 上游缺 SZSE，v0.4.3 起缺失交易所日输出 NULL
- 北向资金 2024-08-19 后口径断裂，不做跨期序列
- 行业分类为静态映射，历史归属存在前视偏差；未分类 241 只 / 328,485 行（3.13%）从行业聚合中整体剔除
- 三个历史代码缺上市日期（2,720 行永久排除）；`fd_amount` 95 天量纲异常已按 NULL 处理
- 离线包是导出时快照：收不到未来告警；`meta.generated_at` 使导出字节不可完全复现
- `/labs` 的 hexbin、treemap 等属于可视化变换，只保证输入数据正确与渲染正常
- 性能：单文件 63,231,201 B（约 63.2 MB，v0.4.3 集成后实测；v0.4.2 为 62.5MB），FCP 912ms、load 852ms、
  `/api/stocks` p95 591–614ms；旧「全部端点 p95<150ms」不再成立，见 [performance.md](performance.md)

## Roadmap

- [x] 每日简报 PDF/PNG
- [x] 自选持仓、行业轮动、K 线（前复权）、PE 分位
- [x] 18 条质量门禁（含 v0.4.3 历史完整性/限价档稳定性）、更新日志、源间对账、失败告警
- [x] 色盲模式、URL 状态、PNG/CSV 导出
- [x] v0.4.3：历史部分日回补、两融口径、缺失语义、数据许可/免责声明
- [ ] 申万 PIT 行业成员（需要 `index_member_all` 权限）
- [ ] Brinson 归因
- [ ] 独立源（baostock 等）对账

## 目录

```
pipeline/   bootstrap / bootstrap_api / build_marts / update_daily / export_static / quality_gates / alerts
            repair_history / promote_repair（v0.4.3）
backend/    Flask API
frontend/   Vite + React + TypeScript + Tailwind + ECharts
config/     industry_bridge.csv（被代码读取的行业桥接表；v0.4.2 的 universe.yaml/theme.json/data_source_registry.yaml 经审核确认无代码读取，v0.4.3 已清理）
scripts/    update.ps1 / rebuild.ps1 / start.ps1 / stop.ps1 / dev.ps1 / python.ps1 / briefing.ps1 /
            install_task.ps1 / audit_all.py / gen_insights.py / perf_api.py / probe_akshare.py /
            test_fallback_insert.py / shot.mjs
tests/      指标、API、锁、告警、备用源、发布完整性、历史修复
docs/       口径、已知限制、数据源、审计、性能、技术说明、发布、洞察、截图
```

数据许可与免责：见 [NOTICE](../NOTICE)；历史文档口径：见各文件顶部横幅。

> 工具脚本边界：`scripts/perf_api.py`、`perf_web.ps1`、`probe_akshare.py`、`test_fallback_insert.py`、
> `gen_insights.py`、`backfill_index.py`/`backfill_margin.py`/`reconcile_sources.py` 均为**手动开发/验证工具**，
> 未接入 Makefile 与发布链（W3-13/W3-17）；`refresh_meta.py` 与 `update_daily.quality()` 无入口调用，属待清理死代码。
> 发布链只使用 `pipeline.release` 与 `scripts/update.ps1`/`rebuild.ps1`。
