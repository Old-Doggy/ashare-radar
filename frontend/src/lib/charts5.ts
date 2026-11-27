import type { EChartsOption } from "echarts";
import { axisStyle, baseChart, seriesColors, type Palette } from "./theme";
import { escapeHtml, signedMoneyRounded, signedTone } from "./holdings";

export interface BookRow {
  ts_code: string;
  name: string;
  sw_l1: string;
  close: number;
  ret: number;
  shares: number;
  cost: number;
  mv: number;
  pnl: number;
  today: number | null;
}

const L = (lang: string, zh: string, en: string) => (lang === "en" ? en : zh);

/** 行业暴露分组（图表与卡片 pill 共用同一口径，W9-15）：
 *  只统计「填写了股数且市值 > 0」的持仓，按行业合并；返回按权重升序（图表自下而上）。 */
export interface ExposureGroup {
  name: string;
  mv: number;
  n: number;
  /** 组合权重（%），与 tooltip 同一精度来源 */
  weightPct: number;
}

export function sectorExposureGroups(rows: readonly BookRow[], lang = "zh"): ExposureGroup[] {
  const groups = new Map<string, { mv: number; n: number }>();
  rows.forEach((r) => {
    if (!(r.shares > 0) || !(r.mv > 0)) return;
    const k = r.sw_l1 || L(lang, "未分类", "Other");
    const cur = groups.get(k) || { mv: 0, n: 0 };
    cur.mv += r.mv || 0;
    cur.n += 1;
    groups.set(k, cur);
  });
  const total = [...groups.values()].reduce((a, s) => a + s.mv, 0) || 1;
  return [...groups.entries()]
    .map(([name, s]) => ({
      name,
      mv: s.mv,
      n: s.n,
      weightPct: (s.mv / total) * 100,
    }))
    .sort((a, b) => a.weightPct - b.weightPct);
}

/** 行业暴露：按市值占比的横向条形。 */
export function sectorExposureChart(p: Palette, rows: BookRow[], lang = "zh"): EChartsOption {
  const groups = sectorExposureGroups(rows, lang);
  const colors = seriesColors(p);
  const data = groups.map((g, i) => ({
    name: g.name,
    value: +g.weightPct.toFixed(1),
    n: g.n,
    itemStyle: { color: colors[i % colors.length], borderRadius: 2 },
  }));

  return {
    ...baseChart(p),
    grid: { left: 6, right: 30, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { data?: { name?: string; value?: number; n?: number } };
        const d = q.data || {};
        const weight = typeof d.value === "number" && Number.isFinite(d.value) ? `${d.value.toFixed(1)}%` : "—";
        return `<div style="min-width:150px">
          <div style="font-weight:600;margin-bottom:3px">${escapeHtml(d.name)}</div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "组合权重", "Book weight")}</span><b>${weight}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "持仓数", "Positions")}</span><b>${d.n ?? 0}</b></div>
        </div>`;
      },
    },
    xAxis: {
      type: "value",
      max: 100,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
      splitNumber: 2,
    },
    yAxis: {
      type: "category",
      data: data.map((d) => d.name),
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, color: p.text2, fontSize: 11.5 },
      splitLine: { show: false },
    },
    series: [
      {
        type: "bar",
        data,
        barWidth: 9,
        label: {
          show: true,
          position: "right",
          // W6-13：label 与 tooltip 使用同一精度（1 位小数）
          formatter: (params: any) => `${Number(params.value).toFixed(1)}%`,
          color: p.text2,
          fontSize: 11,
          fontFamily: "JetBrains Mono Variable, monospace",
        },
      },
    ],
  };
}

export interface ContributionItem {
  name: string;
  /** 未舍入原始今日盈亏（判号/着色用） */
  raw: number;
  /** 舍入后的柱值（图形长度） */
  value: number;
  ret: number;
  tone: "up" | "down" | "flat";
  /** 图表 label 与 tooltip 共用的格式化文本（W6-13） */
  text: string;
}

/** 今日盈亏贡献序列（W6-07/W6-13/W5-10）：
 *  - 判号/着色用未舍入 raw，避免 (-0.5,0) 元被舍入成 -0 后染成上涨色；
 *  - label 与 tooltip 共用 signedMoneyRounded，符号取原始值；
 *  - 缺值/非有限不进入序列，不伪装成 +¥0。 */
export function contributionSeries(rows: readonly BookRow[], limit = 10): ContributionItem[] {
  return rows
    .filter((r) => r.shares > 0 && r.today !== null && Number.isFinite(r.today))
    .map((r) => ({ name: r.name, raw: r.today as number, ret: r.ret }))
    .sort((a, b) => Math.abs(b.raw) - Math.abs(a.raw))
    .slice(0, limit)
    .reverse()
    .map((d) => ({
      name: d.name,
      raw: d.raw,
      // 未舍入值判号；柱长可以舍入到 0，但把 JS 的 -0 归一成 0（颜色/符号另由 raw 决定）
      value: Math.round(d.raw) || 0,
      ret: d.ret,
      tone: signedTone(d.raw),
      text: signedMoneyRounded(d.raw),
    }));
}

/** 今日盈亏贡献：按个股正负横向条形。 */
export function contributionChart(p: Palette, rows: BookRow[], lang = "zh", limit = 10): EChartsOption {
  const data = contributionSeries(rows, limit);
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const toneColor = (tone: ContributionItem["tone"]) => (tone === "up" ? p.up : tone === "down" ? p.down : p.muted);

  return {
    ...baseChart(p),
    grid: { left: 6, right: 34, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { data?: Partial<ContributionItem> };
        const d = q.data || {};
        const raw = typeof d.raw === "number" && Number.isFinite(d.raw)
          ? d.raw
          : typeof d.value === "number" && Number.isFinite(d.value) ? d.value : null;
        const tone = d.tone ?? signedTone(raw);
        const money = d.text ?? (raw === null ? "—" : signedMoneyRounded(raw));
        const ret = typeof d.ret === "number" && Number.isFinite(d.ret) ? `${(d.ret * 100).toFixed(2)}%` : "—";
        return `<div style="min-width:150px">
          <div style="font-weight:600;margin-bottom:3px">${escapeHtml(d.name)}</div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "今日盈亏", "Today P&L")}</span><b style="color:${toneColor(tone)}">${money}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "当日涨跌", "Return")}</span><b>${ret}</b></div>
        </div>`;
      },
    },
    xAxis: {
      type: "value",
      min: -max,
      max,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: (v: number) => `${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "k" : v}` },
      splitNumber: 2,
    },
    yAxis: {
      type: "category",
      data: data.map((d) => d.name),
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, color: p.text2, fontSize: 11.5 },
      splitLine: { show: false },
    },
    series: [
      {
        type: "bar",
        data: data.map((d) => ({
          ...d,
          itemStyle: { color: toneColor(d.tone), borderRadius: d.value >= 0 ? [0, 2, 2, 0] : [2, 0, 0, 2] },
        })),
        barWidth: 9,
        label: {
          show: true,
          position: "right",
          // W6-13：label 与 tooltip 完全同源（含 ¥ 与符号，符号取原始值）
          formatter: (params: any) => String(params.data?.text ?? ""),
          color: p.muted,
          fontSize: 11,
          fontFamily: "JetBrains Mono Variable, monospace",
        },
      },
    ],
  };
}
