import type { EChartsOption } from "echarts";
import type { MarketDay, SectorDay, StockRow } from "./api";
import { axisStyle, baseChart, type Palette } from "./theme";
import { money, shortDate } from "./format";
import { regimeOf, regimeLabel, type RegimeKey } from "./regime";
import { escapeHtml } from "./html";
import { axisDateLabel, pointerDateLabel, rowByDate, timeZoom, ZOOM_BOTTOM, type TimeZoom } from "./charts";

/** 状态色从 Palette 派生：色盲模式下涨跌自动切蓝/橙，浅色主题也与 --up/--down 一致（W6-04）。 */
export const regimeColor = (k: RegimeKey, p: Palette): string =>
  k === "broad_up"
    ? p.up
    : k === "concentrated_up"
      ? p.copper
      : k === "broad_down"
        ? p.down
        : k === "mixed"
          ? p.muted
          : p.faint;

/** Regime 散点连续色的中间色（沙色）；浅色主题用更深的沙色保证对比度。 */
export const regimeSand = (p: Palette): string => (p.bg === "#f6f2e8" ? "#a8864a" : "#a67f3f");

/**
 * Regime 散点颜色：0% 处是沙色，|ew_ret| 3% 以上饱和为涨/跌色。
 * 旧实现把基础权重设为 0.35，导致 0% 已经偏红/偏绿（W6-14）。
 */
export const regimeToneColor = (v: number, p: Palette): string =>
  mix(regimeSand(p), v >= 0 ? p.up : p.down, Math.min(1, Math.abs(v) / 3));

/**
 * Regime 页图例渐变：与 regimeToneColor 同一条曲线在 [-3,-1.5,0,1.5,3] 处采样，
 * 图例 0% 位置正好是沙色（W6-14）。
 */
export function regimeLegendGradient(p: Palette): string {
  return `linear-gradient(90deg, ${[-3, -1.5, 0, 1.5, 3].map((v) => regimeToneColor(v, p)).join(", ")})`;
}


const xs = (rows: MarketDay[]) => rows.map((r) => shortDate(r.trade_date));
const L = (lang: string, zh: string, en: string) => (lang === "en" ? en : zh);

const hex = (h: string) => {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const mix = (a: string, b: string, k: number) => {
  const A = hex(a), B = hex(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, "0")).join("");
};

/** 市场云图：成交额 × 涨跌，按申万一级分组。 */
export function treemapChart(p: Palette, stocks: StockRow[], lang = "zh"): EChartsOption {
  const top = [...stocks].sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 30);
  const total = top.reduce((a, s) => a + (s.amount || 0), 0) || 1;
  const maxAbs = Math.max(...top.map((s) => Math.abs(s.ret || 0)), 0.03);
  const groups = new Map<string, StockRow[]>();
  top.forEach((s) => {
    const k = s.sw_l1 || L(lang, "未分类", "Other");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  });
  const colorOf = (ret: number) => {
    if (Math.abs(ret) < 0.0004) return p.panel3;
    const k = Math.min(1, Math.abs(ret) / maxAbs);
    return mix(p.panel3, ret > 0 ? p.up : p.down, 0.16 + k * 0.84);
  };
  const data = [...groups.entries()].map(([name, arr]) => ({
    name,
    value: arr.reduce((a, s) => a + (s.amount || 0), 0),
    itemStyle: { color: p.panel2 },
    label: { show: false },
    children: arr.map((s) => {
      const ratio = (s.amount || 0) / total;
      const fill = colorOf(s.ret || 0);
      const [rr, gg, bb] = hex(fill);
      const lum = (0.2126 * rr + 0.7152 * gg + 0.0722 * bb) / 255;
      return {
        name: s.name,
        value: s.amount || 0,
        ret: s.ret,
        code: s.ts_code,
        sector: s.sw_l1,
        itemStyle: { color: fill },
        label: {
          show: ratio > 0.0035,
          color: lum > 0.58 ? "#1a1b1d" : "#ffffff",
          fontSize: ratio > 0.02 ? 11.5 : 10.5,
          lineHeight: ratio > 0.012 ? 12 : 11,
          overflow: "break" as const,
          formatter: () => {
            const ret = (s.ret * 100).toFixed(2) + "%";
            return ratio > 0.012 ? `${s.name}\n${ret}` : s.name;
          },
        },
      };
    }),
  }));

  return {
    ...baseChart(p),
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { data?: { name?: string; ret?: number; code?: string; value?: number } };
        const d = q.data || {};
        if (d.ret === undefined) return `<div style="font-weight:600">${escapeHtml(d.name)}</div>`;
        return `<div style="min-width:150px">
          <div style="font-weight:600;margin-bottom:4px">${escapeHtml(d.name)}${d.code ? ` <span style="font-family:monospace;font-size:9px;color:${p.muted}">${escapeHtml(d.code)}</span>` : ""}</div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "涨跌", "Return")}</span><b style="color:${(d.ret || 0) >= 0 ? p.up : p.down}">${((d.ret || 0) * 100).toFixed(2)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "成交额", "Turnover")}</span><b>${money((d.value || 0), lang)}</b></div>
        </div>`;
      },
    },
    series: [
      {
        type: "treemap",
        width: "100%",
        height: "100%",
        top: 0,
        left: 0,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        leafDepth: 2,
        data,
        levels: [
          { itemStyle: { borderColor: p.bg, borderWidth: 2, gapWidth: 2 }, upperLabel: { show: false } },
          {
            itemStyle: { borderColor: p.bg, borderWidth: 1, gapWidth: 1 },
            upperLabel: {
              show: true,
              height: 16,
              color: p.text2,
              fontSize: 11,
              fontFamily: "JetBrains Mono Variable, monospace",
              backgroundColor: "transparent",
            },
          },
        ],
        label: {
          show: true,
          color: "#ffffff",
          fontSize: 11,
          lineHeight: 12,
          overflow: "truncate",
          formatter: (params: any) => {
            const d = params.data || {};
            if (d.ret === undefined) return d.name ?? "";
            return `${d.name}\n${(d.ret * 100).toFixed(2)}%`;
          },
        },
        upperLabel: {
          show: true,
          height: 16,
          color: p.text2,
          fontSize: 11,
          fontFamily: "JetBrains Mono Variable, monospace",
        },
        itemStyle: { gapWidth: 1, borderColor: p.bg },
      },
    ],
  };
}

/** 市场日行的可选新增列（接口约定 §2.2；api.ts 类型由 D3 更新，这里用结构兼容旧离线包）。 */
type MarketDayQuality = MarketDay & { data_quality?: string | null };

export interface ConcentrationOpts {
  /** 区间首行之前的最多 19 行，用于预热 20 日均值；缺省时按旧行为从区间内起算（W6-02）。 */
  lead?: MarketDay[];
}

/**
 * 集中度：Top10 每 5 个交易日均值 + 20 日均值。缺失观察不补 0。
 *
 * - 5 日分组按**最新交易日右对齐**：同一末日柱在 3M/1Y/ALL 下都是完整 5 日均值，
 *   缺口只出现在最旧的一组，切换范围不再让同一日期柱高漂移（W6-02）。
 * - 20 日均值用 `opts.lead`（区间前最多 19 行）预热，短区间开头不再人为缺线（W6-02）。
 * - `data_quality='partial'` 的交易日（数据层新增列；旧包无该字段时保持原样）
 *   整组柱体用铜色标记并在 tooltip 说明，避免把部分日假尖峰当真实集中度（W6-01）。
 * - 纵轴保留 0 基线、上限按数据自适应（最少 30%），不再固定 0–100% 压缩正常波动；
 *   缩放模式下交给 ECharts 按窗口自适应（W6-01/W6-15）。
 */
export function concentrationChart(
  p: Palette,
  rows: MarketDay[],
  lang = "zh",
  zoom?: TimeZoom,
  opts: ConcentrationOpts = {},
): EChartsOption {
  const mean = (vals: (number | null)[], digits: number) => {
    if (!vals.length || vals.some((v) => v == null || !Number.isFinite(v))) return null;
    return +(vals.reduce<number>((sum, v) => sum + v!, 0) / vals.length).toFixed(digits);
  };
  const percent = (value: number | null | undefined) => value == null ? null : value * 100;
  const roll = (vals: (number | null)[], w = 20) =>
    vals.map((_, i) => {
      if (i < w - 1) return null;
      return mean(vals.slice(i - w + 1, i + 1), 1);
    });

  const lead = opts.lead ?? [];
  // 20 日均值在"区间前 19 行 + 区间"上计算，再裁掉预热段；旧调用（无 lead）退化为区间内起算
  const avgSeq = roll([...lead, ...rows].map((r) => percent(r.top10_share)));
  const avgRange = avgSeq.slice(lead.length);
  const partialOf = (r: MarketDay) => (r as MarketDayQuality).data_quality === "partial";

  type Week = {
    date: string;
    top10: number | null;
    avg: number | null;
    gain: number | null;
    hhi: number | null;
    n: number;
    partial: boolean;
  };
  const weekly: Week[] = [];
  const pushChunk = (chunk: MarketDay[], endInRange: number) => {
    if (!chunk.length) return;
    weekly.push({
      date: chunk[chunk.length - 1].trade_date,
      top10: mean(chunk.map((r) => percent(r.top10_share)), 1),
      avg: avgRange[endInRange] ?? null,
      gain: mean(chunk.map((r) => percent(r.gain_share_top5pct)), 0),
      hhi: mean(chunk.map((r) => r.hhi ?? null), 0),
      n: chunk.length,
      partial: chunk.some(partialOf),
    });
  };
  // 右对齐：最后一组恒定吃满 5 行（W6-02）
  const offset = rows.length % 5;
  if (offset) pushChunk(rows.slice(0, offset), offset - 1);
  for (let i = offset; i < rows.length; i += 5) {
    const chunk = rows.slice(i, i + 5);
    pushChunk(chunk, i + chunk.length - 1);
  }

  const finite = weekly
    .flatMap((w) => [w.top10, w.avg])
    .filter((v): v is number => v != null && Number.isFinite(v));
  const dataMax = finite.length ? Math.max(...finite) : 0;
  // 自适应上限：至少 30%，留 10% headroom，取 5 的整数倍；数据本身有上限（≤100%）
  const yMax = Math.min(100, Math.max(30, Math.ceil((dataMax * 1.1) / 5) * 5));
  // partial 日即使 top10_share 按契约输出 NULL（柱缺失），也用浅色带标出整组，避免与普通缺数混淆
  const partialBands: [{ xAxis: number }, { xAxis: number }][] = [];
  weekly.forEach((w, index) => {
    if (w.partial) partialBands.push([{ xAxis: index - 0.5 }, { xAxis: index + 0.5 }]);
  });

  return {
    ...baseChart(p),
    // 关掉 ECharts 自带的系列入场动画：上下两个面板的系列类型不同（柱/线/面积），
      // 入场动画节奏不一致，换范围时会「先动上面再动下面」。这里交给旧图快照淡出 +
      // 自定义的 dataZoom 镜头补间，两个面板共用同一个窗口，天然同步。
      ...(zoom ? { animation: false } : {}),
    grid: { left: 6, right: 10, top: 18, bottom: zoom ? ZOOM_BOTTOM : 24, containLabel: true },
    ...(zoom ? { dataZoom: timeZoom(p, weekly.length, 0, zoom) } : {}),
    ...(zoom ? { axisPointer: { label: pointerDateLabel } } : {}),
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const w = rowByDate(weekly, params, "date");
        if (!w) return "";
        return `<div style="min-width:176px">
          <div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:5px">${escapeHtml(w.date)} · ${w.n} ${L(lang, "交易日均值", "session avg")}</div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "Top10 波动占比", "Top10 share")}</span><b>${w.top10 == null ? "—" : w.top10.toFixed(1) + "%"}</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "20 日均值", "20d avg")}</span><b>${w.avg === null ? "—" : w.avg + "%"}</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "涨幅前 5% 份额", "Top 5% gain share")}</span><b>${w.gain == null ? "—" : w.gain + "%"}</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>HHI</span><b>${w.hhi ?? "—"}</b></div>
          ${w.partial ? `<div style="margin-top:6px;color:${p.copper};font-size:11px">${L(lang, "该组含数据不完整日（partial），仅作参考", "Includes partial day(s); treat with care")}</div>` : ""}
        </div>`;
      },
    },
    xAxis: {
      type: "category",
      data: zoom ? weekly.map((w) => w.date) : weekly.map((w) => shortDate(w.date)),
      ...axisStyle(p),
      splitLine: { show: false },
      axisLabel: zoom
        ? { ...axisStyle(p).axisLabel, interval: "auto" as const, formatter: axisDateLabel, hideOverlap: true }
        : { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(weekly.length / 5)) },
    },
    yAxis: {
      type: "value",
      min: 0,
      // 缩放模式：让 y 轴跟随 dataZoom 过滤后的窗口自适应；非缩放：数据自适应上限
      ...(zoom ? {} : { max: yMax }),
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
    },
    series: [
      {
        name: lang === "en" ? "Top10 5-session avg" : "Top10 每5交易日均值",
        type: "bar",
        data: weekly.map((w) => (w.partial && w.top10 != null ? { value: w.top10, itemStyle: { color: p.copper, opacity: 0.62 } } : w.top10)),
        barWidth: "55%",
        itemStyle: { color: p.text2, opacity: 0.38, borderRadius: 2 },
        silent: true,
        markArea: partialBands.length
          ? { silent: true, itemStyle: { color: p.copper, opacity: 0.12 }, data: partialBands }
          : undefined,
      },
      {
        name: lang === "en" ? "Top10 20d avg" : "Top10 20 日均值",
        type: "line",
        data: weekly.map((w) => w.avg),
        showSymbol: false,
        smooth: 0.2,
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { color: p.accent, width: 2 },
      },
    ],
  };
}

export function regimeScatter(
  p: Palette,
  rows: MarketDay[],
  selected: string | null,
  lang: string,
  trailN = 30,
): EChartsOption {
  const amtMax = Math.max(...rows.map((r) => r.amount || 0), 1);
  const valid = rows.filter((r) => r.breadth != null && Number.isFinite(r.breadth));
  const data = valid.map((r) => {
    const ret = r.ew_ret * 100;
    const breadth = r.breadth * 100;
    return {
      value: [ret, breadth, r.amount || 0, r.csd],
      rawRet: ret,
      rawBreadth: breadth,
      trade_date: r.trade_date,
      regime: regimeLabel(regimeOf(r), lang),
      itemStyle: { color: regimeToneColor(ret, p), opacity: 0.82 },
    };
  });

  const xsAll = rows.map((r) => r.ew_ret * 100);
  const bound = Math.max(1, Math.ceil(Math.max(...xsAll.map(Math.abs)) * 2) / 2);
  const trail = valid.slice(-trailN);

  return {
    ...baseChart(p),
    grid: { left: 10, right: 18, top: 42, bottom: 12, containLabel: true },
    graphic: [
      { type: "text", left: "9%", top: 44, style: { text: L(lang, "结构分化", "Divergent"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", right: "5%", top: 44, style: { text: L(lang, "普涨", "Broad rally"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", left: "9%", bottom: 32, style: { text: L(lang, "普跌", "Broad selloff"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", right: "5%", bottom: 32, style: { text: L(lang, "集中上涨", "Narrow rally"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
    ],
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { seriesName: string; data: { value: number[]; rawRet: number; rawBreadth: number; trade_date: string; regime: string } };
        const [, , , csd] = q.data.value;
        const ret = q.data.rawRet;
        const breadth = q.data.rawBreadth;
        return `<div style="min-width:158px">
          <div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:5px">${escapeHtml(q.data.trade_date)}</div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "等权收益", "EW return")}</span><b style="color:${ret >= 0 ? p.up : p.down}">${ret.toFixed(2)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "上涨占比", "Breadth")}</span><b>${breadth.toFixed(1)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "分化度", "Dispersion")}</span><b>${csd == null ? "—" : (csd * 100).toFixed(2) + "pp"}</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "状态", "Regime")}</span><b>${escapeHtml(q.data.regime)}</b></div>
        </div>`;
      },
    },
    xAxis: {
      type: "value",
      min: -bound,
      max: bound,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
    },
    series: [
      {
        type: "line",
        data: trail.map((r) => [r.ew_ret * 100, r.breadth * 100]),
        showSymbol: false,
        silent: true,
        z: 1,
        lineStyle: { color: p.accent, width: 1, opacity: 0.45, type: "dashed" },
      },
      {
        name: L(lang, "交易日", "Sessions"),
        type: "scatter",
        data,
        symbolSize: (val: number[]) => 3.8 + Math.sqrt((val[2] || 0) / amtMax) * 7,
        itemStyle: { opacity: 0.68, borderWidth: 0 },
        emphasis: { itemStyle: { opacity: 1 }, scale: 1.25 },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          label: { show: false },
          data: [{ xAxis: 0 }, { yAxis: 50 }],
        },
        z: 2,
      },
      {
        type: "effectScatter",
        data: valid
          .filter((r) => r.trade_date === selected)
          .map((r) => ({
            value: [r.ew_ret * 100, r.breadth * 100],
            trade_date: r.trade_date,
          })),
        symbolSize: 13,
        rippleEffect: { scale: 2.6, brushType: "stroke" },
        itemStyle: { color: "transparent", borderColor: p.text, borderWidth: 1.6 },
        label: {
          show: true,
          formatter: lang === "en" ? "selected" : "选中",
          position: "right",
          color: p.text2,
          fontSize: 11,
        },
        z: 6,
        silent: true,
      },
    ],
  };
}

export function dispersionChart(p: Palette, rows: MarketDay[], lang = "zh", zoom?: TimeZoom): EChartsOption {
  return {
    ...baseChart(p),
    // 关掉 ECharts 自带的系列入场动画：上下两个面板的系列类型不同（柱/线/面积），
      // 入场动画节奏不一致，换范围时会「先动上面再动下面」。这里交给旧图快照淡出 +
      // 自定义的 dataZoom 镜头补间，两个面板共用同一个窗口，天然同步。
      ...(zoom ? { animation: false } : {}),
    grid: { left: 4, right: 8, top: 14, bottom: zoom ? ZOOM_BOTTOM : 18, containLabel: true },
    ...(zoom ? { dataZoom: timeZoom(p, rows.length, 0, zoom) } : {}),
    ...(zoom ? { axisPointer: { label: pointerDateLabel } } : {}),
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const r = rowByDate(rows, params, "trade_date");
        if (!r) return "";
        return `<div style="font-family:monospace;font-size:12px;color:${p.muted}">${escapeHtml(r.trade_date)}</div>
          <div style="display:flex;gap:16px;justify-content:space-between"><span>${L(lang, "横截面标准差", "Cross-sectional σ")}</span><b>${r.csd == null ? "—" : (r.csd * 100).toFixed(2) + "pp"}</b></div>
          <div style="display:flex;gap:16px;justify-content:space-between"><span>IQR</span><b>${r.iqr == null ? "—" : (r.iqr * 100).toFixed(2) + "pp"}</b></div>
          <div style="display:flex;gap:16px;justify-content:space-between"><span>${L(lang, "等权-加权", "EW − CW")}</span><b>${r.ew_cw_gap == null ? "—" : (r.ew_cw_gap * 100).toFixed(2) + "pp"}</b></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: zoom ? rows.map((r) => r.trade_date) : xs(rows),
      ...axisStyle(p),
      splitLine: { show: false },
      axisLabel: {
        ...axisStyle(p).axisLabel,
        interval: zoom ? ("auto" as const) : Math.max(0, Math.floor(rows.length / 5)),
        ...(zoom ? { formatter: axisDateLabel, hideOverlap: true } : {}),
        fontSize: 11,
      },
    },
    yAxis: {
      type: "value",
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}pp", fontSize: 11 },
      splitNumber: 3,
    },
    series: [
      {
        name: lang === "en" ? "Cross-section SD" : "横截面标准差",
        type: "line",
        data: rows.map((r) => r.csd == null ? null : +(r.csd * 100).toFixed(2)),
        showSymbol: false,
        smooth: 0.2,
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { color: p.text2, width: 2 },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(168,162,154,.10)" },
              { offset: 1, color: "rgba(168,162,154,0)" },
            ],
          },
        },
      },
      {
        name: lang === "en" ? "IQR" : "IQR",
        type: "line",
        data: rows.map((r) => r.iqr == null ? null : +(r.iqr * 100).toFixed(2)),
        showSymbol: false,
        smooth: 0.2,
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { color: p.accent, width: 1.8, opacity: 0.95 },
      },
    ],
  };
}
