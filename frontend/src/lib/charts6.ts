/** 行业强度云（轮动图）的 ECharts option 构造。
 *
 * 硬性约束（对应《正式平台接入方案》F3 / §10 回归清单）：
 * - C1 animation:false —— 位置由 rAF 手动驱动，开着动画会和手动插值打架；
 * - C2 每帧只回传 series，不回传整个 option（60fps 下整份 option diff 是主要开销）；
 * - C3 残影/位移线/气泡/轨迹共用同一份（平滑后）矩阵；
 * - C4 轴范围用平滑后的矩阵算；
 * - C5 长轨迹不连折线：面包屑点 + 最近 N 日实线；
 * - C6 tooltip 里所有外部字符串过 escapeHtml；
 * - C7 所有数值 Number.isFinite 校验后再进 option；
 * - C8 标签光晕色取 p.panel，浅色主题不出现黑边；
 * - C9 象限色取 p.up / p.copper / p.down / p.muted，色盲模式自动跟随；
 * - C10 选中标签单独一条 series，labelLayout.hideOverlap:false。
 */
import type { EChartsOption } from "echarts";
import { axisStyle, baseChart, type Palette } from "./theme";
import { escapeHtml } from "./html";
import { money } from "./format";
import type { Bounds, Pt, Trail } from "./rotation";

/** R11：系列数固定为 6（轨迹线/轨迹点/残影/位移/气泡/选中），
 *  `rotationFrame` 返回前做长度校验，改动系列数时不会静默错位（W6-10）。 */
export const SERIES_COUNT = 6;

const L = (lang: string, zh: string, en: string) => (lang === "en" ? en : zh);
const finitePct = (v: number | null | undefined, digits: number): string =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "—";

export interface RotationBubble {
  name: string;
  coord: Pt | null;
  ret: number | null;
  breadth: number | null;
  rank: number | null;
  /** 成交额（元，来自 mart_sector_day，JOIN 回带）；仅展示用 */
  amt: number | null;
  /** 0..1，按成交额在窗口内归一化后的气泡权重（气泡面积 = 成交额） */
  weight: number;
}

export interface RotationFrameData {
  bubbles: RotationBubble[];
  /** 选中行业索引；-1 表示未选中 */
  focus: number;
  /** 悬停行业索引；-1 表示无悬停 */
  hover: number;
  /** 需要常驻标签的行业索引（按窗口末日 rank 取前 N） */
  labelIdx: ReadonlySet<number>;
  trail: Trail;
  ghost: Pt | null;
  current: Pt | null;
  displacementValid?: boolean;
  focusName: string;
}

function quadColor(p: Palette, pt: Pt | null): string {
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return p.muted;
  if (pt.x > 0 && pt.y >= 50) return p.up;
  if (pt.x > 0) return p.copper;
  if (pt.y < 50) return p.down;
  return p.muted;
}

/** 标签光晕：同背景色描边，任何底图上都能读出来；颜色取 p.panel（C8）。 */
function haloLabel(p: Palette, name: string, dim: boolean) {
  return {
    show: true,
    formatter: () => name,
    position: "top" as const,
    distance: 4,
    color: dim ? p.faint : p.text2,
    fontSize: 9,
    textBorderColor: p.panel,
    textBorderWidth: 2.4,
  };
}

/** 基础 option：轴、提示框、6 条空的系列模板。轴范围来自平滑后矩阵（C4）。 */
export function rotationBase(p: Palette, b: Bounds, rollW: number, lang: string): EChartsOption {
  const base = baseChart(p);
  return {
    ...base,
    animation: false, // C1
    grid: { left: 24, right: 30, top: 26, bottom: 34, containLabel: true },
    tooltip: {
      ...base.tooltip,
      trigger: "item",
      transitionDuration: 0,
      formatter: (params: unknown) => {
        const data = (params as { data?: {
          name?: string; idx?: number; dim?: boolean;
          ret?: number | null; breadth?: number | null; rank?: number | null; amt?: number | null;
        } })?.data;
        if (!data) return "";
        const title = `<div style="font-weight:600;margin-bottom:5px">${escapeHtml(data.name)}</div>`; // C6
        if (data.idx === undefined || data.idx === null || data.dim) return title;
        const row = (k: string, v: string) =>
          `<div style="display:flex;justify-content:space-between;gap:16px"><span>${k}</span><b>${v}</b></div>`;
        const rank = typeof data.rank === "number" && Number.isFinite(data.rank) ? `#${data.rank}` : "—";
        const amount =
          typeof data.amt === "number" && Number.isFinite(data.amt) ? money(data.amt, lang) : "—";
        return `<div style="min-width:200px">${title}${ // C7
          row(L(lang, `近 ${rollW} 条累计收益`, `Return · last ${rollW} observations`), finitePct(data.ret, 2)) +
          row(L(lang, `近 ${rollW} 条平均上涨占比`, `Avg breadth · last ${rollW} observations`), finitePct(data.breadth, 1)) +
          row(L(lang, "滚动排名", "Rolling rank"), rank) +
          row(L(lang, "当日成交额", "Turnover"), amount)
        }</div>`;
      },
    },
    xAxis: {
      type: "value",
      min: b.x0,
      max: b.x1,
      splitNumber: 6,
      ...axisStyle(p),
      name: L(lang, `近 ${rollW} 条累计等权收益 →`, `EW return · last ${rollW} obs. →`),
      nameLocation: "middle",
      nameGap: 22,
      nameTextStyle: { color: p.faint, fontSize: 10.5, fontFamily: "JetBrains Mono Variable, monospace" },
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
    },
    yAxis: {
      type: "value",
      min: b.y0,
      max: b.y1,
      splitNumber: 4,
      ...axisStyle(p),
      name: L(lang, `近 ${rollW} 条平均上涨占比`, `Avg breadth · last ${rollW} obs.`),
      nameLocation: "middle",
      nameGap: 46,
      nameRotate: 90,
      nameTextStyle: { color: p.faint, fontSize: 10.5, fontFamily: "JetBrains Mono Variable, monospace" },
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" },
    },
    series: [
      /* 0 轨迹实线（最近 N 日） */
      {
        name: L(lang, "轨迹", "Trail"),
        type: "line",
        data: [],
        showSymbol: false,
        silent: true,
        z: 4,
        smooth: 0,
        connectNulls: false,
        lineStyle: { color: p.text, width: 1.8, opacity: 0.62 },
      },
      /* 1 轨迹面包屑点 */
      { name: L(lang, "轨迹点", "Trail dots"), type: "scatter", data: [], silent: true, z: 5, symbolSize: 2 },
      /* 2 窗口起点残影 */
      {
        name: L(lang, "起点", "Start"),
        type: "scatter",
        data: [],
        silent: true,
        z: 4,
        symbolSize: 9,
        itemStyle: { color: "transparent", borderColor: p.text, borderWidth: 1.5, opacity: 0.7 },
      },
      /* 3 起点 → 当前位置的位移虚线 */
      {
        name: L(lang, "位移", "Displacement"),
        type: "line",
        data: [],
        silent: true,
        z: 4,
        symbol: "none",
        lineStyle: { color: p.text, width: 1, opacity: 0.28, type: "dashed" },
      },
      /* 4 行业气泡（主系列，hideOverlap 会吃掉选中标签，故选中另开一层） */
      {
        name: L(lang, "行业", "Sector"),
        type: "scatter",
        data: [],
        z: 6,
        cursor: "pointer",
        labelLayout: { hideOverlap: true },
        emphasis: { disabled: true },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          label: { show: false },
          data: [{ xAxis: 0 }, { yAxis: 50 }], // C9：象限线，颜色跟随 palette
        },
      },
      /* 5 选中气泡 + 药丸标签（C10） */
      {
        name: L(lang, "选中", "Selected"),
        type: "scatter",
        data: [],
        silent: true,
        z: 9,
        symbolSize: 4,
        itemStyle: { color: p.text, opacity: 0.95, borderWidth: 0 },
        labelLayout: { hideOverlap: false },
        label: {
          show: true,
          position: "right",
          distance: 9,
          fontSize: 11.5,
          fontWeight: 700,
          color: p.panel,
          backgroundColor: p.text,
          padding: [3, 7],
          borderRadius: 3,
        },
      },
    ],
  } as EChartsOption;
}

/** 每帧只回传 series（C2）。数据项里同时带显示坐标与原始值，tooltip 用原始值。 */
export function rotationFrame(p: Palette, d: RotationFrameData): EChartsOption["series"] {
  const focus = d.hover >= 0 ? d.hover : d.focus;
  // C3：轨迹、残影、位移线、气泡都来自同一份平滑后坐标。
  // null 保留为折线断点：跨缺失帧不画直线（P2b）。
  const trailLine = d.trail.line.map((pt) =>
    pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) ? [pt.x, pt.y] : null,
  );
  const trailDots = d.trail.dots
    .filter((dot) => Number.isFinite(dot.p.x) && Number.isFinite(dot.p.y))
    .map((dot, i, arr) => {
      const age = (i + 1) / Math.max(1, arr.length);
      return {
        value: [dot.p.x, dot.p.y],
        symbolSize: 1.4 + 4.8 * Math.pow(age, 1.7),
        itemStyle: { color: p.text, opacity: 0.03 + 0.9 * Math.pow(age, 2), borderWidth: 0 },
      };
    });
  const ghost = d.ghost && Number.isFinite(d.ghost.x) && Number.isFinite(d.ghost.y)
    ? [{ value: [d.ghost.x, d.ghost.y] }]
    : [];
  const displacement =
    d.displacementValid && d.ghost && d.current &&
    [d.ghost, d.current].every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))
      ? [[d.ghost.x, d.ghost.y], [d.current.x, d.current.y]]
      : [];
  const bubbles = d.bubbles.map((bubble, idx) => {
    const pt = bubble.coord;
    const isFocus = idx === focus;
    const isSelected = idx === d.focus;
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      // C7：缺值不画点，也不产生 NaN 坐标。
      return {
        name: bubble.name,
        value: [null, null],
        idx,
        dim: true,
        itemStyle: { opacity: 0 },
        label: { show: false },
      };
    }
    const weight = Number.isFinite(bubble.weight) ? Math.max(0, Math.min(1, bubble.weight)) : 0;
    return {
      name: bubble.name,
      idx,
      ret: bubble.ret,
      breadth: bubble.breadth,
      rank: bubble.rank,
      amt: bubble.amt,
      value: [pt.x, pt.y],
      symbol: bubble.amt == null ? "emptyDiamond" : "circle",
      symbolSize: bubble.amt == null ? 9 : Math.max(4, Math.sqrt(weight) * 28),
      itemStyle: {
        color: quadColor(p, pt),
        opacity: isFocus ? 1 : 0.45,
        borderColor: isFocus ? p.text : undefined,
        borderWidth: isFocus ? 2 : 0,
      },
      label: {
        ...haloLabel(p, bubble.name, !isFocus),
        show: !isSelected && d.labelIdx.has(idx),
      },
    };
  });
  const selected = d.current && Number.isFinite(d.current.x) && Number.isFinite(d.current.y)
    ? [{
        value: [d.current.x, d.current.y],
        label: { formatter: d.focusName, show: true },
      }]
    : [];
  const series = [
    { data: trailLine },
    { data: trailDots },
    { data: ghost },
    { data: displacement },
    { data: bubbles },
    { data: selected },
  ] as EChartsOption["series"];
  // W6-10：SERIES_COUNT 不再是死声明，长度不符直接暴露（只可能是代码改动导致的错位）。
  if (!Array.isArray(series) || series.length !== SERIES_COUNT) {
    throw new Error(`rotationFrame: expected ${SERIES_COUNT} series, got ${Array.isArray(series) ? series.length : "n/a"}`);
  }
  return series;
}
