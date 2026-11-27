import type { EChartsOption } from "echarts";
import type { RotationDay, SectorRank } from "./api";
import { axisStyle, baseChart, type Palette, seriesColors } from "./theme";
import { shortDate } from "./format";
import { cumulativeReturns, escapeHtml } from "./html";

const L = (lang: string, zh: string, en: string) => (lang === "en" ? en : zh);

/** 行业排名迁移（bump chart）：20 日收益排名，按周采样。 */
export function rotationBump(
  p: Palette,
  ranks: SectorRank[],
  lang: string,
  selected?: string | null,
  topN = 6,
): EChartsOption {
  const datesAll = [...new Set(ranks.map((r) => r.trade_date))].sort();
  const recent = datesAll.slice(-130);
  const dates = recent.filter((_, i) => i % 5 === 0 || i === recent.length - 1);
  const bySector = new Map<string, Map<string, number>>();
  ranks.forEach((r) => {
    if (!bySector.has(r.sw_l1)) bySector.set(r.sw_l1, new Map());
    bySector.get(r.sw_l1)!.set(r.trade_date, r.rank20);
  });
  const stats = [...bySector.entries()].map(([name, m]) => {
    const vals = dates.map((d) => m.get(d)).filter((v): v is number => v != null);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 99;
    const range = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
    return { name, avg, range };
  });
  const stable = [...stats].sort((a, b) => a.avg - b.avg).slice(0, 3).map((s) => s.name);
  const movers = [...stats].sort((a, b) => b.range - a.range).slice(0, 2).map((s) => s.name);
  const picked = [...new Set([...stable, ...movers])].slice(0, topN);
  if (selected && !picked.includes(selected)) {
    if (picked.length) picked[picked.length - 1] = selected;
    else picked.push(selected);
  }

  return {
    ...baseChart(p),
    grid: { left: 8, right: 58, top: 14, bottom: 52, containLabel: true },
    legend: {
      show: true,
      bottom: 0,
      left: 8,
      right: 8,
      icon: "circle",
      itemWidth: 6,
      itemHeight: 6,
      itemGap: 10,
      textStyle: { color: p.muted, fontSize: 11 },
      data: picked,
    },
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const arr = params as { dataIndex: number; seriesName: string; value: number | null }[];
        const date = dates[arr[0]?.dataIndex ?? 0] ?? "";
        const rows = [...arr]
          .filter((a) => a.value != null)
          .sort((a, b) => Number(a.value) - Number(b.value))
          .map(
            (a) =>
              `<div style="display:flex;justify-content:space-between;gap:14px"><span>${escapeHtml(a.seriesName)}</span><b>#${a.value}</b></div>`,
          )
          .join("");
        return `<div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:4px">${escapeHtml(shortDate(date))}</div>${rows}`;
      },
    },
    xAxis: {
      type: "category",
      data: dates.map(shortDate),
      boundaryGap: false,
      ...axisStyle(p),
      splitLine: { show: false },
      axisLabel: {
        ...axisStyle(p).axisLabel,
        fontSize: 11,
        hideOverlap: true,
        interval: Math.max(1, Math.floor(dates.length / 5)),
      },
    },
    yAxis: {
      type: "value",
      inverse: true,
      min: 1,
      max: Math.max(1, bySector.size),
      interval: 5,
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, fontSize: 11, formatter: "#{value}" },
      splitLine: { lineStyle: { color: p.grid } },
    },
    series: picked.map((name, i) => {
      const isSel = name === selected;
      const hasSelection = !!selected;
      const color = isSel ? p.copper : seriesColors(p)[i % seriesColors(p).length];
      return {
        name,
        type: "line" as const,
        data: dates.map((d) => bySector.get(name)?.get(d) ?? null),
        showSymbol: true,
        symbol: "circle",
        symbolSize: isSel ? 4.5 : hasSelection ? 3.4 : 3,
        smooth: 0.12,
        connectNulls: false,
        lineStyle: {
          width: isSel ? 2.8 : hasSelection ? 1.8 : 1.7,
          color,
          opacity: isSel ? 1 : hasSelection ? 0.42 : 0.82,
        },
        itemStyle: { color, opacity: isSel ? 1 : hasSelection ? 0.46 : 1 },
        triggerEvent: true,
        endLabel: {
          show: isSel,
          formatter: name,
          color,
          fontSize: 11,
          fontWeight: 600,
          distance: 6,
        },
        emphasis: {
          focus: "series",
          lineStyle: { width: 2.8, opacity: 1 },
          itemStyle: { opacity: 1, borderColor: p.text, borderWidth: 1 },
          label: { show: true },
        },
        blur: {
          lineStyle: { opacity: 0.06 },
          itemStyle: { opacity: 0.06 },
          label: { show: false },
        },
        label: {
          show: false,
          position: "top",
          distance: 3,
          color,
          fontSize: 9.5,
          formatter: (q: any) => {
            const i = Number(q.dataIndex);
            return i % 4 === 0 || i === dates.length - 1 ? `#${q.value}` : "";
          },
        },
        z: isSel ? 5 : 2,
      };
    }),
  };
}

/** 轮动强度：月度平均排名变化，柱状呈现。 */
export function rotationPulse(p: Palette, rows: RotationDay[], lang: string): EChartsOption {
  const groups = new Map<string, { sum: number; n: number }>();
  rows.forEach((r) => {
    const m = r.trade_date.slice(0, 7);
    const g = groups.get(m) || { sum: 0, n: 0 };
    g.sum += r.rotation_intensity;
    g.n += 1;
    groups.set(m, g);
  });
  const all = [...groups.entries()].map(([month, g]) => ({ month, value: g.sum / Math.max(1, g.n), n: g.n })).sort((a, b) => a.month.localeCompare(b.month));
  const data = all.slice(-12);
  const avg = data.reduce((a, x) => a + x.value, 0) / Math.max(1, data.length);
  const max = Math.max(...data.map((x) => x.value), avg, 1);

  return {
    ...baseChart(p),
    grid: { left: 8, right: 12, top: 18, bottom: 24, containLabel: true },
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const arr = params as { dataIndex: number }[];
        const x = data[arr[0]?.dataIndex ?? 0];
        if (!x) return "";
        return `<div style="font-family:monospace;font-size:12px;color:${p.muted}">${escapeHtml(x.month)}</div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "月均轮动", "Monthly avg")}</span><b>${x.value.toFixed(2)}</b></div>
          <div style="display:flex;justify-content:space-between;gap:16px"><span>${L(lang, "交易日", "Sessions")}</span><b>${x.n}</b></div>`;
      },
    },
    xAxis: {
      type: "category",
      data: data.map((x) => x.month.slice(2)),
      ...axisStyle(p),
      splitLine: { show: false },
      axisLabel: {
        ...axisStyle(p).axisLabel,
        fontSize: 11,
        hideOverlap: true,
        interval: (i: number) => i % 4 === 0 || i === data.length - 1,
      },
    },
    yAxis: {
      type: "value",
      min: 0,
      // W6-06：toFixed(1) 可能向下取整把最高柱裁掉，这里统一留 5% headroom。
      max: Number((max * 1.05).toFixed(1)),
      ...axisStyle(p),
      axisLabel: { ...axisStyle(p).axisLabel, fontSize: 11 },
      splitNumber: 3,
    },
    series: [
      {
        type: "bar",
        data: data.map((x, i) => ({
          value: +x.value.toFixed(2),
          itemStyle: {
            color: i === data.length - 1 ? p.copper : p.accent,
            opacity: i === data.length - 1 ? 0.95 : 0.92,
            borderRadius: [2, 2, 0, 0],
          },
        })),
        barWidth: "52%",
        label: {
          show: false,
          position: "top",
          formatter: (q: any) => Number(q.value).toFixed(2),
          color: p.text2,
          fontSize: 11,
        },
        emphasis: {
          itemStyle: { opacity: 1, borderColor: p.text, borderWidth: 1 },
          label: { show: true },
        },
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ yAxis: +avg.toFixed(2) }],
          lineStyle: { color: p.axis, type: "dashed", width: 1 },
          label: { show: false },
        },
      },
    ],
  };
}

/** 行业月度累计收益曲线：一组行业，一条线一个行业。 */
export function monthlyPathChart(
  p: Palette,
  months: string[],
  series: { name: string; values: (number | null)[] }[],
  lang: string,
): EChartsOption {
  const colors = seriesColors(p);
  const paths = series.map((s) => cumulativeReturns(s.values).map((v) => v == null ? null : +(v * 100).toFixed(2)));
  return {
    ...baseChart(p),
    grid: { left: 8, right: 12, top: 44, bottom: 34, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      type: "scroll",
      icon: "roundRect",
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 10,
      textStyle: { color: p.muted, fontSize: 10.5 },
      pageIconColor: p.accent,
      pageIconInactiveColor: p.faint,
      pageTextStyle: { color: p.faint, fontSize: 10 },
      data: series.map((s) => s.name),
    },
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      formatter: (params: unknown) => {
        const arr = params as { dataIndex: number; seriesName: string; value: number; color: string }[];
        const i = arr?.[0]?.dataIndex ?? 0;
        return `<div style="min-width:150px"><div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:5px">${escapeHtml(months[i])}</div>${arr
          .map(
            (x) =>
              `<div style="display:flex;justify-content:space-between;gap:16px"><span>${escapeHtml(x.seriesName)}</span><b>${x.value == null ? "—" : Number(x.value).toFixed(2) + "%"}</b></div>`,
          )
          .join("")}</div>`;
      },
    },
    xAxis: {
      type: "category",
      data: months.map((m) => m.slice(2, 7)),
      ...axisStyle(p),
      name: L(lang, "月份", "Month"),
      nameLocation: "middle",
      nameGap: 24,
      nameTextStyle: { color: p.muted, fontSize: 10.5 },
      splitLine: { show: false },
      axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(months.length / 6)), fontSize: 11 },
    },
    yAxis: {
      type: "value",
      scale: true,
      ...axisStyle(p),
      name: L(lang, "累计收益", "Cumulative"),
      nameLocation: "end",
      nameGap: 8,
      nameTextStyle: { color: p.muted, fontSize: 10.5 },
      axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%", fontSize: 11 },
      splitNumber: 3,
    },
    series: series.map((s, i) => ({
      name: s.name,
      type: "line",
      data: paths[i],
      showSymbol: false,
      smooth: 0.2,
      lineStyle: { width: 1.9, color: colors[i % colors.length] },
      itemStyle: { color: colors[i % colors.length] },
      emphasis: { focus: "series" },
      blur: { lineStyle: { opacity: 0.12 }, itemStyle: { opacity: 0.12 } },
      markLine:
        i === 0
          ? {
              silent: true,
              symbol: "none",
              data: [{ yAxis: 0 }],
              lineStyle: { color: p.axis, width: 1, type: "dashed" },
              label: { show: false },
            }
          : undefined,
    })),
  };
}

/* ===== 个股页（Stocks）图表数据：K 线前复权 / 市值散点轴域 ===== */

/** 个股序列的两种输入：新契约对象（带 adj_factor/close_raw）或旧/新 payload 元组。
 *  - 新 payload 元组：[date, o, h, l, c, vol, adj_factor]，其中 OHLC 已按窗口最后 adj_factor 归一（前复权）；
 *  - 旧 payload 元组：[date, o, h, l, c, vol]，未复权、无法还原复权价（缺少 adj_factor）。 */
export interface KlinePoint {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  adj_factor?: number | null;
  close_raw?: number | null;
  /** api.ts 归一后的显式复权标记（D3 契约）：旧 6 元组静态包为 "none"。 */
  adjust?: "qfq" | "none";
}

export type KlineTuple = readonly (string | number | null | undefined)[];

export interface KlineBar {
  trade_date: string;
  /** 前复权 OHLC（新契约 payload/API 直接给复权价；旧 6 元组为原始价） */
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  /** 原始（未复权）收盘价，tooltip 展示用；无法还原时等于 close */
  closeRaw: number;
  adj: number | null;
}

export interface KlineModel {
  bars: KlineBar[];
  /** 序列是否前复权（有 adj_factor 即视为新契约 qfq 序列） */
  adjusted: boolean;
  /** 最后一条观察的 adj_factor（窗口归一基准） */
  lastAdj: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** 兼容对象与元组两种输入，产出 K 线绘制用的前复权 bar（P1-6 / W9-02）。
 *
 *  契约（修复计划 §2.5 / §3）：stock_series 与 `/api/stock/<code>` 的 OHLC 已前复权，
 *  `adj_factor` 只作为“这是复权序列”的标记与原始收盘还原基准。
 *  旧 6 元组 payload 没有 adj_factor → `adjusted=false`，页面需标注“未复权”。
 */
export function klineSeriesModel(input: readonly (KlinePoint | KlineTuple)[]): KlineModel {
  const rows: { date: string; o: number; h: number; l: number; c: number; v: number; adj: number | null; raw: number | null; flag: "qfq" | "none" | null }[] = [];
  for (const item of input) {
    if (Array.isArray(item)) {
      const tuple = item as KlineTuple;
      const [d, o, h, l, c, v] = tuple;
      const [oo, hh, ll, cc, vv] = [o, h, l, c, v].map(num);
      if (typeof d !== "string" || [oo, hh, ll, cc, vv].some((x) => x === null)) continue;
      const adj = tuple.length >= 7 ? num(tuple[6]) : null;
      rows.push({ date: d, o: oo!, h: hh!, l: ll!, c: cc!, v: vv!, adj, raw: null, flag: null });
    } else {
      const point = item as KlinePoint;
      const [oo, hh, ll, cc, vv] = [point.open, point.high, point.low, point.close, point.vol].map(num);
      if (!point.trade_date || [oo, hh, ll, cc, vv].some((x) => x === null)) continue;
      rows.push({
        date: point.trade_date,
        o: oo!, h: hh!, l: ll!, c: cc!, v: vv!,
        adj: num(point.adj_factor),
        raw: num(point.close_raw),
        flag: point.adjust === "qfq" || point.adjust === "none" ? point.adjust : null,
      });
    }
  }
  const lastAdj = [...rows].reverse().find((r) => r.adj !== null)?.adj ?? null;
  // 显式 adjust 标记优先（api.ts 归一后的结构）；否则以 adj_factor 是否存在判断（元组契约）。
  // 旧 6 元组静态包没有 adj_factor → 未复权；不能因为 close_raw == close 就误判为 qfq。
  const explicit = rows.find((r) => r.flag !== null)?.flag ?? null;
  const adjusted = explicit === "qfq" || (explicit === null && rows.some((r) => r.adj !== null));
  const bars: KlineBar[] = rows.map((r) => {
    let closeRaw = r.raw;
    if (closeRaw === null && adjusted && r.adj !== null && lastAdj !== null && r.adj > 0 && lastAdj > 0) {
      // 前复权: c_adj = c_raw * adj / last_adj → c_raw = c_adj * last_adj / adj
      closeRaw = (r.c * lastAdj) / r.adj;
    }
    return {
      trade_date: r.date,
      open: r.o, high: r.h, low: r.l, close: r.c, vol: r.v,
      closeRaw: closeRaw ?? r.c,
      adj: r.adj,
    };
  });
  return { bars, adjusted, lastAdj };
}

/** 市值散点 x 轴域（W9-01）：x = log10(流通市值/亿元)，按数据上下界自适应，
 *  不再硬编码 [0,4] 把万亿市值股裁掉；上界额外留白并保证 >= 4。 */
export function logCapDomain(values: readonly (number | null | undefined)[]): { min: number; max: number } {
  const vals = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return { min: 0, max: 4 };
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals);
  const pad = Math.max(0.15, (hi - lo) * 0.04);
  const min = Math.floor(lo * 10) / 10;
  const max = Math.ceil((hi + pad) * 10) / 10;
  return { min: Number(min.toFixed(2)), max: Number(Math.max(max, min + 0.5).toFixed(2)) };
}

/** 散点降采样（W9-01 根因之二）：等距抽样会把极端市值点整个丢掉——
 *  当前 payload 里 5 只万亿市值股都不在 746 个抽样点内，即使轴域自适应也看不到。
 *  这里在等距抽样之外强制保留市值最大的 top 个点，保证轴域与可见点一致。 */
export function scatterSample<T extends { ts_code: string; circ_mv?: number | null }>(
  rows: readonly T[],
  target = 800,
  forceTop = 8,
): T[] {
  if (!rows.length) return [];
  const step = Math.max(1, Math.ceil(rows.length / Math.max(1, target)));
  const sampled = rows.filter((_, i) => i % step === 0);
  const seen = new Set(sampled.map((r) => r.ts_code));
  const forced = rows
    .filter((r) => typeof r.circ_mv === "number" && Number.isFinite(r.circ_mv) && r.circ_mv > 0)
    .slice()
    .sort((a, b) => (b.circ_mv as number) - (a.circ_mv as number))
    .slice(0, Math.max(0, forceTop))
    .filter((r) => !seen.has(r.ts_code));
  return forced.length ? [...sampled, ...forced] : sampled;
}

/** 个股 K 线：前复权蜡烛 + 成交量。tooltip 同时给出原始收盘与真实当日涨跌（P1-6 / W9-02）。 */
export function klineOption(p: Palette, model: KlineModel, lang = "zh"): EChartsOption {
  const bars = model.bars;
  const dates = bars.map((b) => shortDate(b.trade_date));
  const label = (zh: string, en: string) => L(lang, zh, en);
  const ohlc = bars.map((b) => ({ value: [b.open, b.close, b.low, b.high] }));
  const vols = bars.map((b) => ({
    value: b.vol,
    itemStyle: { color: b.close >= b.open ? p.up : p.down, opacity: 0.55 },
  }));
  return {
    ...baseChart(p),
    grid: [
      { left: 4, right: 6, top: 6, height: "60%", containLabel: true },
      { left: 4, right: 6, top: "72%", height: "16%", containLabel: true },
    ],
    tooltip: {
      ...baseChart(p).tooltip,
      trigger: "axis",
      axisPointer: { type: "cross" },
      formatter: (params: unknown) => {
        const arr = params as { dataIndex?: number }[];
        const i = arr?.[0]?.dataIndex ?? 0;
        const bar = bars[i];
        if (!bar) return "";
        const prev = bars[i - 1];
        const rawRet = prev && prev.closeRaw > 0 ? bar.closeRaw / prev.closeRaw - 1 : null;
        const tone = rawRet == null ? "" : rawRet >= 0 ? p.up : p.down;
        const row = (k: string, v: string) =>
          `<div style="display:flex;justify-content:space-between;gap:16px"><span>${k}</span><b>${v}</b></div>`;
        const adjNote = model.adjusted
          ? `<span style="color:${p.faint};font-size:10px">${label("前复权", "qfq")}</span>`
          : `<span style="color:${p.warn};font-size:10px">${label("未复权", "unadjusted")}</span>`;
        const rawLine = model.adjusted
          ? row(label("原始收盘", "Raw close"), `${bar.closeRaw.toFixed(2)}`)
          : "";
        const retLine = rawRet == null
          ? ""
          : `<div style="display:flex;justify-content:space-between;gap:16px"><span>${label("当日涨跌", "Return")}</span><b style="color:${tone}">${(rawRet * 100).toFixed(2)}%</b></div>`;
        return `<div style="min-width:168px">
          <div style="font-weight:600;margin-bottom:4px">${escapeHtml(bar.trade_date)} ${adjNote}</div>
          ${row(label("开盘", "Open"), bar.open.toFixed(2))}
          ${row(label("最高", "High"), bar.high.toFixed(2))}
          ${row(label("最低", "Low"), bar.low.toFixed(2))}
          ${row(label("收盘", "Close"), bar.close.toFixed(2))}
          ${rawLine}${retLine}
          ${row(label("成交量", "Volume"), bar.vol.toLocaleString("en-US"))}
        </div>`;
      },
    },
    xAxis: [
      {
        type: "category",
        data: dates,
        gridIndex: 0,
        ...axisStyle(p),
        axisLabel: { show: false },
        splitLine: { show: false },
      },
      {
        type: "category",
        data: dates,
        gridIndex: 1,
        ...axisStyle(p),
        splitLine: { show: false },
        axisLabel: { ...axisStyle(p).axisLabel, fontSize: 11, interval: Math.max(0, Math.floor(dates.length / 4)) },
      },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, fontSize: 11 } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    series: [
      {
        type: "candlestick",
        data: ohlc,
        itemStyle: { color: p.up, color0: p.down, borderColor: p.up, borderColor0: p.down },
      },
      { type: "bar", xAxisIndex: 1, yAxisIndex: 1, data: vols, barWidth: "62%" },
    ],
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1], start: 55, end: 100 }],
  } as EChartsOption;
}
