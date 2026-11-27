import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useUI } from "../store/ui";
import { axisStyle, baseChart, paletteFor, symmetricDomain } from "../lib/theme";
import { money, num, pct, ratio, shortDate } from "../lib/format";
import { escapeHtml } from "../lib/html";
import { DataState } from "../components/DataState";
import EChart from "../components/EChart";
import { Card } from "../components/Card";
import { PageHead } from "../components/PageHead";
import { Kpi } from "../components/Kpi";
import { limitQualityChart } from "../lib/charts4";

export default function Sentiment() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const zh = lang === "zh";
  const { theme, colorblind } = useUI();
  const p = paletteFor(theme, colorblind);

  const { data, isError, isPending } = useQuery({ queryKey: ["market-all"], queryFn: () => api.marketSeries() });
  const { data: limitQ } = useQuery({ queryKey: ["limit-quality"], queryFn: api.limitQuality });
  const all = data ?? [];
  const rows = useMemo(() => all.slice(-120), [all]);
  const last = rows[rows.length - 1];
  const x = rows.map((r) => shortDate(r.trade_date));

  const limitOption = useMemo(() => {
    if (!rows.length) return {} as never;
    return {
      ...baseChart(p),
      grid: [
        { left: 8, right: 10, top: 26, height: "46%", containLabel: true },
        { left: 8, right: 10, top: "76%", bottom: 18, containLabel: true },
      ],
      axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
      graphic: [
        { type: "text", left: 8, top: 2, style: { text: zh ? "涨停 / 跌停（家数）" : "Limit-ups / downs (count)", fill: p.muted, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
        { type: "text", left: 8, top: "64%", style: { text: zh ? "上涨占比" : "Breadth", fill: p.muted, fontSize: 11, fontFamily: "JetBrains Mono Variable, monospace" } },
        { type: "line", left: 8, right: 10, top: "62%", style: { stroke: p.border, lineWidth: 1 } },
      ],
      tooltip: {
        ...baseChart(p).tooltip,
        trigger: "axis",
        // W9-10：跌停系列画成负值（便于上下分列），但 tooltip 必须显示绝对值，不能出现「跌停 -4」。
        formatter: (params: unknown) => {
          const first = (params as { dataIndex: number }[])?.[0];
          const r = first ? rows[first.dataIndex] : undefined;
          if (!r) return "";
          const row = (label: string, value: string) =>
            `<div style="display:flex;justify-content:space-between;gap:18px"><span>${label}</span><b>${value}</b></div>`;
          return `<div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:5px">${escapeHtml(r.trade_date)}</div>${
            row(zh ? "涨停" : "Limit-up", `${r.limit_up_n == null ? "—" : num(r.limit_up_n)} ${zh ? "家" : ""}`) +
            row(zh ? "跌停" : "Limit-down", `${r.limit_down_n == null ? "—" : num(Math.abs(r.limit_down_n))} ${zh ? "家" : ""}`) +
            row(zh ? "上涨占比" : "Breadth", ratio(r.breadth, 0))
          }`;
        },
      },
      xAxis: [
        { type: "category", data: x, gridIndex: 0, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(x.length / 6)), fontSize: 11 }, splitLine: { show: false } },
        { type: "category", data: x, gridIndex: 1, ...axisStyle(p), name: zh ? "交易日期" : "Date", nameLocation: "middle", nameGap: 20, nameTextStyle: { color: p.muted, fontSize: 11 }, splitLine: { show: false }, axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(x.length / 6)), fontSize: 11 } },
      ],
      yAxis: [
        { type: "value", gridIndex: 0, ...axisStyle(p), splitNumber: 3 },
        { type: "value", gridIndex: 1, min: 0, max: 100, ...axisStyle(p), axisLabel: { ...axisStyle(p).axisLabel, formatter: "{value}%" }, splitNumber: 1 },
      ],
      series: [
        {
          name: zh ? "涨停" : "Limit-up",
          type: "bar",
          data: rows.map((r) => r.limit_up_n),
          itemStyle: { color: p.up, opacity: 0.8, borderRadius: [2, 2, 0, 0] },
          barWidth: "52%",
        },
        {
          name: zh ? "跌停" : "Limit-down",
          type: "bar",
          data: rows.map((r) => r.limit_down_n == null ? null : -r.limit_down_n),
          itemStyle: { color: p.down, opacity: 0.8, borderRadius: [0, 0, 2, 2] },
          barWidth: "52%",
        },
        {
          name: zh ? "上涨占比" : "Breadth",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rows.map((r) => r.breadth == null ? null : +(r.breadth * 100).toFixed(1)),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: p.accent, width: 1.4 },
          areaStyle: {
            color: {
              type: "linear", x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: `${p.accent}30` }, { offset: 1, color: `${p.accent}00` }],
            },
          },
        },
      ],
    } as never;
  }, [rows, p, lang, x, zh]);

  const streakOption = useMemo(() => {
    if (!rows.length) return {} as never;
    // W9-12：y 轴不再硬编码 max:10；11+ 连板时按区间最大值留白，避免静默画出轴外。
    const streakMax = Math.max(10, Math.ceil((Math.max(...rows.map((r) => r.max_streak ?? 0)) + 1) / 2) * 2);
    return {
      ...baseChart(p),
      grid: [
        { left: 8, right: 10, top: 16, height: "54%", containLabel: true },
        { left: 8, right: 10, top: "72%", bottom: 20, containLabel: true },
      ],
      tooltip: { ...baseChart(p).tooltip, trigger: "axis" },
      xAxis: [
        { type: "category", data: x, gridIndex: 0, ...axisStyle(p), axisLabel: { show: false }, splitLine: { show: false } },
        { type: "category", data: x, gridIndex: 1, ...axisStyle(p), splitLine: { show: false }, axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(x.length / 5)) } },
      ],
      yAxis: [
        { type: "value", gridIndex: 0, ...axisStyle(p), splitNumber: 3 },
        { type: "value", gridIndex: 1, min: 0, max: streakMax, ...axisStyle(p), splitNumber: 2 },
      ],
      series: [
        {
          name: zh ? "连板家数" : "2+ boards",
          type: "bar",
          data: rows.map((r) => r.streak_n),
          itemStyle: { color: p.accent, opacity: 0.85, borderRadius: [2, 2, 0, 0] },
          barWidth: "56%",
        },
        {
          name: zh ? "最高连板" : "Max streak",
          type: "line",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: rows.map((r) => r.max_streak ?? null),
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { color: p.copper, width: 1.5 },
        },
      ],
    } as never;
  }, [rows, p, lang, x, zh]);

  /* P1-4 / W9-03：新高新低图不再先把数据截尾到 ±cap 再画。
   * - 轴域按区间分位自适应（symmetricDomain），但保证覆盖最新一天的幅度；
   * - 数据本身保持真实值，只有超过轴上限的极少数日以「端点 + 真实值标注」呈现；
   * - tooltip 与图注都显示真实值；图注同时给出最新日真实值。 */
  const highLow = useMemo(() => {
    if (!rows.length) return null;
    const highs = rows.map((r) => (r.new_high_n == null ? null : r.new_high_n));
    const lows = rows.map((r) => (r.new_low_n == null ? null : r.new_low_n));
    const latestMag = Math.max(highs[highs.length - 1] ?? 0, lows[lows.length - 1] ?? 0);
    const domain = symmetricDomain(rows.map((_, i) => Math.max(highs[i] ?? 0, lows[i] ?? 0)), {
      percentile: 0.99,
      headroom: 1.15,
      includeMax: latestMag,
    });
    const axisMax = domain.max;
    const clamp = (v: number | null) => (v == null ? null : Math.max(-axisMax, Math.min(axisMax, v)));
    const overHigh = highs
      .map((v, i) => ({ i, v }))
      .filter((d): d is { i: number; v: number } => d.v != null && d.v > axisMax)
      .map((d) => ({ coord: [x[d.i], axisMax], value: d.v, label: { show: true, position: "top" as const, formatter: `${num(d.v)}`, color: p.up, fontSize: 11, distance: 4 } }));
    const overLow = lows
      .map((v, i) => ({ i, v }))
      .filter((d): d is { i: number; v: number } => d.v != null && d.v > axisMax)
      .map((d) => ({ coord: [x[d.i], -axisMax], value: d.v, label: { show: true, position: "bottom" as const, formatter: `${num(d.v)}`, color: p.down, fontSize: 11, distance: 4 } }));
    return {
      axisMax,
      highReal: highs[highs.length - 1],
      lowReal: lows[lows.length - 1],
      overHigh,
      overLow,
      clippedDays: new Set([...overHigh, ...overLow].map((d) => d.coord[0] as string)).size,
      option: {
        ...baseChart(p),
        grid: { left: 8, right: 10, top: 26, bottom: 22, containLabel: true },
        tooltip: {
          ...baseChart(p).tooltip,
          trigger: "axis",
          formatter: (params: unknown) => {
            const first = (params as { dataIndex: number }[])?.[0];
            const i = first?.dataIndex;
            const r = i == null ? undefined : rows[i];
            if (!r) return "";
            const row = (label: string, value: string) =>
              `<div style="display:flex;justify-content:space-between;gap:18px"><span>${label}</span><b>${value}</b></div>`;
            return `<div style="font-family:monospace;font-size:12px;color:${p.muted};margin-bottom:5px">${escapeHtml(r.trade_date)}</div>${
              row(zh ? "新高" : "New highs", `${r.new_high_n == null ? "—" : num(r.new_high_n)} ${zh ? "家" : ""}`) +
              row(zh ? "新低" : "New lows", `${r.new_low_n == null ? "—" : num(r.new_low_n)} ${zh ? "家" : ""}`)
            }`;
          },
        },
        xAxis: { type: "category", data: x, ...axisStyle(p), splitLine: { show: false }, axisLabel: { ...axisStyle(p).axisLabel, interval: Math.max(0, Math.floor(x.length / 5)) } },
        yAxis: {
          type: "value",
          min: -axisMax,
          max: axisMax,
          ...axisStyle(p),
          name: zh ? "家数" : "count",
          nameTextStyle: { color: p.muted, fontSize: 11 },
          axisLabel: { ...axisStyle(p).axisLabel, formatter: (v: number) => `${Math.abs(v)}` },
          splitNumber: 3,
        },
        series: [
          {
            name: zh ? "新高" : "New highs",
            type: "line",
            data: rows.map((r) => clamp(r.new_high_n == null ? null : r.new_high_n)),
            showSymbol: false,
            smooth: 0.2,
            lineStyle: { color: p.up, width: 1.3 },
            areaStyle: {
              color: {
                type: "linear", x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: `${p.up}30` }, { offset: 1, color: `${p.up}00` }],
              },
            },
            markPoint: { symbolSize: 0, silent: true, data: overHigh },
          },
          {
            name: zh ? "新低" : "New lows",
            type: "line",
            data: rows.map((r) => (r.new_low_n == null ? null : clamp(-r.new_low_n))),
            showSymbol: false,
            smooth: 0.2,
            lineStyle: { color: p.down, width: 1.3 },
            areaStyle: {
              color: {
                type: "linear", x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [{ offset: 0, color: `${p.down}00` }, { offset: 1, color: `${p.down}30` }],
              },
            },
            markPoint: { symbolSize: 0, silent: true, data: overLow },
          },
        ],
      } as never,
    };
  }, [rows, p, lang, x, zh]);

  if (!rows.length) return <DataState error={isError} loading={isPending} />;

  const margin = [...all].reverse().find((r) => r.rzye != null);
  const zhaban = last.broken_rate ?? null;
  const sealLast = limitQ?.length ? limitQ[limitQ.length - 1].trade_date : null;
  const partialDay = last.data_quality === "partial";
  const marginEx = margin?.margin_n_exchanges ?? last.margin_n_exchanges ?? null;

  return (
    <div className="flex flex-col gap-3.5">
      <PageHead
        kicker={`${zh ? "极端交易" : "Extremes"} / ${last.trade_date} · 120D`}
        title={zh ? "涨停、连板与新高新低" : "Limit-ups, streaks and new highs"}
        dek={
          zh
            ? `涨停 ${num(last.limit_up_n)} 家、跌停 ${num(last.limit_down_n)} 家；页面同时列出连板梯队、封板质量、新高新低与两融数据`
            : `${num(last.limit_up_n)} limit-ups and ${num(last.limit_down_n)} limit-downs; streak ladder, seal quality, new highs/lows and margin data are shown below`
        }
        chips={
          <>
            <span className="pill">{zh ? "近 120 个交易日" : "Last 120 sessions"}</span>
            <span className="pill">{zh ? "涨停判定：收盘价 ≥ 涨停价 × 0.999" : "Limit-up: close ≥ limit × 0.999"}</span>
            <span className="pill">{zh ? "MA250 上方 " + ratio(last.ma250_breadth, 0) : "Above MA250 " + ratio(last.ma250_breadth, 0)}</span>
            {partialDay && <span className="pill chip-up">{zh ? "当日数据质量 partial" : "Data quality: partial"}</span>}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label={zh ? "涨停家数" : "Limit-ups"} value={num(last.limit_up_n)} sub={zh ? "收盘价 ≥ 涨停价" : "close ≥ limit"} hint={zh ? "用 stk_limit 的涨停价判定，不猜 10%/20%；封板质量卡内的「涨停家数」是官方名单口径（不含 ST），两者不可直接对比" : "Judged with stk_limit, not a fixed 10%/20%. The seal-quality card reports the official-list count (excl. ST); the two calibers are not directly comparable"} />
        <Kpi label={zh ? "跌停家数" : "Limit-downs"} value={num(last.limit_down_n)} sub={zh ? "收盘价 ≤ 跌停价" : "close ≤ limit"} />
        <Kpi label={zh ? "最高连板" : "Max streak"} value={`${last.max_streak ?? "—"}`} sub={`${num(last.streak_n)} ${zh ? "家连板" : "with 2+ boards"}`} />
        <Kpi
          label={zh ? "炸板率" : "Broken rate"}
          value={zhaban === null ? "—" : ratio(zhaban, 1)}
          sub={
            zhaban === null
              ? zh
                ? "官方名单数据源不可用"
                : "official list unavailable"
              : `${num(last.broken_n)} ${zh ? "家炸板" : "broken"}`
          }
          hint={
            zh
              ? "炸板 /（官方涨停 + 炸板），官方口径不含 ST。该指标依赖 Tushare limit_list_d，无权限日期为空——不用价格口径顶替，避免与交易所名单对不上"
              : "broken / (official limit-ups + broken); official universe excludes ST. Needs Tushare limit_list_d and is blank when unavailable — deliberately not substituted with a price-caliber proxy"
          }
        />
      </div>

      <div className="mt-1 flex items-center justify-between">
        <span className="kicker">{zh ? "资金与两融" : "Margin and flows"}</span>
        <span className="micro text-[var(--faint)]">
          {margin ? (
            <>
              {zh ? "截至" : "as of"} {margin.trade_date}
              {marginEx != null ? ` · ${zh ? "SSE+SZSE" : "SSE+SZSE"} ${marginEx}/2 ${zh ? "交易所" : "exchanges"}` : ""}
            </>
          ) : (
            zh ? "两融数据不可用（Tushare margin 无权限或 T+1 未更新）" : "Margin data unavailable (Tushare margin permission or T+1 lag)"
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { k: zh ? "两融余额" : "Margin balance", v: money(margin?.rzye ?? null), sub: margin?.trade_date },
          { k: zh ? "融资买入额" : "Margin buy", v: money(margin?.rzmre ?? null), sub: margin?.trade_date },
          { k: zh ? "资金流广度" : "Flow breadth", v: ratio(last.flow_breadth, 0) },
          { k: zh ? "主力净流入" : "Main net flow", v: money(last.main_net_amount), tone: (last.main_net_amount || 0) >= 0 ? "up" : "down" },
        ].map((s) => (
          <div key={s.k} className="card px-4 py-3.5">
            <div className="text-[12px] leading-none text-[var(--muted)]">{s.k}</div>
            <div className={`mono mt-2 text-[22px] leading-none tracking-[-0.03em] ${s.tone === "up" ? "up" : s.tone === "down" ? "down" : "text-[var(--text)]"}`}>{s.v}</div>
            {s.sub ? <div className="mono mt-1.5 text-[11px] text-[var(--faint)]">{zh ? "截至" : "as of"} {s.sub}</div> : null}
          </div>
        ))}
      </div>

      <Card
        index="01"
        title={zh ? "涨停与跌停" : "Limit-ups and limit-downs"}
        subtitle={zh ? "上：涨停 / 跌停家数 · 下：上涨占比" : "Top: limit-ups/downs · Bottom: breadth"}
        right={<span className="pill">{last.trade_date}</span>}
        prov={zh ? "涨停/跌停按 stk_limit 判定；下图为全市场上涨占比。5%/非 5% 档由 stk_limit 派生：2026-07-06 起上游对原 ST 股返回 10% 档，5% 档计数待上游核对（已知限制）" : "Limit events from stk_limit; lower panel is breadth. The 5%/non-5% split comes from stk_limit: since 2026-07-06 the upstream source returns a 10% band for former ST stocks, so the 5% count is pending upstream verification (known limitation)"}
        padded={false}
        bodyClass="pt-0"
        footer={
          <div className="provline">
            <span>SOURCE <b>limit_list_d / stk_limit</b></span>
            <span>N <b>{num(last.n_valid)}</b></span>
            <a className="r hover:underline" href="#/about">{zh ? "口径说明 →" : "Method →"}</a>
          </div>
        }
      >
        <div className="h-[340px] px-1 pb-1 md:h-[380px] md:px-2">
          <EChart option={limitOption} ariaLabel={zh ? "涨停跌停与广度：上图为涨停/跌停家数，下图为上涨占比" : "Limit-ups/downs and breadth: top panel counts, bottom panel breadth"} />
        </div>
      </Card>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 xl:col-span-6">
          <Card
            index="02"
            title={zh ? "连板梯队" : "Streak ladder"}
            subtitle={zh ? "柱：连板家数 · 下：最高连板高度（y 轴按区间最大值自适应）" : "Bars: 2+ boards · lower: tallest streak (auto-scaled y axis)"}
            prov={zh ? "连板家数 = 连续涨停 ≥ 2 天的股票数；高度 = 当日最高连板。y 轴上限 = max(10, 区间最大值+1)，不会截断 11+ 连板" : "Stocks with 2+ consecutive limit-ups; lower panel is max streak. y-axis max = max(10, window max + 1) so 11+ streaks are never clipped"}
            padded={false}
            bodyClass="pt-0"
          >
            <div className="h-[280px] px-1 pb-1 md:px-2">
              <EChart option={streakOption} ariaLabel={zh ? "连板梯队：柱为连板家数，折线为最高连板高度" : "Streak ladder: bars show 2+ board counts, line shows tallest streak"} />
            </div>
          </Card>
        </div>
        <div className="col-span-12 xl:col-span-6">
          <Card
            index="03"
            title={zh ? "新高与新低" : "New highs vs lows"}
            subtitle={
              highLow
                ? zh
                  ? `252 日新高 / 新低 · 未截尾 · y 轴 ±${num(highLow.axisMax)}${highLow.clippedDays ? ` · ${highLow.clippedDays} 日超出轴上限，端部标注真实值` : ""}`
                  : `252-day highs / lows · no truncation · y axis ±${num(highLow.axisMax)}${highLow.clippedDays ? ` · ${highLow.clippedDays} sessions above axis, real values marked at the edge` : ""}`
                : ""
            }
            right={
              <div className="flex items-center gap-2 text-[11px] text-[var(--faint)]">
                <span className="inline-block h-[2px] w-3" style={{ background: p.up }} />
                {zh ? "新高" : "high"}
                <span className="inline-block h-[2px] w-3" style={{ background: p.down }} />
                {zh ? "新低" : "low"}
              </div>
            }
            prov={zh ? "新高/新低为 252 日收盘价极值；曲线使用真实值，y 轴按 p99 自适应并保证覆盖最新一天；超出轴上限的极值日以端部数字标注真实家数，tooltip 始终显示真实值" : "252-day closing extremes. The lines carry real values; the y axis adapts to p99 but always covers the latest session. Any extreme above the axis is labelled with its real count at the edge, and tooltips always show real values"}
            padded={false}
            bodyClass="pt-0"
            footer={
              highLow ? (
                <div className="provline">
                  <span>{zh ? "最新日" : "Latest"}</span>
                  <span>↑ <b>{num(highLow.highReal)}</b> · ↓ <b>{num(highLow.lowReal)}</b></span>
                  <span className="r">{zh ? "真实值，未截尾" : "real values, untruncated"}</span>
                </div>
              ) : undefined
            }
          >
            <div className="h-[280px] px-1 pb-1 md:px-2">
              {highLow ? <EChart option={highLow.option} ariaLabel={zh ? "新高与新低：252 日新高/新低家数，真实值未截尾" : "New highs and lows: 252-day counts with untruncated real values"} /> : <DataState />}
            </div>
          </Card>
        </div>
      </div>

      <Card
        index="04"
        title={zh ? "封板质量" : "Seal quality"}
        subtitle={
          zh
            ? `封单额 / 流通市值中位数 · 数据截至 ${sealLast ?? "—"} · tooltip 中「涨停家数」为官方名单口径（不含 ST）`
            : `Median seal / float cap · data ends ${sealLast ?? "—"} · the “limit-ups” row in tooltip is the official list caliber (excl. ST)`
        }
        right={<span className="pill">limit_list_d</span>}
        prov={zh ? "封单额 / 流通市值；tooltip 的「开板比例」= 当日涨停股中 open_times>0 的占比，与顶部「炸板率」= broken/(官方涨停+broken) 是两个口径，不能互换。官方名单口径与页面顶部「涨停家数」（stk_limit 价格口径）不同，不可直接对比；历史数据受 Tushare 权限限制" : "Seal amount / float cap. The tooltip’s opened share (limit-up stocks with open_times>0) and the header broken rate (broken/(official limit-ups+broken)) are different calibers. The official-list limit-up count also differs from the header limit-up KPI (stk_limit price caliber) and is not directly comparable; history is limited by Tushare permissions"}
        padded={false}
        bodyClass="pt-0"
        footer={
          <div className="provline">
            <span>SOURCE <b>limit_list_d</b></span>
            <span>{zh ? "截至" : "to"} <b>{sealLast ?? "—"}</b></span>
            <span className="r">{zh ? "历史权限" : "permission"}</span>
          </div>
        }
      >
        <div className="h-[240px] px-1 pb-1 md:px-2">
          {limitQ?.length ? <EChart option={limitQualityChart(p, limitQ, lang)} ariaLabel={zh ? "封板质量：封单额占流通市值中位数走势" : "Seal quality: median seal amount over float cap"} /> : <DataState />}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3 pb-1 text-[11px] text-[var(--faint)]">
        <span className="font-mono">{zh ? "数据源：stk_limit / moneyflow（官方名单与两融视 Tushare 权限）" : "Source: stk_limit / moneyflow (official list and margin depend on Tushare permissions)"}</span>
        <span className="mono">{num(last.limit_up_n)} ↑ {num(last.limit_down_n)} ↓ · {pct(last.ew_ret)}</span>
      </div>
    </div>
  );
}
