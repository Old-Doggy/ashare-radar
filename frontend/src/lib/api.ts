/* 数据层：既支持 Flask API，也支持「单文件静态导出」模式。
 * 静态模式下 window.__BL_DATA__ 由 export_static.py 注入，所有请求走本地内存。
 *
 * 2026-11 修复：本文件是 D1/D2 共享的类型契约（其他页面只读，不在页面里重定义）。
 * 契约要点（`_fix_20261127/修复计划与接口约定.md` §3）：
 *  - 所有 /api/* 请求带 `X-Requested-With: ashare-radar`（GET /api/watchlist 必需）；
 *  - mart_market_day 追加 weight_coverage / n_valid_ratio / data_quality / margin_n_exchanges /
 *    n_extreme_ret（旧 payload 可能缺失，全部可选可空）；
 *  - meta.data_quality、meta.version 为新增披露字段；
 *  - stock_series 为前复权 [date, o, h, l, c, vol, adj_factor]，/api/stock 返回
 *    {code, adjust:"qfq", series:[...]}，本文件把两种模式归一成同一种点结构；
 *  - valuation 未知 / quality 缺文件一律返回 null（不返回 {}）；
 *  - distribution 追加 n_total / n_binned / n_excluded_lt / n_excluded_gt。
 */

import { finiteQuantity, validCode } from "./holdings";
const BASE = "";

/** 服务端对所有接口都会校验的来源标记；GET 也必须带（c07/W14-01 修复）。 */
const REQUEST_HEADERS = { "X-Requested-With": "ashare-radar" } as const;

export class ApiError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`${status} ${statusText}`);
    this.name = "ApiError";
  }
}

/** 静态离线包缺某个数据集时抛出的确定性错误：可重试策略必须直接放行，不做退避。 */
export class UnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnavailableError";
  }
}

export class SectorRollUnavailable extends Error {
  constructor(readonly reason: "offline" | "rebuild") {
    super(reason === "offline" ? "Offline export has no rolling sector data" : "Sector rolling table needs rebuilding");
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = params
    ? "?" +
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const res = await fetch(`${BASE}${path}${qs}`, { headers: REQUEST_HEADERS });
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return (await res.json()) as T;
}

/** 历史载荷可能把「不可用」占位值拼进数据源名（tushare, unavailable）。 */
export interface Meta {
  last_trade_date: string;
  first_trade_date: string;
  updated_at: string | null;
  n_stocks: number;
  n_days: number;
  source: string;
  status: "ok" | "stale" | "failed" | "unknown";
  warnings: string[];
  alert?: { time: string; stage: string; message: string; log?: string | null } | null;
  /** 分数据集的数据源（daily=tushare 等）；其中的 "unavailable" 不是数据源名。 */
  sources?: Record<string, string>;
  /** 数据源不可用的数据集名（不含 "unavailable" 占位值）。 */
  unavailable_datasets?: string[];
  /** 版本文本（pyproject / package），供 Briefing 页脚与 About 展示。 */
  version?: string | null;
  /** 历史修复与部分交易日的披露摘要。 */
  data_quality?: DataQualityMeta | null;
}

/** meta.data_quality：历史完整性/部分交易日披露（export_static.py 生成）。 */
export interface DataQualityMeta {
  partial_days?: string[];
  n_partial_days?: number;
  repaired_at?: string | null;
  history_gate?: { pass?: boolean; n_partial_days?: number; n_days?: number; source?: string } | null;
}

export type MarketDataQuality = "ok" | "partial";

export interface MarketDay {
  trade_date: string;
  n_valid: number;
  n_adv: number;
  n_dec: number;
  n_flat: number;
  breadth: number;
  ew_ret: number;
  cw_ret: number;
  med_ret: number;
  q10: number;
  q25: number;
  q75: number;
  q90: number;
  iqr: number;
  csd: number;
  skew: number;
  amount: number;
  turnover_rate: number;
  hhi: number;
  max_weight: number;
  top10_share: number;
  top10_contrib_pct: number;
  gain_share_top5pct: number;
  ew_cw_gap: number;
  limit_up_n: number;
  limit_down_n: number;
  limit_up_list_n: number;
  limit_down_list_n: number;
  broken_n: number;
  broken_rate: number | null;
  max_streak: number;
  streak_n: number;
  first_board_n: number;
  limit_fd_amount: number;
  new_high_n: number;
  new_low_n: number;
  ma20_breadth: number;
  ma60_breadth: number;
  ma250_breadth: number;
  hs300_ret: number | null;
  zz500_ret: number | null;
  zz1000_ret: number | null;
  sse_ret: number | null;
  flow_breadth: number | null;
  net_mf_amount: number | null;
  main_net_amount: number | null;
  rzye: number | null;
  rzmre: number | null;
  /* ---- 追加列（规划 §2.2）：旧离线包可能没有，读取方必须容忍 undefined ---- */
  /** 当日有效池中 prev_circ_mv>0 的占比（首个交易日为 null）。 */
  weight_coverage?: number | null;
  /** n_valid / 前 20 个交易日（不含当日）n_valid 中位数；历史不足 5 日为 null。 */
  n_valid_ratio?: number | null;
  /** ok / partial；partial 日权重类列输出 null。 */
  data_quality?: MarketDataQuality | null;
  /** 两融合计覆盖的交易所数（SSE/SZSE，最多 2）。 */
  margin_n_exchanges?: number | null;
  /** |ret|>=50% 的非新股行数（退市整理/复牌首日披露用）。 */
  n_extreme_ret?: number | null;
  /** 5% / 非 5% 涨跌停档计数：2026-07-06 起上游 stk_limit 档位断裂，见已知限制。 */
  limit_up_non5pct_n?: number | null;
  limit_up_5pct_n?: number | null;
  limit_up_ex_st_n?: number | null;
  limit_up_st_n?: number | null;
}

/** 接口/静态 payload 的市场行别名（契约文档使用 MarketRow 名称）。 */
export type MarketRow = MarketDay;

export interface SectorDay {
  trade_date: string;
  sw_l1: string;
  n: number;
  n_adv: number;
  n_dec: number;
  breadth: number;
  ew_ret: number;
  med_ret: number;
  cw_ret: number;
  q25: number;
  q75: number;
  q10?: number;
  q90?: number;
  iqr: number;
  csd: number;
  amount: number;
  turnover_rate: number;
  limit_up_n: number;
}

export interface SectorMonth {
  month: string;
  sw_l1: string;
  n_days: number;
  breadth: number;
  ew_ret: number;
  cw_ret: number;
  iqr: number;
  amount: number;
  ew_ret_cum: number;
}

export interface StockRow {
  ts_code: string;
  name: string;
  sw_l1: string;
  market: string;
  trade_date: string;
  quote_date?: string | null;
  pre_close?: number | null;
  is_stale?: boolean;
  quote_missing?: boolean;
  close: number;
  ret: number;
  circ_mv: number;
  total_mv: number;
  turnover_rate: number;
  pe_ttm: number;
  pb: number;
  amount: number;
  is_limit_up: boolean;
  is_limit_down: boolean;
  shares?: number;
  cost?: number;
}

export interface Contributor {
  ts_code: string;
  name: string;
  sw_l1: string;
  ret: number;
  weight: number;
  contrib: number;
}

export interface MarketDayDetail extends MarketDay {
  contributors: Contributor[];
  sectors: SectorDay[];
}

export interface DistBin {
  b: number;
  n: number;
  lo: number;
  hi: number;
}

export interface DistributionStats {
  n: number;
  med: number | null;
  p05: number | null;
  p25: number | null;
  p75: number | null;
  p95: number | null;
  mean: number | null;
  sd: number | null;
  /** 部分导出器会把覆盖统计塞进 stats（静态包 2026-11 版本曾如此），这里兼容读取。 */
  n_total?: number | null;
  n_binned?: number | null;
  n_excluded_lt?: number | null;
  n_excluded_gt?: number | null;
}

export interface Distribution {
  bins: DistBin[];
  stats: DistributionStats;
  /** 覆盖统计：样本总数 / 入箱数 / 低于 -11% / 高于 +11%（旧 payload 缺失；
   *  契约结构为顶层，静态导出若放进 stats 也能被 distributionCoverage 兼容）。 */
  n_total?: number | null;
  n_binned?: number | null;
  n_excluded_lt?: number | null;
  n_excluded_gt?: number | null;
}

/** 分布的覆盖面：旧 payload 没有新字段时用 bins 合计与 stats.n 反推。 */
export interface DistributionCoverage {
  total: number | null;
  binned: number | null;
  excludedLt: number | null;
  excludedGt: number | null;
  omitted: number | null;
}

const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function distributionCoverage(dist?: Distribution | null): DistributionCoverage {
  const empty: DistributionCoverage = { total: null, binned: null, excludedLt: null, excludedGt: null, omitted: null };
  if (!dist || !Array.isArray(dist.bins)) return empty;
  const stats = dist.stats ?? ({} as DistributionStats);
  const binned =
    finiteOrNull(dist.n_binned) ??
    finiteOrNull(stats.n_binned) ??
    dist.bins.reduce((sum, b) => sum + (Number.isFinite(b?.n) ? b.n : 0), 0);
  const total = finiteOrNull(dist.n_total) ?? finiteOrNull(stats.n_total) ?? finiteOrNull(stats.n);
  return {
    total,
    binned,
    excludedLt: finiteOrNull(dist.n_excluded_lt) ?? finiteOrNull(stats.n_excluded_lt),
    excludedGt: finiteOrNull(dist.n_excluded_gt) ?? finiteOrNull(stats.n_excluded_gt),
    omitted: total == null ? null : Math.max(0, total - binned),
  };
}

export interface UpdateJob {
  id: string | null;
  state: "idle" | "running" | "done" | "failed";
  progress: number;
  stage: string;
  message: string;
  started_at: string | null;
  finished_at: string | null;
  trade_date: string | null;
}

export interface UpdateLog {
  date: string;
  status: string;
  days: number;
  duration: number | null;
  warnings: number;
}

export interface PePercentile {
  pe: number | null;
  pct: number | null;
  n: number;
  quote_date?: string | null;
}

export interface Reconcile {
  generated_at?: string;
  stocks?: number;
  pairs?: number;
  mae_pp?: number;
  p95_pp?: number;
  max_pp?: number;
  share_gt_0_1pp?: number;
  /** 抽样覆盖的交易日（新导出附带）。 */
  days?: string[];
}

export interface RotationDay {
  trade_date: string;
  rotation_intensity: number;
  n_sectors?: number;
}

export interface SectorRank {
  trade_date: string;
  sw_l1: string;
  rank20: number;
  ret20?: number;
}

/** 轮动滚动指标（mart_sector_roll）：ret/br 是小数，rank 是整数名次（1=最强）。
 *  `amount` 由后端 JOIN mart_sector_day 带回（单位：元），仅用于气泡面积/成交额展示。 */
export interface SectorRollDay {
  trade_date: string;
  sw_l1: string;
  ret_r5: number | null;
  ret_r10: number | null;
  ret_r20: number | null;
  br_r5: number | null;
  br_r10: number | null;
  br_r20: number | null;
  rank_r5: number | null;
  rank_r10: number | null;
  rank_r20: number | null;
  amount?: number | null;
  /** 当日参与轮动的行业数（与静态 payload 对齐，W2-06）。 */
  n_sectors?: number | null;
}

export interface LimitQuality {
  trade_date: string;
  fd_ratio: number | null;
  open_share: number | null;
  avg_open_times: number | null;
  n_limit_up: number;
}

export interface QualityGate {
  id: number;
  name: string;
  pass: boolean;
  value: number | null;
  threshold: string;
  level: "block" | "warn";
  message: string;
}

export interface QualityReport {
  date: string;
  generated_at: string;
  rows: number;
  gates: QualityGate[];
  passed: boolean;
  blocking: number[];
}

/** 月度市场行（/api/market/series?freq=month 与 payload.market_monthly）。 */
export interface MarketMonthRow {
  trade_date: string;
  n_days: number;
  /** 后端 2026-11 起补充：月内有效观测数/沪深300 天数（旧包可能缺失）。 */
  n_valid?: number | null;
  hs300_n_days?: number | null;
  breadth: number;
  ew_ret: number;
  cw_ret: number;
  med_ret: number;
  csd: number;
  amount: number;
  hhi: number;
  top10_share: number;
  ew_ret_cum: number;
  hs300_ret_cum: number | null;
}

/** 个股 K 线点：静态与 API 两种模式统一成同一结构。
 *  `adjust === "qfq"` 时 open/high/low/close 为前复权价（按窗口内最后 adj_factor 归一），
 *  `close_raw` 为复权前的原始收盘价，`adj_close` 为后端派生复权收盘（API 模式有）。 */
export interface StockSeriesPoint {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  adj_factor?: number | null;
  close_raw?: number | null;
  adj_close?: number | null;
  ret?: number | null;
  circ_mv?: number | null;
  turnover_rate?: number | null;
  amount?: number | null;
  sw_l1?: string | null;
  name?: string | null;
  adjust: "qfq" | "none";
}

/** 静态 payload 的 stock_series 元组：[date, o, h, l, c, vol, adj_factor?] */
export type StockSeriesTuple = [string, number, number, number, number, number, number?];

export interface StockSeriesApiPoint {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  adj_factor?: number | null;
  close_raw?: number | null;
  adj_close?: number | null;
  ret?: number | null;
  circ_mv?: number | null;
  turnover_rate?: number | null;
  amount?: number | null;
  sw_l1?: string | null;
  name?: string | null;
}

export interface StockSeriesResponse {
  code: string;
  adjust: "qfq" | "none";
  series: StockSeriesApiPoint[];
}

export interface StaticPayload {
  meta: Meta;
  market: MarketDay[];
  market_monthly?: MarketMonthRow[];
  sectors: Record<string, SectorDay[]>;
  sector_monthly: SectorMonth[];
  rotation?: RotationDay[];
  sector_ranks?: SectorRank[];
  sector_roll?: SectorRollDay[] | null;
  contrib: Record<string, Contributor[]>;
  distribution: Record<string, Distribution>;
  stocks: StockRow[];
  watch_pool: StockRow[];
  stock_series?: Record<string, StockSeriesTuple[]>;
  pe_percentile?: Record<string, PePercentile>;
  limit_quality?: LimitQuality[];
  updates?: UpdateLog[];
  reconcile?: Reconcile;
  quality?: QualityReport | null;
  coverage?: Record<string, string>;
}

declare global {
  interface Window {
    __BL_DATA__?: StaticPayload;
  }
}

const S: StaticPayload | undefined = typeof window !== "undefined" ? window.__BL_DATA__ : undefined;
export const isStatic = !!S;

const ok = <T>(v: T) => Promise.resolve(v);

function unavailable(what: string): never {
  throw new UnavailableError(`此离线包未包含所选${what} / Not included in this offline export`);
}

const inRange = (d: string, start?: string, end?: string) =>
  (!start || d >= start) && (!end || d <= end);

/** 服务端可能返回 {rows,total} / {items,total}，也可能仍返回数组；统一取数组。 */
function normalizeRows<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const holder = payload as { rows?: unknown; items?: unknown; data?: unknown };
    for (const candidate of [holder.rows, holder.items, holder.data]) if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

/** /api/quality 缺文件返回 null；旧后端返回 {}，这里一并归一为 null（W5-04）。 */
export function normalizeQualityReport(payload: unknown): QualityReport | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const report = payload as QualityReport;
  if (!Array.isArray(report.gates)) return null;
  return report;
}

/** /api/valuation 未知代码返回 null；旧后端返回 {}（W5-03）。 */
export function normalizePePercentile(payload: unknown): PePercentile | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Partial<PePercentile>;
  const hasAny = ["pe", "pct", "n"].some((key) => key in raw);
  if (!hasAny) return null;
  return {
    pe: finiteOrNull(raw.pe),
    pct: finiteOrNull(raw.pct),
    n: finiteOrNull(raw.n) ?? 0,
    quote_date: typeof raw.quote_date === "string" ? raw.quote_date : null,
  };
}

/** 数据源展示：过滤 "unavailable"/"unknown" 占位值，不再把不可用当成数据源（W7-03/W9-22）。 */
export function sourceLabel(
  meta?: Pick<Meta, "source" | "sources"> | null,
  lang = "zh",
): string {
  const tokens: string[] = [];
  let sawUnavailable = false;
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    value.split(/[,;/\s]+/).forEach((raw) => {
      const token = raw.trim();
      const lower = token.toLowerCase();
      if (lower === "unavailable") {
        sawUnavailable = true;
        return;
      }
      if (!token || lower === "unknown" || token === "—") return;
      if (!tokens.includes(lower)) tokens.push(lower);
    });
  };
  push(meta?.source);
  if (meta?.sources) Object.values(meta.sources).forEach(push);
  if (tokens.length) return tokens.join(", ");
  return sawUnavailable || unavailableDatasetNames(meta).length
    ? lang === "en"
      ? "unavailable"
      : "不可用"
    : lang === "en"
      ? "unknown"
      : "未知";
}

/** 不可用的数据集名（过滤掉 "unavailable" 占位值本身）。 */
export function unavailableDatasetNames(meta?: Pick<Meta, "sources" | "unavailable_datasets"> | null): string[] {
  const names: string[] = [];
  const add = (key: string) => {
    if (!names.includes(key)) names.push(key);
  };
  (meta?.unavailable_datasets ?? []).forEach((name) => {
    if (typeof name === "string" && name.trim() && name.trim().toLowerCase() !== "unavailable") add(name.trim());
  });
  if (meta?.sources) {
    Object.entries(meta.sources).forEach(([key, value]) => {
      if (typeof value === "string" && value.trim().toLowerCase() === "unavailable") add(key);
    });
  }
  return names;
}

const WATCH_KEY = "bl.watch";

export interface WatchItem {
  ts_code: string;
  shares: number;
  cost: number;
}

function readWatch(): WatchItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
    return (Array.isArray(raw) ? raw : []).map((x: unknown) => {
      if (typeof x === "string") return { ts_code: validCode(x), shares: 0, cost: 0 };
      const o = x as WatchItem;
      return { ts_code: validCode(o.ts_code), shares: finiteQuantity(o.shares ?? 0), cost: finiteQuantity(o.cost ?? 0) };
    });
  } catch {
    throw new Error("本地持仓数据无效，请先备份后修正 / Invalid saved positions; back up and repair them");
  }
}

function writeWatch(items: WatchItem[]) {
  const seen = new Set<string>();
  const clean = items.filter((x) => {
    if (!x.ts_code || seen.has(x.ts_code)) return false;
    seen.add(x.ts_code);
    return true;
  });
  localStorage.setItem(WATCH_KEY, JSON.stringify(clean));
}

/** 静态 payload 的 stock_series → 统一点结构（前复权 + 原始收盘价还原）。 */
function staticStockSeries(raw: StockSeriesTuple[], start?: string, end?: string): StockSeriesPoint[] {
  const adjLast = [...raw].reverse().find((row) => row.length >= 7 && Number.isFinite(row[6]))?.[6] ?? null;
  return raw
    .filter(([d]) => inRange(d, start, end))
    .map((row) => {
      const [d, o, h, l, c, v] = row;
      const adj = row.length >= 7 && Number.isFinite(row[6]) ? (row[6] as number) : null;
      const closeRaw = adj != null && adjLast != null && adj !== 0 ? (c * adjLast) / adj : null;
      return {
        trade_date: d,
        open: o,
        high: h,
        low: l,
        close: c,
        vol: v,
        adj_factor: adj,
        close_raw: closeRaw,
        adjust: adj == null ? ("none" as const) : ("qfq" as const),
      };
    });
}

function apiStockSeries(payload: unknown): StockSeriesPoint[] {
  const res = payload as StockSeriesResponse | StockSeriesApiPoint[] | null;
  if (Array.isArray(res)) {
    return res.map((p) => ({ ...p, adjust: "none" as const }));
  }
  if (!res || !Array.isArray(res.series)) return [];
  const adjust = res.adjust === "qfq" ? ("qfq" as const) : ("none" as const);
  return res.series.map((p) => ({ ...p, adjust }));
}

export const api = {
  meta: () => (S ? ok(S.meta) : get<Meta>("/api/meta")),

  quality: () => (S ? ok(normalizeQualityReport(S.quality)) : get<unknown>("/api/quality").then(normalizeQualityReport)),

  distribution: (date: string) =>
    S
      ? ok(S.distribution[date] ?? unavailable("日期的收益分布"))
      : get<Distribution>(`/api/distribution/${date}`),

  marketSeries: (start?: string, end?: string, freq: "day" | "month" = "day") => {
    if (S) {
      const source = freq === "month" ? (S.market_monthly ?? unavailable("月度数据，请重新导出")) : S.market;
      return ok(source.filter((r) => inRange(r.trade_date, start, end)) as MarketDay[]);
    }
    return get<MarketDay[]>("/api/market/series", { start, end, freq });
  },

  /** 月度市场序列（字段与日频不同：n_days/ew_ret_cum/hs300_ret_cum）。 */
  marketMonthly: (start?: string, end?: string) => {
    if (S) return ok((S.market_monthly ?? unavailable("月度数据，请重新导出")).filter((r) => inRange(r.trade_date, start, end)));
    return get<MarketMonthRow[]>("/api/market/series", { start, end, freq: "month" }).then(
      (rows) => normalizeRows<MarketMonthRow>(rows) as MarketMonthRow[],
    );
  },

  marketDay: (date: string) => {
    if (S) {
      const row = S.market.find((r) => r.trade_date === date) ?? unavailable("市场日期");
      return ok({
        ...row,
        contributors: S.contrib[date] ?? unavailable("日期的贡献明细"),
        sectors: S.sectors[date] ?? unavailable("日期的行业明细"),
      } as MarketDayDetail);
    }
    return get<MarketDayDetail>(`/api/market/day/${date}`);
  },

  sectors: (date: string) => (S ? ok(S.sectors[date] ?? unavailable("日期的行业明细")) : get<SectorDay[]>("/api/sectors", { date })),

  sectorSeries: (start?: string, end?: string) => {
    if (S) {
      const all = Object.values(S.sectors).flat().filter((r) => inRange(r.trade_date, start, end));
      return ok(all);
    }
    return get<unknown>("/api/sectors/series", { start, end }).then((res) => normalizeRows<SectorDay>(res));
  },

  sectorMonthly: (start?: string, end?: string) => {
    if (S) return ok((S.sector_monthly ?? unavailable("月度行业数据")).filter((r) => inRange(r.month, start, end)));
    return get<SectorMonth[]>("/api/sectors/monthly", { start, end });
  },

  rotation: () => (S ? ok(S.rotation ?? unavailable("轮动序列")) : get<RotationDay[]>("/api/rotation")),

  limitQuality: () => (S ? ok(S.limit_quality ?? unavailable("封板质量数据")) : get<LimitQuality[]>("/api/limit-quality")),

  updates: () => (S ? ok(S.updates ?? unavailable("更新日志")) : get<UpdateLog[]>("/api/updates")),

  updateStatus: () =>
    S
      ? ok({ id: null, state: "idle", progress: 0, stage: "", message: "", started_at: null, finished_at: null, trade_date: null } as UpdateJob)
      : get<UpdateJob>("/api/update/status"),

  startUpdate: async (): Promise<UpdateJob> => {
    if (S) throw new UnavailableError("static mode");
    const res = await fetch("/api/update", {
      method: "POST",
      headers: { ...REQUEST_HEADERS, "X-Ashare-Radar": "1" },
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return (await res.json()) as UpdateJob;
  },

  reconcile: () => (S ? ok(S.reconcile ?? null) : get<Reconcile | null>("/api/reconcile")),

  sectorRanks: () => (S ? ok(S.sector_ranks ?? unavailable("行业排名")) : get<SectorRank[]>("/api/sector-ranks")),

  /** 滚动强度序列（轮动图取数）。旧离线包没有这份数据时必须明确报缺失，不能画空图。 */
  sectorRoll: (start?: string, end?: string) => {
    if (S) {
      if (S.sector_roll == null) throw new SectorRollUnavailable("offline");
      return ok(S.sector_roll.filter((r) => inRange(r.trade_date, start, end)));
    }
    return get<SectorRollDay[]>("/api/sectors/roll", { start, end }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 409) throw new SectorRollUnavailable("rebuild");
      throw error;
    });
  },

  stocks: (date: string, sector?: string, limit = 6000) => {
    if (S) {
      if (date !== S.meta.last_trade_date) unavailable("日期的个股数据");
      const rows = S.stocks.filter((r) => r.trade_date === date && (!sector || r.sw_l1 === sector));
      return ok(rows.slice(0, limit));
    }
    return get<unknown>("/api/stocks", { date, sector, limit }).then((res) => normalizeRows<StockRow>(res));
  },

  valuation: (code: string) => {
    if (S) return ok(normalizePePercentile(S.pe_percentile?.[code] ?? null));
    return get<unknown>(`/api/valuation/${code}`).then(normalizePePercentile);
  },

  /** 个股 K 线：两种模式都返回前复权点结构；旧静态包（6 元组）标记 adjust:"none"。 */
  stockSeries: (code: string, start?: string, end?: string) => {
    if (S) {
      const raw = S.stock_series?.[code] ?? [];
      return ok(staticStockSeries(raw, start, end));
    }
    return get<unknown>(`/api/stock/${code}`, { start, end }).then(apiStockSeries);
  },

  watchlist: () => {
    if (S) {
      const items = readWatch();
      const pool = new Map(S.watch_pool.map((r) => [r.ts_code, r]));
      return ok(
        items.map((i) => ({ ...(pool.get(i.ts_code) ?? { ts_code: i.ts_code, name: i.ts_code,
          sw_l1: "", market: "", close: null, ret: null, trade_date: null, quote_missing: true }), ...i })) as StockRow[],
      );
    }
    return get<unknown>("/api/watchlist").then((res) => normalizeRows<StockRow>(res));
  },

  addWatch: (code: string, shares = 0, cost = 0) => {
    validCode(code); finiteQuantity(shares); finiteQuantity(cost);
    if (S) {
      const items = readWatch().filter((i) => i.ts_code !== code);
      items.push({ ts_code: code, shares, cost });
      writeWatch(items);
      return ok({ ok: true });
    }
    return fetch("/api/watchlist", {
      method: "POST",
      headers: { ...REQUEST_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ ts_code: code, shares, cost }),
    }).then(checkedJson);
  },

  updateWatch: (code: string, patch: { shares?: number; cost?: number }) => {
    validCode(code);
    if (!Object.keys(patch).length) throw new Error("shares or cost required");
    Object.values(patch).forEach(finiteQuantity);
    if (S) {
      if (!readWatch().some((i) => i.ts_code === code)) throw new Error("Watch item not found");
      const items = readWatch().map((i) => (i.ts_code === code ? { ...i, ...patch } : i));
      writeWatch(items);
      return ok({ ok: true });
    }
    return fetch(`/api/watchlist/${encodeURIComponent(code)}`, {
      method: "PATCH",
      headers: { ...REQUEST_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then(checkedJson);
  },

  removeWatch: (code: string) => {
    validCode(code);
    if (S) {
      writeWatch(readWatch().filter((c) => c.ts_code !== code));
      return ok({ ok: true });
    }
    return fetch(`/api/watchlist/${encodeURIComponent(code)}`, { method: "DELETE", headers: REQUEST_HEADERS }).then(checkedJson);
  },
};

async function checkedJson(response: Response) {
  if (!response.ok) throw new ApiError(response.status, response.statusText);
  return response.json();
}
