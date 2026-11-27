# 指标口径（全站唯一 · v0.4.3）

核心指标在 `pipeline/build_marts.py` 中实现，字段定义以本文件为准。前端展示聚合必须
遵循本契约；静态月频直接消费导出的月表；离线包没有覆盖的明细必须显式报缺失。
已知限制的量化披露见 `docs/known_limitations.md`，发布状态见 `docs/status.md`。

本版（v0.4.3）变更要点：补全缺失字段定义；新增数据质量列；两融限定沪深并禁止部分和；
ST 5% 档按"上游断裂"披露；K 线改前复权；历史部分日回补（192 天）。

## 1. 样本（v_stock / feat_stock）

- 股票池：`SSE`/`SZSE` 的 主板 + 创业板 + 科创板；北交所（含新三板时期代码）默认排除。
  `market` 优先取 `core_stock_meta.market`（Tushare 权威值），元数据缺失时按代码前缀兜底
  （688/689→科创板，300/301/302→创业板，8/4/920→北交所，其余→主板）。
- 有效样本：当日有行情行，且 `close`、`adj_factor`、`adj_close` 为正且有限，
  `ret = pct_chg/100` 有限且 `> -1`。
- 剔除：按 `list_date` 与交易日历计算的上市前 5 个交易日（`is_new_stock`）。
  缺上市日期的行不进入市场聚合。
- 停牌：无行情行，不计入分母；不补造收益。
- ST 不因名称被排除；涨跌停按 `stk_limit` 实际价格判定。
- `n_hist_all` = 该股票已加载的有效观察数（不是上市以来完整历史）。

## 2. 收益与成交

| 字段 | 定义 | 单位/备注 |
|---|---|---|
| `ret` | `pct_chg / 100` | 小数。与 `close/pre_close-1` 交叉校验（门禁 4） |
| `adj_close` | `close × adj_factor` | 用于 MA / 新高新低；**不是**前复权价 |
| `ew_ret` | `mean(ret)`（有效且非新股池） | 日 EW 收益，所有区间累计由它复利 |
| `med_ret` | `median(ret)` | 抗极值 |
| `amount` | `Σ daily.amount × 1000` | **元**。Tushare `daily.amount` 原始单位千元 |
| `turnover_rate` | `avg(turnover_rate)`（个股换手率的简单平均） | **百分数**（Tushare 口径，3.0 = 3%）。**不是市值加权**，与指数换手率不可直接比较 |
| `q10/q25/q75/q90` | `quantile_cont(ret, p)` 线性插值分位 | 小数 |
| `iqr` | `q75 − q25` | 小数；显示 pp 时 ×100 |
| `csd` | `stddev_samp(ret)` 横截面标准差 | 小数 |
| `skew` | 横截面偏度 | 无量纲 |
| `n_adv/n_dec/n_flat` | `ret>0` / `ret<0` / `ret=0` 行数 | 平盘计入分布统计、**不计入 breadth 分母** |
| `n_extreme_ret` | `|ret| ≥ 50%` 的非新股行数 | 退市整理/复牌首日等极端披露；这类收益保留原值不 winsorize |

指数收益（`core_index_day`，单位小数）：`hs300_ret=000300.SH`、`zz500_ret=000905.SH`、
`zz1000_ret=000852.SH`、`sse_ret=000001.SH` 的 `pct_chg/100`。指数缺失则对应字段 NULL，
不补 0。

资金流（`core_flow_day`，仅统计同一有效样本内且有资金流记录的股票）：
`flow_breadth = N(net_mf_amount>0)/N(net_mf_amount 非空)`（0–1）；
`net_mf_amount = Σ net_mf_amount × 10000`（万元→元）；`main_net_amount` 为
`(buy_lg+buy_elg−sell_lg−sell_elg)×10000`（元）。缺记录不补 0。

## 3. 广度与均线

- `breadth = N(ret>0) / (N(ret>0)+N(ret<0))`，平盘剔除；全平盘日分母为 0 → **NULL**
  （undefined，不是 0/1）。
- `ma20/60/250_breadth = N(adj_close > MA) / N(足够历史)`：分母分别要求
  `n_hist_all ≥ 20/≥60`、`n_hist252 ≥ 250`。
- **浮点边界**：MA 比较使用相对容差 `adj_close > ma × (1+1e-12)`，数学上"价格 == 均线"
  视为**未站上**（W11-04/W1-09）。不使用该容差时，不同构建环境的浮点求和顺序会让
  1–3 只股票在边界翻转。

## 4. 市值加权与集中度

- 权重：`w_i = circ_mv_{i,t-1} / Σ circ_mv_{t-1}`，`t-1` 为上一市场交易日；仅在同一日
  非新股有效池内有前日正流通市值的股票内归一。缺前日行情退出加权，不沿用旧权重。
- `cw_ret = Σ w_i r_i`；`hhi = Σ w_i² × 10000`；`max_weight = max(w_i)`。
- `top10_share = Σ_{Top10权重} |w_i r_i| / Σ|w_i r_i|`（0–1，避免分母接近 0 爆表）。
- `top10_contrib_pct = Σ_{Top10权重} w_i r_i × 100`（pp）。
- `gain_share_top5pct = 涨幅前 5%（按 ret 降序，`ceil(0.05×N)` 只）的正收益之和 / 全部正收益之和`。
- `ew_cw_gap = ew_ret − cw_ret`。
- Top10 与排名全部带二级决胜键（`wcap DESC, ts_code` / `ret DESC, ts_code`），
  同一份数据重建结果确定（W1-06）。
- 无有效权重时 CW/HHI 为空；全平盘时 `breadth`、`top10_share` 为空，不补 0（W1-07 相关）。

## 5. 数据质量列（v0.4.3 新增，追加在 `mart_market_day` 末尾）

| 列 | 类型 | 定义 |
|---|---|---|
| `weight_coverage` | DOUBLE | 当日有效池中 `prev_circ_mv>0` 行数占比；首个市场交易日（无前日）为 NULL |
| `n_valid_ratio` | DOUBLE | `n_valid / 前 20 个交易日 n_valid 中位数（不含当日）`；前 20 日不足 5 日时 NULL |
| `data_quality` | VARCHAR | `ok` / `partial`。partial 当 `weight_coverage < 0.95` 或 `n_valid_ratio < 0.95`（NULL 不触发）；首个交易日恒 ok |
| `margin_n_exchanges` | BIGINT | 当日两融合计覆盖的交易所数（仅 SSE/SZSE，0–2） |
| `n_extreme_ret` | BIGINT | 当日 `|ret|≥50%` 的非新股行数 |

`data_quality='partial'` 时以下列输出 **NULL**（不得用小数样本重新归一）：
`cw_ret, hhi, max_weight, top10_share, top10_contrib_pct, gain_share_top5pct, ew_cw_gap,
limit_up_n, limit_down_n, limit_up_non5pct_n, limit_up_5pct_n, max_streak, streak_n,
first_board_n`。其余列（n_valid/ew_ret/分布/新高新低/两融）保留并按原口径计算。

回补后预期全历史 `data_quality` 均为 `ok`；该列是**面向未来数据缺口**的防护，也是
payload `meta.data_quality.partial_days` 与 About「已知限制」的数据来源。

## 6. 涨跌停与情绪（`mart_market_day` / `mart_limit_quality` / `feat_stock`）

### 6.1 价格口径（唯一涨跌停口径）

- 涨停：`close ≥ up_limit × 0.999`；跌停：`close ≤ down_limit × 1.001`（`stk_limit` 真实价）。
  新股（上市前 5 个交易日）不判定；`up_limit` 缺失的行不判定。
- `limit_up_n / limit_down_n` 由价格口径汇总，**含 ST**。
- `limit_up_non5pct_n = N(涨停 且 up_limit/pre_close−1 ≥ 6%)`；
  `limit_up_5pct_n = limit_up_n − limit_up_non5pct_n`。
  **这是档位统计，不是 ST 身份统计**；旧字段 `limit_up_ex_st_n`/`limit_up_st_n` 保留但恒为 NULL。
  - 档位来自 Tushare `stk_limit`。低价股四舍五入会让 5% 档实际落在 5.5%–6.5% 灰区，
    全历史约 39 个涨停样本因此被计入非 5% 档，属契约定义的结构性近似（W2-10）。
  - **2026-07-06 上游断裂（已联网核实）**：`stk_limit` 自该日起对仍戴帽的 ST 股整体返回
    10% 档（07-03→07-06 有 148 只 5%→10%，其中 134 只现名含 ST）；当日 196 只 ST 主板股
    全部为 10% 档。本地计算与上游价格自洽，**不按名称伪造 5% 档**。因此
    `limit_up_5pct_n` 自 2026-07-06 起连续为 0，属已知上游断裂（见 known_limitations、
    gate16 档位稳定性告警）。
- 连板（价格口径）：连续市场交易日涨停数；停牌/缺行情日中断。`first_board_n`=1 板、
  `streak_n`=≥2、`max_streak`=最高板。整日样本缺失（`data_quality='partial'`）时连板列
  输出 NULL 而不是把中断后的股票记为首板（W11-03）。与官方 `limit_list_d.limit_times`
  口径不同，不对齐（日均差 5.0 家、最高板差 2.0 板，属定义差异）。
- 新高/新低：`adj_close ≥ 252 日最高` / `≤ 252 日最低`，需 ≥250 日历史。

### 6.2 官方名单口径（依赖 `limit_list_d`，当前账号无权限）

只有两项指标依赖官方名单：**炸板率**与**封单额/封单比**。官方名单覆盖不均匀
（2016–2018 无、2019 仅 24 天、2020–2025 完整、2026 仅部分），因此：

- `limit_up_list_n / limit_down_list_n / broken_n / limit_fd_amount`：官方名单日度汇总；
  无名单日期为 NULL。
- `broken_rate = broken_n / (limit_up_list_n + broken_n)`（官方"炸板率"）；名单为空时 NULL。
- **不使用日线近似值顶替**（日线"触板未封"比官方炸板宽：2024-10-08 日线 2038 vs 官方 631）。
- `mart_limit_quality`（官方名单口径，仅名单日期有行）：
  - `n_limit_up`：官方涨停家数（不含 ST）。
  - `fd_ratio`：涨停样本 `fd_amount / float_mv` 的中位数（无量纲）。**量纲防护**：
    上游在 2019-11-28..2020-04-20 整体放大约 10³（该期清洗后中位仍约 100x 于正常期），
    无法可靠换算，因此**该期间 `limit_fd_amount` 与 `fd_ratio` 整段输出 NULL**；
    其余时期 `fd_amount/float_mv > 2` 的单行样本同样按 NULL。gate17 对异常行占比 >1%
    的日期告警（W11-07/W2-03）。
  - `avg_open_times`：官方涨停股 `open_times` 均值（开板次数，次）。
  - `open_share`：官方涨停股中 `open_times > 0` 的占比 = **开板比例**。
  - ⚠️ `open_share`（开板比例）≠ `broken_rate`（官方炸板率）：前者分母是收盘仍涨停的
    官方名单股，后者分母是"涨停+炸板"；2026-05-22 分别为 0.5826 与 0.1544，不可混用。
  - 与价格口径的 `limit_up_n` 也不同（官方名单不含 ST），同页展示时必须标注口径。

## 7. 行业（`mart_sector_day` / `mart_sector_roll` / `mart_sector_rank`）

- 行业映射：`config/industry_bridge.csv` 把 Tushare 行业名映射为申万一级；未命中记
  `未分类` 并在行业聚合中剔除（`mart_sector_day` 不含未分类）。这是**静态映射**，
  非 point-in-time；历史日未分类比例约 6%（2016–2020），最新日约 0%（W2-05）。
- `mart_sector_day`：`n/n_adv/n_dec/breadth/ew_ret/med_ret/cw_ret/q10/q25/q75/q90/iqr/csd/
  amount/turnover_rate/limit_up_n`，样本口径同市场池但按行业分组；`amount` 单位元。
- `mart_sector_roll`（滚动窗口按**观测行**计，缺整日行业行时窗口向前取样）：
  - `ret_rN = exp(Σ ln(max(1+ew_ret, 1e-6))) − 1`，N∈{5,10,20}；不足 N 行或窗口内有空收益
    返回 NULL；`br_rN` 为同窗口 `avg(breadth)`。
  - `rank_rN`：当日非空 `ret_rN` 降序排名（并列同名次并跳号）。
- `mart_sector_rank.ret20`：20 条观测行的复利累计，需完整 20 行。
- `mart_rotation_day`：
  - `rotation_intensity = avg(|rank20_t − rank20_{t-1}|)`，仅统计两日都有排名的行业；
  - `n_sectors` = 参与计算的行业数；缺行日会因样本变化导致强度可比性下降，接口同时返回
    该计数。单位：名次（无量纲）。
- 静态 `payload.sectors[date]` 与 API `/api/market/day` 一致按 `ew_ret DESC, sw_l1` 排序；
  `sector_roll` 行与 `rotation` 均带 `n_sectors`，`sector_ranks` 带 `ret20`（W2-06）。

## 8. 月度

- `mart_market_month`：`n_days/n_valid/breadth/ew_ret/cw_ret/med_ret/csd/amount/hhi/
  top10_share/ew_ret_cum/hs300_ret_cum/hs300_n_days`；`ew_ret/cw_ret/...` 是日值平均，
  `ew_ret_cum` 才是每日 EW 复利。**任一日 `ew_ret` 缺失 → `ew_ret_cum` 整月 NULL**；
  `hs300_ret_cum` 同样缺一日即 NULL（缺失语义一致，W1-07）。
- 静态 `payload.market_monthly` 与 API `/api/market/series?freq=month` 投影一致（W1-08）。
- `mart_sector_month`：行业月均 + `ew_ret_cum`（同一完整性规则）。

## 9. 两融（`core_margin_day` → `mart_market_day`）

- 仅汇总 `exchange_id IN ('SSE','SZSE')`（与股票池一致，**不含 BSE**）。
- 当日 SSE/SZSE 任一缺失 → `rzye/rzmre` 输出 **NULL**（不再静默部分和）；
  `margin_n_exchanges` 记录实际覆盖数（0–2）。已知上游缺口：2026-05-11/18/21 仅 SSE，
  当时部分和约为邻日 50%（W11-05）。
- 两融 T+1 发布：最新交易日 `rzye/rzmre` 为 NULL 属正常，页面显示缺失而不是部分和。
- 单位：元（Tushare 原始单位）。

## 10. 持仓快照（`mart_stock_latest`）

- 每股保留最后一条行情（`quote_date`）；`is_stale = quote_date < 最新交易日`。
- 最新日有行情：`ret/amount` 用当日值；无当日行情：`ret/amount` 记 0 且 `is_stale=true`，
  前端据此把"今日盈亏/组合日收益"显示为未知，不当作平盘。
- `is_suspended` 恒 NULL（缺报价不能证明停牌）。
- 新股当日无涨跌停判定 → `is_limit_up/is_limit_down` 输出 **false**（不是 NULL，W2-12）。
- 导出 `watch_pool` 按 `ts_code` 排序（确定化）。

## 11. 前复权 K 线（静态 payload `stock_series` / `/api/stock/<code>`）

- 数组字段：`[trade_date, open, high, low, close, vol, adj_factor]`。
- OHLC 为**前复权**：`price_adj = price × adj_factor / adj_factor_last`，`adj_factor_last`
  为窗口内最后一个交易日的复权因子；因此最新一根 K 线与原始价一致，历史除权日不再出现
  假跳空（P1-6：300394 2026-06-12 未复权 -26.5% 假跳空）。
- `adj_factor` 同时返回，便于核对；`vol` 不复权。覆盖：top-60 + 样本股，近 190 自然日
  （见 payload `coverage.stock_series`）。
- 若上游 adj_factor 缺失（akshare 降级日顺延前值），除权日价格仍会偏差，payload/status
  会标注 `adj_degraded_days`（W3-07）。
- 备用源 `stk_limit` 按昨收×板块档位推算，**对无涨跌幅限制的特殊日（退市整理首日等）
  没有哨兵机制**，可能虚构限价；该备用路径仅在当日主源不可用且已过收盘验证时启用，
  属已知限制（见 `docs/known_limitations.md`，W3-10）。

## 12. 状态分类

| 状态 | 条件 |
|---|---|
| 普涨 | `ew_ret > 0` 且 `breadth ≥ 0.50` |
| 集中上涨 | `ew_ret > 0` 且 `breadth < 0.50` |
| 结构分化 | `ew_ret ≤ 0` 且 `breadth ≥ 0.50` |
| 普跌 | `ew_ret ≤ 0` 且 `breadth < 0.50` |

阈值固定，不随图形调整。

## 13. 发布语义

- 质量门禁：1–14 校验当日；15 历史完整性（block：存在部分日即拒绝发布）；16 限价档
  稳定性（warn）；17 fd_amount 量纲（warn）；18 行数趋势（warn）。门禁定义见
  `pipeline/quality_gates.py`。
- `payload.meta.data_quality = {partial_days, n_partial_days, repaired_at, history_gate}`；
  `payload.meta.version` 来自 `pyproject.toml`；`payload.meta.sources` 过滤 `unavailable`，
  不可用数据集单列 `unavailable_datasets`；`meta.source` 只列 tushare/akshare。
- `payload.distribution` 的 `stats` 增加 `n_total/n_binned/n_excluded_lt/n_excluded_gt`：
  分布分箱只覆盖 `ret ∈ [−11%, +11%]`，区间外样本不绘制、只计数（W6-03/W9-04）。
- 源间对账 `payload.reconcile` 带 `generated_at/days/pairs`；`pairs=0` 表示无法核验，
  不构成通过（W3-06/W9-05）。
- 排序确定化：`stocks` 按 `ret DESC, ts_code`；`contrib` 按 `|contrib| DESC, ts_code`；
  除 `meta.generated_at` 外，同一份 mart 导出的 payload 可复现。

## 14. 历史部分日回补（v0.4.3）

- 2026-11-27 用 Tushare 在隔离副本执行 `pipeline.repair_history --apply` 回补 192 个
  部分交易日（2016-12-08..2022-11-16），修复后 `remaining_partial=[]`；
  之后用 `pipeline.promote_repair` 受控切换到生产库并全量重建 marts。
- 修复后全历史 `data_quality` 均为 `ok`，`incomplete_dates()==[]`。
- 修复校验使用**历史适用门禁子集**：1,2,3,4,5,8,9,10,11,12,13（6/9 保持 warn）；
  gate7（静态行业映射非 PIT）与 gate14（个别退市股缺 stock_basic 元数据）标记
  `not_applicable_historical` 并记录实际值，不计入 blocking；gate15 在批次结束后统一跑一次。
- 修复前后对照：最新日锚点不变；ALL 区间 EW 累计从 +22.05% 修正为 **+17.09%**
  （审核报告"+70%"是删除 192 天造成的表列删除偏差，已纠正）。
