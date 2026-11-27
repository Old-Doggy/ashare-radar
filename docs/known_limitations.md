# 已知限制与数据披露（v0.4.3）

> as-of：2026-11-27（Asia/Shanghai）。版本：v0.4.3（已集成接管、产物已重建）。
> 本文件把 2026-11-27 审核报告（本次审核记录，不随仓库分发）§7 列出的 15 条数据事实逐条量化，
> 并给出版本归属、修复状态与复现方式。**历史版本（v0.4.2 及以前）与 v0.4.3 的差异会明确标注**。
> 数据许可与免责声明见仓库根目录 [NOTICE](../NOTICE)；口径定义见 [metric_contracts.md](metric_contracts.md)。

所有「交付库」数字均可对集成后的 `data/lake.duckdb` 只读复现（命令见 §16），并经 2026-11-27 集成验证
（结果见 [validation/v0.4.3-final.json](validation/v0.4.3-final.json)）。文中引用的修复过程证据**不随仓库分发**；
复制本项目后请用 §16 的命令在你自己的库上复现。

## 0. 速查表

| # | 事实 | 量化（v0.4.2 交付库 / 2026-11-26） | v0.4.3 状态 |
|---|---|---|---|
| 1 | 历史部分交易日 | 192 天（2016-12-08..2022-11-16，2018+ 151 天；core 行数 <1000 的 88 天、`n_valid<2500` 中 <500 的 77 天） | **已回补并接管**：192/192 天由 Tushare 逐日重刷（failed=0，`remaining_partial=[]`），min 日行数 189→**2,768**；gate15 全历史完整性门禁阻断回归；接管后 core=**10,827,571** 行（v0.4.2 交付 10,291,073；2026-11-12 修复副本 10,766,267） |
| 2 | ST 5% 限价档断裂 | 2026-07-06 起 `limit_up_5pct_n` 连续 98 日 = 0（2026-07-03 为 53） | **已核实为上游变更**，不伪造回补；gate16 在 2026-07-06 报 warn（148/5,515=2.68% 档位切换）；契约删除「含 ST/全历史无缺失」；About/Sentiment 注记「档位数据待上游核对」 |
| 3 | 官方名单接口无权限 | `limit_up_list_n`/`broken_rate`/封单额仅 1,569/2,425 天有值（2019-11-28..2026-05-22；2026 年 90 天） | 未修复（需 Tushare `limit_list_d` 权限）；炸板率/封单额显示 `—`，涨跌停家数用价格口径 |
| 4 | 两融口径 | T+1（最新日为空）；2026-05-11/18/21 缺 SZSE 行；2023-02-13 起含 BSE（919 行） | **已修（口径）**：`margin_n_exchanges` 分布 = SSE+SZSE 2,421 天 / 仅 1 交易所 3 天（三日 `rzye=NULL`）/ T+1 最新日 0 交易所（NULL）；不再输出部分和 |
| 5 | 行业静态映射 | 未分类 241 只 / **328,485 行（3.13%）**（2016 年 6.94% → 2026 年 0.12%；最新日 0/5,221） | 未修复（无 PIT 成员权限）；已量化披露；回补后历史覆盖仍约 93–97% |
| 6 | `fd_amount` 量纲异常 | 95 个交易日（2019-11-28..2020-04-20）`fd_ratio>2`（上游量纲约 ×10³），在 400 日展示窗口外 | **已加防护**：异常样本按 NULL 输出 + gate17 告警；契约注明异常期 |
| 7 | 三个历史代码缺上市日期 | 300114.SZ（1,789 行）、000043.SZ（640 行）、000022.SZ（291 行）共 2,720 行不在 `core_stock_meta`，永久排除；北向 2024-08-19 后口径断裂 | 未修复（上游元数据缺失）；已披露并排除出最新快照/门禁 14 |
| 8 | 离线包是静态快照 | 收不到未来告警；失败保留上一版 HTML；`stocks` 并列排序曾不稳定导致包哈希不可复现 | **部分修复**：排序加 tie-break；`meta.generated_at` 仍不可复现（文档已注明） |
| 9 | 源间对账证据 | `data/meta/reconcile.json` 为 2026-11-10、20 股×3 日=60 对快照；`docs/validation/reconcile.json` 为 n=0「no overlap」 | **如实披露**：n=0 不算通过；历史对账结论已标注历史，不再作为现行证据 |
| 10 | 历史验收副本缺失 | 2026-11-12 验收副本目录中缺少其自称的 3.7GB `lake.duckdb` 与约 60.8MB 候选 HTML | **无法独立复验**；v0.4.3 以集成后证据（[validation/v0.4.3-final.json](validation/v0.4.3-final.json)）替代，历史 C01 仅为副本口径 |
| 11 | 性能基线过期 | 旧文档 FCP 452ms / load 401ms /「全部端点 p95<150ms」是 14.6MB 包时代；v0.4.2 为 62.5MB | **已重测**：[performance.md](performance.md) 给出 2026-11-27 方法、环境与新数字（v0.4.3 包 63,231,201 B，FCP 912ms、`/api/stocks` p95 591–614ms） |
| 12 | 数据许可/免责缺失 | LICENSE(MIT) 只覆盖软件；仓库含 16 张行情截图；离线包内嵌约 17.6MB 行情 payload | **已修**：新增 [NOTICE](../NOTICE)，README/About 显著链接并披露非投资建议 |
| 13 | 可访问性缺口 | 11 个 ECharts 容器缺 `aria-label`；EN 模式 `<html lang>` 仍为 `zh-CN`；浅色主题 3 个文本色对比度 3.8–4.4；390px 下钻链接被裁；色盲模式状态色仍用红绿语义 | **v0.4.3 已修复**：ECharts 容器补 `aria-label`（浏览器验收节点 0 缺失）、`setLang` 同步 `<html lang>`、主题对比度/移动端/色盲/reduced-motion 修复；验收摘要见 [validation/v0.4.3-final.json](validation/v0.4.3-final.json) |
| 14 | 部署面风险 | 仓库/data 目录 ACL 允许本机已认证用户改写；计划任务从可写目录执行；API 缺安全响应头、GET 未知 `/api/*` 返回 200 HTML | **已修（API/任务）**：统一安全头、未知 `/api/*` 返回 404 JSON、计划任务加失败重试与电池策略；ACL 属部署环境，文档提示勿放共享路径 |
| 15 | 上游真值不可验证 | Tushare/akshare 真值、历史 ST/行业身份、退市/停牌事实在不联网的本轮无法验证 | 如实披露；不把门禁通过等同于上游认证 |

## 1. 历史部分交易日（P0，v0.4.3 已回补）

**v0.4.2 及以前**：交付库 `mart_market_day` 共 2,425 个交易日（2016-12-01..2026-11-26），其中 **192 天**
存在整日样本缺失（`n_valid<2500`），区间 **2016-12-08..2022-11-16**；按年 2016:4、2017:37、2018:36、
2019:13、2020:26、2021:32、2022:44（2018 年及以后合计 151 天）。其中 core 行数 <1000 的 **88 天**、
`n_valid<1000` 的 89 天、`n_valid<500` 的 **77 天**（最小 189 只）。交付 `core_stock_day` 为
**10,291,073 行**；2026-11-12 的修复副本为 **10,766,267 行**（净增 536,498 行），但**未随交付接管**。
这些日期的次日权重（CW/HHI/Top10）、连板中断等指标不可用（详见审核 P1-1/P1-2）。

**v0.4.3（已完成并接管）**：用 Tushare 对 192 个部分日逐日重刷 `daily / daily_basic / adj_factor / stk_limit`
（`failed=0`），在隔离副本重建 marts；新增 **gate15 全历史完整性**（相对局部中位数 <0.85 的日期清单非空即 block）；
以 `pipeline/promote_repair.py` 完成「源库校验 → 备份 → `publish_lock` → 原子替换 → 重建 marts → 行数/锚点校验 →
失败可回滚」的受控切换（旧库已备份；备份目录不入库）。接管后：`core_stock_day` 10,291,073 →
**10,827,571** 行、`feat_stock` 10,478,223、`remaining_partial=[]`、最小日行数 189 → **2,768**，
2,425 个交易日 `data_quality='ok'`（`meta.data_quality.n_partial_days=0`、`repaired_days=192`）。
**口径更正**：审核阶段的「删除 192 天后 ALL 累计收益差约 48pp」是表列删除偏差（这 192 天平均 EW 为负、缺失与下跌日相关），
已废弃；按全样本正确口径，ALL 区间 EW 累计为 **+22.05% → +17.09%**。P0/P1 的真实影响是部分日样本与涨跌停/连板计数错误、
次日权重污染（部分日次日 HHI 中位 **269.5 → 49.8**、top10_share 0.3305 → 0.1119、max_weight 0.1204 → 0.0358）
以及月度/行业聚合错误，**不是** ALL 累计的 48pp 差异。

> 回补校验使用 `scope="history"`：gate7（行业静态映射，非时点）与 gate14（退市/NEEQ 期代码缺上市元数据）在历史日
> 记录实际值并标 `not_applicable_historical`（不阻断），gate15–18 逐日跳过、整批回补后统一跑 gate15；
> 其余门禁照常执行、阈值不放宽。这是**“历史不适用项显式标注”**，不是放宽现有门禁阈值，被排除的两门禁在
> v0.4.3 发布日仍按全量执行。

**仍未解决**：零散单股漏行无法被「整日样本量」启发式检出；静态行业映射非 PIT（第 5 条）；
上游历史更正不可验证（第 15 条）。未来新数据用 `data_quality='partial'`（`weight_coverage<0.95` 或
`n_valid_ratio<0.95`）把当日权重类指标输出 NULL，避免再次静默污染。

## 2. ST 5% 限价档断裂（P1，已核实为上游变更）

**事实**：`limit_up_5pct_n` 在 2026-07-03 为 53，**2026-07-06 起连续 98 个交易日为 0**（至 2026-11-26）。
07-03→07-06 有 **148 只**股票限价档从 5% 切到 10%；07-06 当天名称含 ST 的 **196 只**全部为 10% 档
（07-03 时其中 134 只为 5% 档）。

**上游核实**（2026-11-27，本次修复过程证据，不随仓库分发）：
Tushare `stk_limit(20260706)` 返回的 `up_limit` 与本地 148/148 完全一致，即**上游自身对仍戴 ST 名称的股票
返回 10% 档，本地限价计算无误**。该断裂不能通过伪造限价回补。

**v0.4.3 处置**：契约删除「含 ST / 5% 与非 5% 档 / 全历史无缺失」承诺，改为按 `up_limit/pre_close-1`
派生档位并注明来源为 Tushare `stk_limit`；新增 **gate16 限价档稳定性**（切换股票数 >2% 或 >50 只 → warn）。
2026-07-06 实测 message 为 `148/5515 limit bands changed vs 2026-07-03 (2.68%)` → warn；
之后各日切换数低于阈值不再告警。About 与 Sentiment 页标注「档位数据待上游修复」。**不得**把
`limit_up_5pct_n` 强行置 NULL（数据内部自洽于 10% 档），也不得再写「漏计 0 家」。

## 3. 官方名单（`limit_list_d`）覆盖（未修复，权限限制）

`limit_up_list_n` 非空 **1,569/2,425 天**，区间 **2019-11-28..2026-05-22**；2019:24、2020–2025 每年
242–243 天、2026 年 90 天。炸板率 `broken_rate`、封单额 `limit_fd_amount` 与封板质量页同受此限制，
无权限日显示 `—`。涨停家数、连板高度改用 `stk_limit` 真实限价 + gaps-and-islands 价格口径（ADR-06），
全历史口径一致但**不是官方名单口径**；`contracts` 已把 `open_share`（开板比例）与 `broken_rate`（官方名单炸板率）
拆成两个字段。

## 4. 两融（P1，v0.4.3 已修口径）

- T+1 发布：最新交易日无当日两融数据属正常。
- 2026-05-11 / 05-18 / 05-21 三天只有 `BSE,SSE` 行，缺 SZSE；三日 rzye 合计
  **1.4415 / 1.4713 / 1.4765 万亿元**，邻日约 **2.83–2.91 万亿元**（约腰斩）。
- `core_margin_day` 自 **2023-02-13** 起含 BSE 行（919 行，含北交所个股口径）。

v0.4.3 起个股池与本指标只汇总 `exchange_id IN ('SSE','SZSE')`；当日任一交易所缺失则 `rzye/rzmre`
输出 **NULL**（不再静默部分和），并用 `margin_n_exchanges` 记录实际覆盖的交易所数。接管后实测分布：
**2,421 天 = 2 个交易所**（正常）、**3 天 = 1 个**（2026-05-11/18/21，`rzye=NULL`）、
**1 天 = 0 个**（T+1 最新日 2026-11-26，`rzye=NULL`）。契约写明「缺失日不画部分和」。

## 5. 行业映射（未修复，静态桥接非 PIT）

- 映射来源：`config/industry_bridge.csv`（110 → 31 个申万一级），基于 Tushare 当前 `stock_basic.industry`，
  **不是时点成员**（`index_member_all` 无权限，ADR-03）。
- 全历史 `feat_stock` 未分类 **328,485/10,478,223 行 = 3.13%**，涉及 **241 只**股票；按年 2016 年 6.94%、
  2017 6.23%、2018 5.83%、2019 5.81%、2020 5.03%、2021 4.20%、2022 3.24%、2023 2.23%、2024 1.24%、
  2025 0.48%、2026 0.12%；**最新日 0/5,221**。
- 据此：现行「行业覆盖约 100%」只对最近日成立；**历史（2016–2020）覆盖约 93–95%，2016–2022 约 93–97%**。
  `99.98%` 仅是 2026-11-10 当日口径，已从现行文档删除。
- 未分类股票被排除出行业聚合（`mart_sector_day` 的分母只含已映射股票），影响行业广度/收益的样本；
  行业归属为当前分类回填历史，存在前视偏差。升级路径：取得 `index_member_all` 权限后改为 PIT。

## 6. `fd_amount` 量纲异常（已加防护）

官方名单 `core_limit_event.fd_amount` 在 **2019-11-28..2020-04-20 共 95 个交易日**出现量纲异常
（约为正常值的 ×10³，`fd_amount/流通市值 > 2`，每个异常日 1 行），距最新日已超出 400 日展示窗口。
v0.4.3 起 `mart_limit_quality`/`limit_fd_amount` 对异常样本按 NULL 输出，并新增「异常占比 >1% → warn」门禁；
契约注明该异常期。历史异常原始行保留在 `core_limit_event`（只读，不伪造修正）。

## 7. 三个历史代码缺上市日期 + 北向断裂（未修复）

- `300114.SZ`（1,789 行，2016-12-01..2025-02-14）、`000043.SZ`（640 行，..2019-12-13）、
  `000022.SZ`（291 行，..2018-12-20）共 **2,720 行**存在于 `core_stock_day` 但不在 `core_stock_meta`，
  `list_date` 不可得 → 永久排除出最新快照与需要上市日期的口径（门禁 14、IPO 豁免）；不会用交易日推算。
- 北向资金：`moneyflow_hsgt.north_money` 在 **2024-08-19** 后由「净买入」改为「成交额」，量级不可比，
  不做跨期序列（ADR-05）；只保留断点前区间并显式标注。
- 退市整理/复牌首日极端收益：v0.4.3 新增 `n_extreme_ret`（|ret|≥50% 的非新股行数）披露，不改原始值。
- 零散缺失：`core_stock_day.up_limit` 缺失 **77,250/10,827,571 = 0.71%**（最新日 0 缺失）；这些行不参与涨跌停判定，
  门禁 11 只要求成熟样本覆盖 ≥99%。缺限价行不会被填成 0 或伪造限价。

## 8. 离线包与可复现性（部分修复）

- 离线 HTML 是**导出时快照**：已分发的旧副本收不到未来告警；发布失败保留上一份完整 HTML，不烘焙部分新数据。
- `stocks`/`/api/sectors` 等排序已加 tie-break（`ret DESC, ts_code` 等），同库连续两次导出除
  `meta.generated_at` 外应逐字节一致；`generated_at` 保留（时间戳本身不可复现），文档已注明。
- 导出时间/体积随字体与数据覆盖变化，见 [performance.md](performance.md) 的测量方法与当次数字。

## 9. 源间对账（不可验证，已如实披露）

- `data/meta/reconcile.json`：2026-11-10 生成，20 只股票 × 3 个交易日 = **60 对**，MAE 0.0025pp —— 历史快照。
- `docs/validation/reconcile.json`：2026-11-12，**n=0, error="no overlap"** —— 独立源与本地无可比重合样本，
  **n=0 不能算通过**。
- v0.4.3 仍未能建立可复现的独立源对账（不联网、且 akshare 与 Tushare 上游不同但样本窗口需重新对齐）；
  现行文档不再把 11-10 的旧结论当现行证据。详见 [reconcile.md](reconcile.md)。

## 10. 历史验收副本缺失（不可复验）

2026-11-12 的验收副本目录缺少其自称的 3.7GB `lake.duckdb` 与约 60.8MB 候选 HTML，
`artifact-hashes.json` 中两个哈希对应的文件不存在，`先读我.md` 指向不存在的文件；192 日修复仅保留续跑
181 日明细（`history_repair.json`），首轮 11 日明细未随交付。因此历史 C01（副本修复口径）**只能按副本口径引用**，
不能作为交付库证据；v0.4.3 的接管以集成后证据（[validation/v0.4.3-final.json](validation/v0.4.3-final.json)）
与 gate15 为准。

## 11. 性能基线（v0.4.3 已重测）

v0.4.2 及以前 `docs/performance.md` 的数字（FCP 452ms、load 401ms、「全部端点 p95<150ms」）是
2026-11-10 / 单文件 14.6MB 时代数据；v0.4.3 集成后单文件 **63,231,201 B（约 63.2 MB）**、payload **17,624,011 B**
（约 17.6 MB），实测 FCP **912 ms** / load **852 ms** / LCP **1,060 ms**，`/api/stocks` p95 **591–614 ms**。
[performance.md](performance.md) 记录 2026-11-27 的测量时间、环境、方法与结果，并声明「全部端点 p95<150ms」不再成立。

## 12. 数据许可与免责（v0.4.3 已补）

LICENSE（MIT）只覆盖软件，不覆盖数据；数据来自 Tushare Pro（使用者自持权限、不得再分发原始数据），
备用源 akshare；仓库内 16 张 `docs/screenshots/*.png` 仅为功能演示（含历史行情数字，非投资建议）。
v0.4.3 新增 [NOTICE](../NOTICE) 并在 README/About 链接。**本项目不构成投资建议，数据按 as-is 提供。**

## 13. 可访问性 / 显示（v0.4.3 已修复）

- 11 个 ECharts 容器补 `aria-label`（浏览器离线验收中 10 个路由 `roleImgNoLabel=0`）；`setLang` 同步
  `<html lang>` 且 EN 文案补齐；浅色主题 `faint/accent/copper` 加深到 WCAG AA ≥4.5；390px 下钻链接可点。
- 色盲模式下 Regime/Briefing 状态色改为从主题色板派生（不再红绿语义）；`prefers-reduced-motion` 关闭 ECharts 动画；
  CSV 单元格注入前缀已处理（W14-15）。
- 验收摘要（10 个路由 × API/离线双模式、0 console error、0 外部请求、逐字段对比）见
  [validation/v0.4.3-final.json](validation/v0.4.3-final.json)；详细浏览器验收记录不随仓库分发。

## 14. 部署面（API/任务已修，主机 ACL 属部署责任）

- 计划任务：v0.4.2 的两个任务无失败重试/电池策略（`install_task.ps1` 未设 `-RestartCount`）；
  v0.4.3 加 `-RestartCount 3 -RestartInterval 10min -AllowStartIfOnBatteries`，入口脚本失败重试并保留日志。
- API：v0.4.3 统一对 `/api/*` 加 `nosniff / X-Frame-Options / Referrer-Policy / Permissions-Policy /
  Cache-Control: no-store`，未匹配 `/api/*` 返回 404 JSON；GET 也校验 Host。
- 主机 ACL：本仓库目录在开发机上允许 `Authenticated Users` 改写；**部署到共享/多用户主机时应收紧为单用户 ACL**，
  不要把项目放在共享可写目录（`.env`、`lake.duckdb`、`frontend/dist` 都可能被替换）。
- `start.ps1` 在只有离线单文件时明确提示「离线快照，非实时」；`export_static --allow-failed` 是诊断出口，
  不得用于正式发布（发布路径要求门禁全通过）。

## 15. 上游真值不可验证（本轮不联网）

Tushare/akshare 的数据正确性、历史 ST 身份、行业时点成员、退市/停牌事实、交易所对账真值，在本轮修复的
离线环境中无法独立验证；门禁通过只证明「本地派生链路自洽 + 样本覆盖达标」，**不等于上游数据已获认证**。
同类不可验证项还包括：远程 CI/Actions 运行状态、完全空库 bootstrap、计划任务真实触发、完整 Git 历史秘密扫描。

## 16. 历史建库门禁与早期数据覆盖（v0.4.3）

- **历史日使用轻量门禁**：早期市场不足 3000 只、行业静态映射覆盖仅 92–97%、个别退市股缺上市日期，
  因此 2016–2024 的历史日只跑「数据完整性/合法性」门禁（行数相对中位数、主键、OHLC 结构、
  收益一致性、字段覆盖、成交额、限价覆盖、指数完整/一致）；gate6/9（连续性 warn）、
  gate7/14（行业/上市日期元数据）、gate15–18（发布链专用）在历史日跳过并记录，**阈值本身未放宽**。
  最近一年内且位于区间末尾的交易日仍走完整发布门禁。
- **早期字段覆盖**：2016 年 Tushare `daily_basic` 每日约 98.2% 覆盖（43–100 只老股无市值行），
  `stk_limit` 约 99.96%；历史门禁对 gate5/gate11 用 **95% 阻断下限**（低于它说明本次拉取异常），
  发布日仍要求 99%。
- **北交所/NEEQ 历史行**：北交所行缺少复权因子/涨跌停时不进入分析池、也不计入 gate8/gate3 告警。core 中保留部分 920xxx/83xxxx 的 NEEQ 期数据（如 2016 年早于其北交所
  上市日），这些行不在分析池（`v_stock` 只含 SSE/SZSE），历史门禁的结构检查也只针对沪深行，
  不会因北交所缺 pct_chg/限价而误阻断。

## 17. 复现命令

在仓库根目录执行（只读；把 `$py` 换成你的项目解释器，DuckDB 2.0.0）。
PowerShell 5.1 直接传 `python -c "…"` 时嵌套引号会被吞掉，因此用 stdin 方式喂脚本，复制整段即可运行：

```powershell
$py = 'python'  # 任意已安装 requirements.txt 的解释器路径
@'
import duckdb
c = duckdb.connect("data/lake.duckdb", read_only=True)
# 1) 部分交易日数量（v0.4.2 交付库 = 192；v0.4.3 回补后应为 0）
print("partial_days:", c.execute("SELECT count(*) FROM mart_market_day WHERE n_valid < 2500").fetchone()[0])
# 2) 行业未分类（行数, 代码数）
print("industry_unmapped:", c.execute("SELECT count(*), count(DISTINCT ts_code) FROM feat_stock WHERE sw_l1 IS NULL OR sw_l1='未分类'").fetchone())
# 3) ST 5% 档断裂（最后一次非零日, 2026-07-03 之后连续零日数）
print("st5:", c.execute("SELECT max(trade_date) FROM mart_market_day WHERE limit_up_5pct_n > 0").fetchone()[0],
      c.execute("SELECT count(*) FROM mart_market_day WHERE trade_date > '2026-07-03' AND coalesce(limit_up_5pct_n,0)=0").fetchone()[0])
# 4) 两融缺 SZSE 的日期
print("margin_missing_szse:", [str(r[0]) for r in c.execute("SELECT trade_date FROM core_margin_day GROUP BY 1 HAVING NOT list_contains(list(DISTINCT exchange_id),'SZSE') ORDER BY 1").fetchall()])
# 5) 官方名单覆盖（天数, 起, 止）
print("official_list:", c.execute("SELECT count(*), min(trade_date), max(trade_date) FROM mart_market_day WHERE limit_up_list_n IS NOT NULL").fetchone())
c.close()
'@ | & $py -X utf8 -

# 6) 产物体积
Get-Item frontend/dist/ashare-radar.html, data/static-data.json | Select-Object Name, Length
```

v0.4.3 接管后第 1 条实测为 **0**（最小日行数 2,768）；若不为 0，门禁 15 会阻断发布。
`docs/performance.md`、`docs/release.md` 中的复现命令同样已按本机（Windows PowerShell 5.1）验证。
