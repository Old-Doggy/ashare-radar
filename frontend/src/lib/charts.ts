import type { EChartsOption } from "echarts";
import type { MarketDay, SectorDay } from "./api";
import { axisStyle, baseChart, type Palette } from "./theme";
import { money, shortDate } from "./format";
import { regimeOf, regimeLabel } from "./regime";
import { escapeHtml } from "./html";

const axisDate = (rows: MarketDay[]) => rows.map((r) => shortDate(r.trade_date));
const L = (lang: string, zh: string, en: string) => (lang === "en" ? en : zh);

/* -------------------------------------------------------------------------
 * 市场结构时间轴的缩放 / 平移
 *
 * 缩放状态是**非受控**的：只活在 ECharts 实例里，不进 React state。
 * EChart.tsx 用 notMerge 整份替换 option，所以任何一次父组件重渲染
 * （主题 / 语言 / 切换范围）都会把窗口复位到全览 —— 这是预期行为。
 *
 * filterMode 用 "filter"：窗口外数据被过滤，y 轴会跟着窗口自适应，
 * 放大后能真正看到细节。代价是被过滤后 dataIndex 不再指向原始数组，
 * 所以缩放模式的 x 轴存原始交易日、tooltip 用 axisValue 回查（见 rowByDate）；
 * 轴上的显示仍由 axisLabel.formatter 缩短为 MM/DD。
 * ---------------------------------------------------------------------- */
const MONO = "JetBrains Mono Variable, JetBrains Mono, monospace";

/** 是否给时间序列打开缩放 / 平移；pan=false 用于触屏（保留双指缩放，不劫持纵向滚动）。 */
export interface TimeZoom {
  pan?: boolean;
}

/** 网格底部留给滑杆的高度。 */
export const ZOOM_BOTTOM = 34;

/** 缩放模式下 x 轴存原始交易日，这里负责缩回 MM/DD。 */
export const axisDateLabel = (value: unknown): string => shortDate(String(value ?? ""));

/** tooltip 回查：缩放模式用 axisValue（原始日期）查，普通模式退回 dataIndex。 */
export function rowByDate<T>(arr: T[], params: unknown, field: keyof T): T | undefined {
  const first = (params as { dataIndex?: number; axisValue?: string }[] | undefined)?.[0];
  if (!first) return undefined;
  if (typeof first.axisValue === "string") {
    const hit = arr.find((item) => String(item[field]) === first.axisValue);
    if (hit) return hit;
  }
  return typeof first.dataIndex === "number" ? arr[first.dataIndex] : undefined;
}

/** 缩放模式下的坐标轴指示器文字（否则会显示完整的 2016-12-01）。 */
export const pointerDateLabel = { formatter: (params: { value?: unknown }) => axisDateLabel(params?.value) };

/**
 * inside（滚轮 / 双指缩放 + 拖拽平移）+ slider（底部缩略滑杆）联动。
 * points 为该 x 轴的类目数量，用来限制最小缩放跨度（至少约 12 个交易日）。
 */
export function timeZoom(
  p: Palette,
  points: number,
  xAxisIndex: number | number[],
  zoom: TimeZoom = {},
): NonNullable<EChartsOption["dataZoom"]> {
  const minSpan = Math.min(90, Math.max(0.8, (12 / Math.max(1, points)) * 100));
  const sliderStyle = {
    backgroundColor: p.panel2,
    borderColor: p.border,
    fillerColor: p.accentSoft,
    handleStyle: { color: p.accent, borderColor: p.bg, borderWidth: 1, shadowBlur: 0 },
    moveHandleStyle: { color: p.axis, opacity: 0.45 },
    moveHandleSize: 3,
    emphasis: {
      handleStyle: { color: p.accent, borderColor: p.border },
      moveHandleStyle: { color: p.accent, opacity: 0.8 },
      fillerColor: p.accentSoft,
    },
    dataBackground: {
      lineStyle: { color: p.faint, opacity: 0.5, width: 1 },
      areaStyle: { color: p.faint, opacity: 0.12 },
    },
    selectedDataBackground: {
      lineStyle: { color: p.muted, opacity: 0.55, width: 1 },
      areaStyle: { color: p.accent, opacity: 0.08 },
    },
    textStyle: { color: p.faint, fontSize: 9.5, fontFamily: MONO },
    handleLabel: { show: false },
    showDetail: false,
    brushSelect: false,
  };
  return [
    {
      type: "inside",
      xAxisIndex,
      filterMode: "filter",
      zoomOnMouseWheel: true,
      moveOnMouseMove: zoom.pan !== false,
      moveOnMouseWheel: false,
      // ECharts 只要开启了单指/鼠标拖拽就会在 touchmove 上 preventDefault（即便
      // moveOnMouseMove 为 false），触屏上会把页面纵向滚动一起吃掉。关闭平移时
      // 同步关掉 preventDefaultMouseMove，让页面能正常滚动；双指缩放仍然可用。
      preventDefaultMouseMove: zoom.pan !== false,
      throttle: 50,
      minSpan,
    },
    {
      type: "slider",
      xAxisIndex,
      filterMode: "filter",
      minSpan,
      height: 20,
      bottom: 2,
      left: 10,
      right: 12,
      showDataShadow: true,
      ...sliderStyle,
    },
  ];
}

/** 参与广度：近 N 日 breadth 面积 + 背离点 */
export function breadthArea(p: Palette, rows: MarketDay[]): EChartsOption {
  const x = axisDate(rows);
  const y = rows.map((r) => r.breadth == null ? null : +(r.breadth * 100).toFixed(1));
  const diverge = rows.map((r) =>
    r.ew_ret > 0 && r.breadth != null && r.breadth < 0.5 ? [shortDate(r.trade_date), +(r.breadth * 100).toFixed(1)] : null,
  );
  return {
    ...baseChart(p),
    grid: { left: 4, right: 4, top: 10, bottom: 20, containLabel: true },
    xAxis: {
      type: "category",
      data: x,
      boundaryGap: false,
      ...axisStyle(p),
      splitLine: { show: false },
      axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(x.length / 5)), fontSize: 11 },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: 100,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%", fontSize: 11 },
      splitLine: { show: false },
    },
    series: [
      {
        type: "line",
        data: y,
        showSymbol: false,
        smooth: 0.25,
        lineStyle: { width: 1.6, color: p.accent },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(217,164,65,.3)" },
              { offset: 1, color: "rgba(217,164,65,0)" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ yAxis: 50 }],
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          label: { show: false },
        },
      },
      {
        type: "scatter",
        data: diverge.filter(Boolean),
        symbolSize: 5,
        itemStyle: { color: p.up, borderColor: p.panel, borderWidth: 1 },
        z: 5,
      },
    ],
  };
}

/** 主图：上收益、下广度。传 zoom 打开滚轮缩放 / 拖拽平移 / 底部滑杆。 */
export function returnBreadth(p: Palette, rows: MarketDay[], lang: string, zoom?: TimeZoom): EChartsOption {
  // 缩放模式：x 轴保存完整交易日（tooltip 用 axisValue 回查），刻度文字再缩成 MM/DD
  const x = zoom ? rows.map((r) => r.trade_date) : axisDate(rows);
  const ew = rows.map((r) => +(r.ew_ret * 100).toFixed(2));
  const hs = rows.map((r) => (r.hs300_ret == null ? null : +(r.hs300_ret * 100).toFixed(2)));
  const cw = rows.map((r) => (r.cw_ret == null ? null : +(r.cw_ret * 100).toFixed(2)));
  const br = rows.map((r) => r.breadth == null ? null : +(r.breadth * 100).toFixed(1));

  return {
    ...baseChart(p),
    // 换范围时整份 option 重建（notMerge），入场动画稍长一点与图间交叉淡入配合
    // 关掉 ECharts 自带的系列入场动画：上下两个面板的系列类型不同（柱/线/面积），
      // 入场动画节奏不一致，换范围时会「先动上面再动下面」。这里交给旧图快照淡出 +
      // 自定义的 dataZoom 镜头补间，两个面板共用同一个窗口，天然同步。
      ...(zoom ? { animation: false } : {}),
    // 缩放视图给滑杆留位置：上面板略收，下面板抬到 66% 并留出底部空间
    grid: zoom
      ? [
          { left: 6, right: 10, top: 18, height: "47%", containLabel: true },
          { left: 6, right: 10, top: "66%", bottom: ZOOM_BOTTOM, containLabel: true },
        ]
      : [
          { left: 6, right: 10, top: 18, height: "52%", containLabel: true },
          { left: 6, right: 10, top: "73%", bottom: 6, containLabel: true },
        ],
    ...(zoom ? { dataZoom: timeZoom(p, x.length, [0, 1], zoom) } : {}),
    axisPointer: zoom
      ? { link: [{ xAxisIndex: [0, 1] }], label: pointerDateLabel }
      : { link: [{ xAxisIndex: [0, 1] }] },
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const r = rowByDate(rows, params, "trade_date");
        if (!r) return "";
        const breadth = r.breadth == null ? "—" : `${(r.breadth * 100).toFixed(1)}%`;
        const t = (k: string) => k;
        return `<div style="min-width:188px">
          <div style="font-family:'JetBrains Mono Variable',monospace;font-size:12px;color:${p.muted};margin-bottom:6px">${escapeHtml(r.trade_date)} · ${t(regimeLabel(regimeOf(r), lang))}</div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "等权收益", "Equal-weight")}</span><b style="color:${r.ew_ret >= 0 ? p.up : p.down}">${(r.ew_ret * 100).toFixed(2)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "沪深300", "CSI 300")}</span><b>${r.hs300_ret === null ? "—" : (r.hs300_ret * 100).toFixed(2) + "%"}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "上涨占比", "Breadth")}</span><b>${breadth}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "上涨/下跌", "Adv/Dec")}</span><b>${r.n_adv} / ${r.n_dec}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "Top10 波动占比", "Top10 absolute-move share")}</span><b>${r.top10_share == null ? "—" : (r.top10_share * 100).toFixed(0) + "%"}</b></div>
        </div>`;
      },
    },
    xAxis: [
      {
        type: "category",
        data: x,
        gridIndex: 0,
        ...axisStyle(p),
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: "category",
        data: x,
        gridIndex: 1,
        ...axisStyle(p),
        splitLine: { show: false },
        axisLabel: {
          ...axisStyle(p).axisLabel,
          fontSize: 11,
          // 缩放后刻度由 ECharts 按可视窗口自动重算；静态 interval 在放大后会空白
          ...(zoom
            ? { interval: "auto" as const, formatter: axisDateLabel }
            : { interval: Math.max(0, Math.floor(x.length / 8)) }),
          hideOverlap: true,
        },
      },
    ],
    yAxis: [
      {
        type: "value",
        gridIndex: 0,
        ...axisStyle(p),
        axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%", fontSize: 11 },
        splitNumber: 3,
      },
      {
        type: "value",
        gridIndex: 1,
        min: 0,
        max: 100,
        ...axisStyle(p),
        axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%", fontSize: 11 },
        splitNumber: 2,
      },
    ],
    series: [
      {
        name: L(lang, "等权收益", "Equal-weight"),
        type: "bar",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: ew,
        barWidth: "62%",
        itemStyle: {
          color: (params: any) => (Number(params.value) >= 0 ? p.up : p.down),
          borderRadius: 2,
          opacity: 0.85,
        },
      },
      {
        name: L(lang, "流通市值加权", "Float-cap weighted"),
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: cw,
        showSymbol: false,
        smooth: 0.2,
        // ALL（2,424 点）下折线采样能显著降低缩放重绘成本，视觉上基本无差
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { width: 1, color: p.faint, type: "dotted" },
      },
      {
        name: L(lang, "沪深300", "CSI 300"),
        type: "line",
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: hs,
        showSymbol: false,
        smooth: 0.2,
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { width: 1.2, color: p.text2, opacity: 0.75 },
      },
      {
        name: L(lang, "上涨占比", "Breadth"),
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: br,
        showSymbol: false,
        smooth: 0.25,
        ...(zoom ? { sampling: "lttb" as const } : {}),
        lineStyle: { width: 1.5, color: p.accent },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: "rgba(217,164,65,.24)" },
              { offset: 1, color: "rgba(217,164,65,0)" },
            ],
          },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ yAxis: 50 }],
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          label: { show: false },
        },
      },
    ],
  };
}

/** 行业气泡：收益 × 广度 × 成交额 × 内部分化 */
export function sectorBubble(p: Palette, sectors: SectorDay[], lang: string, selected?: string | null): EChartsOption {
  const maxAmt = Math.max(...sectors.map((s) => s.amount || 0), 1);
  const sorted = [...sectors].sort((a, b) => b.ew_ret - a.ew_ret);
  const labelSet = new Set([
    sorted[0]?.sw_l1,
    sorted[1]?.sw_l1,
    sorted[2]?.sw_l1,
    sorted[sorted.length - 1]?.sw_l1,
    sorted[sorted.length - 2]?.sw_l1,
    selected,
  ].filter(Boolean) as string[]);

  const quadColor = (s: SectorDay) => {
    if (s.ew_ret > 0 && s.breadth >= 0.5) return p.up;
    if (s.ew_ret > 0 && s.breadth < 0.5) return p.copper;
    if (s.ew_ret < 0 && s.breadth < 0.5) return p.down;
    return p.muted;
  };

  const pts = sectors.filter((s) => s.breadth != null && Number.isFinite(s.breadth)).map((s) => {
    const isSel = selected === s.sw_l1;
    return {
      name: s.sw_l1,
      value: [s.ew_ret * 100, s.breadth * 100, s.amount || 0, s.n, s.iqr * 100],
      itemStyle: {
        color: quadColor(s),
        borderColor: isSel ? p.text : "transparent",
        borderWidth: isSel ? 2 : 0,
      },
    };
  });
  const xs = pts.map((p2) => p2.value[0]);
  const xmin = Math.min(...xs, -1);
  const xmax = Math.max(...xs, 1);
  const pad = (xmax - xmin) * 0.1 + 0.25;
  const x0 = +(xmin - pad).toFixed(1);
  const x1 = +(xmax + pad).toFixed(1);

  const quad = (xa: number, xb: number, ya: number, yb: number, color: string) => [
    { xAxis: xa, yAxis: ya, itemStyle: { color }, label: { show: false } },
    { xAxis: xb, yAxis: yb, itemStyle: { color } },
  ];

  return {
    ...baseChart(p),
    grid: { left: 8, right: 18, top: 20, bottom: 24, containLabel: true },
    graphic: [
      { type: "text", left: "7%", top: 26, style: { text: L(lang, "结构分化", "Divergent"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", right: "4%", top: 26, style: { text: L(lang, "普涨", "Broad rally"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", left: "7%", bottom: 44, style: { text: L(lang, "普跌", "Broad selloff"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
      { type: "text", right: "4%", bottom: 44, style: { text: L(lang, "集中上涨", "Narrow rally"), fill: p.faint, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
    ],
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { data: { name: string; value: number[] } };
        const [ret, breadth, amt, n, iqr] = q.data.value;
        return `<div style="min-width:158px">
          <div style="font-weight:600;margin-bottom:6px">${escapeHtml(q.data.name)}</div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "行业收益", "Return")}</span><b style="color:${ret >= 0 ? p.up : p.down}">${ret.toFixed(2)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "上涨占比", "Breadth")}</span><b>${breadth.toFixed(0)}%</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "内部分化", "IQR")}</span><b>${iqr.toFixed(2)}pp</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "成交额", "Turnover")}</span><b>${money(amt, lang)}</b></div>
          <div style="display:flex;justify-content:space-between;gap:14px"><span>${L(lang, "成分股", "Constituents")}</span><b>${n}</b></div>
        </div>`;
      },
    },
    xAxis: {
      type: "value",
      min: x0,
      max: x1,
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
        type: "scatter",
        data: pts,
        cursor: "pointer",
        symbolSize: (val: number[]) => 8 + Math.sqrt((val[2] || 0) / maxAmt) * 24,
        itemStyle: { opacity: 0.82, borderColor: p.panel, borderWidth: 1 },
        emphasis: { itemStyle: { opacity: 1, borderColor: p.text, borderWidth: 1 }, scale: 1.12 },
        label: {
          show: true,
          formatter: (params: any) => (labelSet.has(params?.data?.name) ? params.data.name : ""),
          position: "top",
          distance: 5,
          color: p.text2,
          fontSize: 11,
        },
        labelLayout: { hideOverlap: true, moveOverlap: "shiftY" },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          data: [{ xAxis: 0 }, { yAxis: 50 }],
          label: { show: false },
        },
        markArea: {
          silent: true,
          data: [
            quad(0, x1, 50, 100, `${p.accent}03`),
            quad(0, x1, 0, 50, `${p.copper}03`),
            quad(x0, 0, 50, 100, `${p.muted}02`),
            quad(x0, 0, 0, 50, `${p.down}03`),
          ] as any,
        },
      },
    ],
  };
}

/** 收益分布直方图 */
export function distributionChart(
  p: Palette,
  bins: { b: number; n: number; lo: number; hi: number }[],
  stats: { med: number | null; p25?: number | null; p75?: number | null; n: number },
  lang: string,
): EChartsOption {
  const N = 44;
  const lo = -0.11;
  const hi = 0.11;
  const step = (hi - lo) / N;
  const counts = new Array(N).fill(0) as number[];
  bins.forEach((x) => {
    const i = Math.min(N - 1, Math.max(0, x.b));
    counts[i] += x.n;
  });
  const centers = Array.from({ length: N }, (_, i) => ((lo + (i + 0.5) * step) * 100));
  const omitted = Math.max(0, stats.n - counts.reduce((sum, n) => sum + n, 0));
  const data = counts.map((n, i) => ({
    value: [centers[i], n],
    itemStyle: {
      color: centers[i] >= 0 ? p.up : p.down,
      opacity: 0.78,
      borderRadius: 1.5,
    },
  }));

  return {
    ...baseChart(p),
    grid: { left: 6, right: 10, top: 16, bottom: 38, containLabel: true },
    graphic: [{ type: "text", right: 12, top: 0, style: {
      text: L(lang, `±11%外未绘制 ${omitted} 只`, `${omitted} stocks outside ±11% omitted`),
      fill: p.muted, fontSize: 10,
    } }],
    tooltip: {
      ...baseChart(p).tooltip,
      formatter: (params: unknown) => {
        const q = params as { data: { value: [number, number] } };
        const [c, n] = q.data.value;
        return `<div style="font-family:monospace">${(c - step * 50).toFixed(2)}% – ${(c + step * 50).toFixed(2)}% · ${n} ${lang === "en" ? "stocks" : "只"}</div>`;
      },
    },
    xAxis: {
      type: "value",
      min: -11,
      max: 11,
      splitNumber: 6,
      ...axisStyle(p),
      name: L(lang, "个股收益", "Return"),
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: { color: p.muted, fontSize: 11 },
      axisLine: { show: true, lineStyle: { color: p.axis } },
      axisTick: { show: true, lineStyle: { color: p.axis } },
      splitLine: { show: false },
      axisLabel: {
        ...axisStyle(p).axisLabel,
        formatter: "{value}%",
        fontSize: 11.5,
        hideOverlap: true,
        showMinLabel: false,
        showMaxLabel: false,
      },
    },
    yAxis: {
      type: "value",
      ...axisStyle(p),
      axisLine: { show: true, lineStyle: { color: p.axis } },
      axisLabel: { ...axisStyle(p).axisLabel, fontSize: 11 },
      splitLine: { lineStyle: { color: p.grid } },
    },
    series: [
      {
        type: "bar",
        data,
        barWidth: 10,
        markLine: stats.med == null ? undefined : {
          silent: true,
          symbol: "none",
          data: [{ xAxis: +(stats.med * 100).toFixed(2) }],
          lineStyle: { color: p.text2, width: 1, type: "dashed" },
          label: {
            show: true,
            formatter: lang === "en" ? "median" : "中位数",
            color: p.muted,
            fontSize: 11,
            position: "end",
          },
        },
        markArea: {
          silent: true,
          itemStyle: { color: "transparent" },
          data: [[{ xAxis: 0 }, { xAxis: 11 }]],
        },
      },
    ],
  };
}
