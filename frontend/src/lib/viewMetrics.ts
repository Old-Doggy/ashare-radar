/** Display calculations: missing observations must remain distinguishable from zero. */

export function hasDataWarnings(meta: {warnings?: string[]} | undefined, gates: {pass: boolean}[]): boolean {
  return !!meta?.warnings?.length || gates.some(g => !g.pass);
}

export function cumulativePath(returns: (number | null)[]): (number | null)[] {
  let wealth = 1;
  let complete = true;
  return returns.map((ret) => {
    if (ret == null || !Number.isFinite(ret) || ret <= -1) complete = false;
    if (!complete) return null;
    wealth *= 1 + ret!;
    return wealth - 1;
  });
}

/** 区间累计收益；任一日缺失（或被视作不可用的 <= -1）则整体保持未知，而不是把缺日当平盘。 */
export function cumulativeReturn(returns: (number | null | undefined)[]): number | null {
  const path = cumulativePath(returns as (number | null)[]);
  return path.length ? path[path.length - 1] : null;
}

export function median(values: number[]): number | null {
  const sorted = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentile(values: number[], value: number | null): number | null {
  const valid = values.filter((v) => v != null && Number.isFinite(v));
  return value == null || !Number.isFinite(value) || !valid.length ? null
    : Math.round(100 * valid.filter((v) => v <= value).length / valid.length);
}

export function quoteAgeDays(day: string, now = Date.now()): number {
  const shanghaiDay = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  return Math.max(0, Math.floor((Date.parse(`${shanghaiDay}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000));
}

/** 上海时区的日期 / 星期（0=周日）/ 当日分钟数。 */
function shanghaiClock(now: number) {
  const shifted = new Date(now + 8 * 3600000);
  return {
    date: shifted.toISOString().slice(0, 10),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** 严格夹在两个日期之间（不含两端）的工作日数量。 */
function weekdaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  let count = 0;
  let guard = 0;
  for (let t = start + 86400000; t < end && guard < 4000; t += 86400000, guard++) {
    const weekday = new Date(t).getUTCDay();
    if (weekday >= 1 && weekday <= 5) count++;
  }
  return count;
}

/** 数据年龄横幅：只在"确实可能缺数据"时提示，周末/节假日读上一交易日数据不再误报（W5-05）。 */
export type StaleBanner = { days: number; reason: "gap" | "today-missing" };

/**
 * 数据新鲜度横幅判定（替换 `quoteAgeDays(...) >= 1` 这种自然日阈值，W5-05）。
 *
 * - 同日数据：不提示；
 * - 中间已跨过至少一个工作日：`gap`（多半是更新失败或长假，值得提示"可能包含休市日"）；
 * - 只跨周末/节假日，且今天是工作日、上海时间已过更新窗口（默认 22:00，晚于实际 21:45 的更新）：`today-missing`；
 * - 只跨周末/节假日且尚未到更新窗口：不提示（周末读周五数据属正常）。
 */
export function staleBanner(
  lastTradeDate: string | null | undefined,
  now = Date.now(),
  updateDeadlineMinutes = 22 * 60,
): StaleBanner | null {
  if (!lastTradeDate) return null;
  const today = shanghaiClock(now);
  const days = quoteAgeDays(lastTradeDate, now);
  if (days <= 0 || lastTradeDate >= today.date) return null;
  if (weekdaysBetween(lastTradeDate, today.date) >= 1) return { days, reason: "gap" };
  const weekday = today.weekday >= 1 && today.weekday <= 5;
  if (weekday && today.minutes >= updateDeadlineMinutes) return { days, reason: "today-missing" };
  return null;
}

/** 数据年龄横幅的中英文案（供 Shell 直接渲染）。 */
export function staleBannerText(banner: StaleBanner, lastTradeDate: string, lang: string): string {
  const en = lang === "en";
  if (banner.reason === "today-missing") {
    return en
      ? `Today's data has not been updated yet; the latest observation is ${lastTradeDate}. Refresh to check.`
      : `今日数据尚未更新；最新数据 ${lastTradeDate}，可刷新确认。`;
  }
  return en
    ? `Latest observation: ${lastTradeDate} (${banner.days} calendar day${banner.days === 1 ? "" : "s"} ago); holidays may explain the gap. Refresh to check.`
    : `最新数据 ${lastTradeDate}，距今 ${banner.days} 个自然日；可能包含休市日，可刷新确认。`;
}

/** 排序确定化的"涨幅/收益前 N"：EW 收益降序，行业名升序做 tie-break（静态/API 两个路径一致）。 */
export interface RankableSector {
  sw_l1: string;
  ew_ret: number;
}

export function topGainers<T extends RankableSector>(sectors: readonly T[], n = 2): T[] {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...sectors]
    .sort((a, b) => (b.ew_ret - a.ew_ret) || byName(a.sw_l1, b.sw_l1))
    .slice(0, n);
}

export interface ConcentrationRow {
  trade_date: string;
  top10_share?: number | null;
  csd?: number | null;
}

/** 最集中日：只比较 top10_share 有有限值的行（缺失不参与，绝不按 0 比较）。 */
export function mostConcentratedDay<T extends ConcentrationRow>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    const value = row.top10_share;
    if (value == null || !Number.isFinite(value)) continue;
    if (!best || value > (best.top10_share as number)) best = row;
  }
  return best;
}

export interface CoverageRow {
  n_valid?: number | null;
  n_valid_ratio?: number | null;
  data_quality?: string | null;
}

export interface CoverageGap {
  /** 需要披露的覆盖不足交易日数（partial + 低样本）。 */
  total: number;
  /** 数据层标记 data_quality='partial' 的天数。 */
  partial: number;
  /** 未拿到 data_quality 时按"n_valid < 区间中位数一半"识别的低样本天数。 */
  lowSample: number;
  medianNValid: number | null;
  minNValid: number | null;
  flagged: boolean;
}

/**
 * 覆盖不足披露（W7-04）。数据层新增 data_quality / n_valid_ratio 后直接沿用；
 * 字段尚未上线（旧离线包）时退回 n_valid 相对区间中位数的启发式，绝不硬编码天数。
 */
export function coverageGaps(rows: readonly CoverageRow[]): CoverageGap {
  const valid = rows
    .map((row) => row.n_valid)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const medianNValid = median(valid);
  const authority = rows.some((row) => row.data_quality != null || row.n_valid_ratio != null);
  let partial = 0;
  let lowSample = 0;
  let minNValid: number | null = null;
  for (const row of rows) {
    if (row.n_valid != null && Number.isFinite(row.n_valid)) {
      minNValid = minNValid == null ? row.n_valid : Math.min(minNValid, row.n_valid);
    }
    if (authority) {
      const quality = row.data_quality;
      if (quality != null) {
        if (quality === "partial") partial++;
        continue;
      }
      const ratio = row.n_valid_ratio;
      if (ratio != null && Number.isFinite(ratio)) {
        if (ratio < 0.95) lowSample++;
        continue;
      }
    } else if (row.n_valid != null && medianNValid != null && medianNValid > 0 && row.n_valid < medianNValid * 0.5) {
      lowSample++;
    }
  }
  const total = partial + lowSample;
  return { total, partial, lowSample, medianNValid, minNValid, flagged: total > 0 };
}

/** URL `range` 参数校验：非法值回退默认值（W7-11），不再静默显示默认区间却保留非法 URL。 */
export function pickRange<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** 数据源展示：过滤掉占位值 "unavailable"（W7-03 前端防御；根因由后端 meta.source 修复）。 */
export function displaySource(raw: string | null | undefined): string {
  const parts = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.toLowerCase() !== "unavailable");
  return parts.length ? parts.join(", ") : "—";
}

export type StatusKind = "loading" | "error" | "stale" | "warn" | "ok";

/**
 * 状态栏状态机（W7-12）：meta/quality 都拿不到时是"数据不可用"错误态，不是黄色"告警"；
 * 首次加载中单独返回 loading，避免闪烁成错误。
 */
export function statusKind(input: {
  meta?: { status?: string | null; warnings?: string[] } | null;
  quality?: { passed?: boolean | null } | null;
  gates: { pass: boolean }[];
  metaError?: boolean;
  qualityError?: boolean;
  pending?: boolean;
}): StatusKind {
  const noMeta = !input.meta;
  const noQuality = !input.quality;
  if (noMeta && noQuality) return input.pending ? "loading" : "error";
  if (input.meta?.status === "stale" || input.meta?.status === "failed") return "stale";
  if (input.meta?.status === "ok" && !!input.quality?.passed && !hasDataWarnings(input.meta, input.gates)) return "ok";
  return "warn";
}

export function indexSummary(index: number | null, ew: number, lang: string): string {
  const display = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
  if (lang === "en") return `CSI 300 ${index == null ? "unavailable" : display(index)}; equal-weight ${display(ew)}`;
  return `沪深300 ${index == null ? "暂无数据" : display(index)}，等权 ${display(ew)}`;
}
