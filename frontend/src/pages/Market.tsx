import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useUI } from "../store/ui";
import { paletteFor } from "../lib/theme";
import { money, num, pct, ratio, shortDate, trendClass } from "../lib/format";
import { returnBreadth } from "../lib/charts";
import { concentrationChart, dispersionChart } from "../lib/charts2";
import ZoomChart, { type ZoomChartHandle } from "../components/ZoomChart";
import { Card } from "../components/Card";
import { PageHead } from "../components/PageHead";
import { DataState } from "../components/DataState";
import { coverageGaps, cumulativeReturn, displaySource, median, mostConcentratedDay, pickRange } from "../lib/viewMetrics";
import { Segmented } from "../components/Segmented";

const RANGES = [
  { value: "3M", label: "3M", n: 66 },
  { value: "6M", label: "6M", n: 130 },
  { value: "1Y", label: "1Y", n: 250 },
  { value: "3Y", label: "3Y", n: 750 },
  { value: "ALL", label: "ALL", n: 99999 },
] as const;

type RangeKey = (typeof RANGES)[number]["value"];
const RANGE_KEYS = RANGES.map((r) => r.value) as RangeKey[];

const HINT_ZH = "滚轮缩放 · 拖拽平移 · 双击复位";
const HINT_EN = "Scroll to zoom · drag to pan · double-click to reset";

export default function Market() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const zh = lang === "zh";
  const { theme, colorblind } = useUI();
  const p = paletteFor(theme, colorblind);
  const [params, setParams] = useSearchParams();
  const rawRange = params.get("range");
  // 非法 range（?range=FOO）回退默认区间，并把 URL 改成合法值（W7-11）
  const range = pickRange<RangeKey>(rawRange, RANGE_KEYS, "1Y");
  useEffect(() => {
    if (rawRange != null && rawRange !== range) {
      const next = new URLSearchParams(params);
      next.set("range", range);
      setParams(next, { replace: true });
    }
  }, [rawRange, range, params, setParams]);

  // 触屏（粗指针）或窄屏上关闭单指拖拽平移，页面纵向滚动不被劫持；
  // 双指捏合缩放、底部滑杆与键盘仍然可用。
  const computePan = () => {
    if (typeof window === "undefined" || !window.matchMedia) return true;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    return !coarse && window.innerWidth >= 768;
  };
  const [pan, setPan] = useState(computePan);
  useEffect(() => {
    const onChange = () => setPan(computePan());
    window.addEventListener("resize", onChange);
    const mq = window.matchMedia?.("(pointer: coarse)");
    mq?.addEventListener?.("change", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      mq?.removeEventListener?.("change", onChange);
    };
  }, []);

  const chart1 = useRef<ZoomChartHandle>(null);
  const chart2 = useRef<ZoomChartHandle>(null);
  const chart3 = useRef<ZoomChartHandle>(null);
  const ghostId = useRef(0);
  const ghostTimer = useRef<number | null>(null);
  const transitionId = useRef(0);
  const transitionTimer = useRef<number | null>(null);
  // 拉远换范围时：先把新图摆到旧窗口，再动画拉远到新范围全览
  const pendingExpand = useRef<{ id: number; from: [number, number][] } | null>(null);
  const [ghost, setGhost] = useState<{ id: number; src: (string | null)[] } | null>(null);

  useEffect(
    () => () => {
      if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
      if (transitionTimer.current) window.clearTimeout(transitionTimer.current);
    },
    [],
  );

  // 换范围时图面会整份重建（EChart 的 notMerge）：先抓一张旧图做交叉淡出，
  // 让“切范围”看起来是过渡而不是硬切。缩放状态本身仍只活在 ECharts 实例里。
  const crossfade = useCallback((mutate: () => void) => {
    const refs = [chart1, chart2, chart3];
    const src = refs.map((r) => r.current?.snapshot() ?? null);
    if (src.some(Boolean)) {
      const id = ++ghostId.current;
      setGhost({ id, src });
      if (ghostTimer.current) window.clearTimeout(ghostTimer.current);
      ghostTimer.current = window.setTimeout(() => setGhost((g) => (g && g.id === id ? null : g)), 380);
    }
    mutate();
  }, []);

  const clearGhost = useCallback(() => {
    setGhost((g) => (g && g.id === ghostId.current ? null : g));
  }, []);

  const { data: meta } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const { data: series, isError, isPending } = useQuery({ queryKey: ["market-all"], queryFn: () => api.marketSeries() });

  const rows = useMemo(() => {
    if (!series) return [];
    const n = RANGES.find((r) => r.value === range)?.n ?? 250;
    return series.slice(-n);
  }, [series, range]);

  // 集中度 20 日均线预热：区间首行之前的 19 个交易日（ALL 区间时为空，W6-02）
  const lead = useMemo(() => {
    if (!series) return [];
    const n = RANGES.find((r) => r.value === range)?.n ?? 250;
    const end = Math.max(0, series.length - n);
    return series.slice(Math.max(0, end - 19), end);
  }, [series, range]);

  const applyRange = (r: RangeKey) => {
    const next = new URLSearchParams(params);
    next.set("range", r);
    setParams(next, { replace: true });
  };

  /**
   * 换范围动画：数据是右端对齐的切片，所以
   * - 拉远（3M→1Y→ALL）：先换数据，把新图摆到旧窗口位置，再动画拉远到全览；
   * - 推近（ALL→3Y）：先让旧图动画推近到目标窗口，再换数据（此时两图内容几乎重合）。
   * 两侧都叠加一次旧图快照的交叉淡出，遮住轴与 y 轴刻度的跳变。
   */
  const changeRange = (r: RangeKey) => {
    if (r === range) return;
    const target = RANGES.find((x) => x.value === r);
    if (!series || !target || !rows.length) {
      applyRange(r);
      return;
    }
    const nOld = rows.length;
    const nNew = Math.min(target.n, series.length);
    if (nNew === nOld) {
      crossfade(() => applyRange(r));
      return;
    }
    const refs = [chart1, chart2, chart3];
    const id = ++transitionId.current;
    if (nNew > nOld) {
      const offset = nNew - nOld;
      const from = refs.map((ref): [number, number] => {
        const [start, end] = ref.current?.getWindow() ?? [0, 100];
        const f = ((offset + (start / 100) * (nOld - 1)) / (nNew - 1)) * 100;
        const t = ((offset + (end / 100) * (nOld - 1)) / (nNew - 1)) * 100;
        return [Math.min(100, Math.max(0, f)), Math.min(100, Math.max(0, t))];
      });
      pendingExpand.current = { id, from };
      crossfade(() => applyRange(r));
      return;
    }
    const offset = nOld - nNew;
    const start = (offset / Math.max(1, nOld - 1)) * 100;
    refs.forEach((ref) => ref.current?.animateWindow(start, 100, 320));
    if (transitionTimer.current) window.clearTimeout(transitionTimer.current);
    transitionTimer.current = window.setTimeout(() => {
      if (transitionId.current !== id) return;
      crossfade(() => applyRange(r));
    }, 340);
  };

  // 拉远动画的第二步：新 option 已套用（子组件 effect 先于本 effect），先摆到旧窗口再拉远
  useEffect(() => {
    const pending = pendingExpand.current;
    if (!pending || pending.id !== transitionId.current) return;
    const refs = [chart1, chart2, chart3];
    refs.forEach((ref, i) => ref.current?.setWindow(pending.from[i][0], pending.from[i][1]));
    const timer = window.setTimeout(() => {
      if (transitionId.current !== pending.id) return;
      refs.forEach((ref) => ref.current?.animateWindow(0, 100, 460));
      if (pendingExpand.current?.id === pending.id) pendingExpand.current = null;
    }, 48);
    return () => window.clearTimeout(timer);
  }, [range]);

  // 缓存图表 option：无关的重渲染（例如 ghost 状态）不会重设 option，缩放窗口得以保留。
  // 换范围 / 主题 / 语言 / 触屏策略变化时才重建 —— 此时窗口复位到全览是预期行为。
  const zoomOpts = useMemo(() => ({ pan }), [pan]);
  const optBreadth = useMemo(() => returnBreadth(p, rows, lang, zoomOpts), [p, rows, lang, zoomOpts]);
  const optConc = useMemo(() => concentrationChart(p, rows, lang, zoomOpts, { lead }), [p, rows, lang, zoomOpts, lead]);
  const optDisp = useMemo(() => dispersionChart(p, rows, lang, zoomOpts), [p, rows, lang, zoomOpts]);

  if (isError) return <DataState error />;
  if (series && !rows.length) return <DataState />;
  if (!series) {
    return (
      <div className="flex flex-col gap-3.5">
        <div className="skeleton h-[92px] w-full" />
        <div className="skeleton h-[92px] w-full" />
        <div className="skeleton h-[420px] w-full" />
      </div>
    );
  }

  // 区间累计：任一日 ew_ret 缺失/不可用时保持未知，绝不把缺日当平盘继续复利（W5-09）
  const cum = cumulativeReturn(rows.map((r) => r.ew_ret));
  const breadthRows = rows.filter((r) => r.breadth != null && Number.isFinite(r.breadth));
  const avgBreadth = breadthRows.length ? breadthRows.reduce((a, r) => a + r.breadth, 0) / breadthRows.length : null;
  const maxB = breadthRows.reduce((a, r) => (r.breadth > a.breadth ? r : a), breadthRows[0]);
  const minB = breadthRows.reduce((a, r) => (r.breadth < a.breadth ? r : a), breadthRows[0]);
  // 最集中日：只在 top10_share 有有限值的行里比较，CSD 用**该日**的值（W7-02）
  const maxC = mostConcentratedDay(rows);
  // 覆盖不足披露：优先数据层 data_quality，字段未上线时退回 n_valid 低样本启发式（W7-04）
  const coverage = coverageGaps(rows);
  const last = rows[rows.length - 1];
  const prev = series[series.length - 2];
  const breadthValues = breadthRows.map((r) => r.breadth).sort((a, b) => a - b);
  const medBreadth = median(breadthValues);

  const stats = [
    {
      k: zh ? "区间等权累计" : "Cumulative EW",
      v: pct(cum),
      tone: trendClass(cum),
      s: `${rows.length} ${zh ? "个交易日" : "sessions"}`,
    },
    {
      k: zh ? "平均广度" : "Average breadth",
      v: ratio(avgBreadth, 0),
      tone: "",
      s: `${zh ? "中位" : "median"} ${ratio(medBreadth, 0)}`,
    },
    {
      k: zh ? "广度最高日" : "Broadest day",
      v: maxB ? shortDate(maxB.trade_date) : "—",
      tone: "",
      s: maxB ? `${ratio(maxB.breadth, 0)} · ${pct(maxB.ew_ret)}` : "—",
    },
    {
      k: zh ? "广度最低日" : "Narrowest day",
      v: minB ? shortDate(minB.trade_date) : "—",
      tone: "",
      s: minB ? `${ratio(minB.breadth, 0)} · ${pct(minB.ew_ret)}` : "—",
    },
    {
      k: zh ? "最集中日" : "Most concentrated",
      v: maxC ? shortDate(maxC.trade_date) : "—",
      tone: "",
      s: maxC
        ? `${zh ? "Top10 波动占比" : "Top10 share"} ${ratio(maxC.top10_share, 0)} · CSD ${maxC.csd == null ? "—" : `${(maxC.csd * 100).toFixed(2)}pp`}`
        : "—",
    },
  ];

  return (
    <div className="flex flex-col gap-3.5">
      <PageHead
        kicker={`${zh ? "市场结构" : "Market structure"} / ${last.trade_date} · ${rows.length}D`}
        title={zh ? "指数与等权，走势差多少" : "Index vs equal-weight"}
        dek={
          zh
            ? `过去 ${rows.length} 个交易日，全市场等权累计 ${pct(cum)}，平均广度 ${ratio(avgBreadth, 0)}；逐日收益、广度与集中度见下方图表`
            : `Over the last ${rows.length} sessions the equal-weight market returned ${pct(cum)} with average breadth ${ratio(avgBreadth, 0)}`
        }
        chips={
          <>
            <span className="pill">{zh ? "等权" : "Equal-weight"}</span>
            <span className="pill">{zh ? "日频" : "Daily"}</span>
            <span className="pill">{zh ? "股票池：沪深主板 + 创业板 + 科创板" : "Universe: SSE/SZSE main + ChiNext + STAR"}</span>
          </>
        }
        right={<Segmented options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={changeRange} />}
      />

      {coverage.flagged && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-[var(--warn)]/25 bg-[var(--warn-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--warn)]"
        >
          <span className="mt-[5px] inline-block h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--warn)]" />
          <span>
            {zh
              ? `区间样本覆盖不足：${coverage.total} 个交易日被标记为数据不完整（partial ${coverage.partial} · 低样本 ${coverage.lowSample}，n_valid 最低 ${num(coverage.minNValid)}）。累计收益、均值与极值可能受其影响。`
              : `Low sample coverage: ${coverage.total} sessions in range are incomplete (partial ${coverage.partial} · low-sample ${coverage.lowSample}, min n_valid ${num(coverage.minNValid)}). Cumulative return, averages and extremes may be affected.`}
          </span>
        </div>
      )}

      <div className="card grid grid-cols-2 divide-x divide-[var(--border)] md:grid-cols-3 xl:grid-cols-5">
        {stats.map((s) => (
          <div key={s.k} className="px-4 py-4">
            <div className="truncate text-[12px] leading-none text-[var(--muted)]">{s.k}</div>
            <div className={`mono mt-2 text-[25px] leading-none tracking-[-0.04em] md:text-[27px] ${s.tone}`}>{s.v}</div>
            <div className="mono mt-2 truncate text-[12px] text-[var(--faint)]">{s.s}</div>
          </div>
        ))}
      </div>

      <Card
        index="01"
        title={zh ? "收益 × 广度" : "Return × breadth"}
        subtitle={
          zh
            ? "柱 = 等权日收益 · 线 = 沪深300 · 虚线 = 流通市值加权 · 下 = 上涨股票占比"
            : "Bars = EW return · Solid = CSI 300 · Dotted = cap-weight · Lower = breadth"
        }
        right={
          <div className="flex items-center gap-3">
            <span
              className="hidden text-[10.5px] text-[var(--faint)] md:inline"
              title={zh ? "方向键平移 · + / − 缩放 · 0 复位" : "Arrow keys pan · + / − zoom · 0 resets"}
            >
              {zh ? HINT_ZH : HINT_EN}
            </span>
            <span className="text-[10.5px] text-[var(--faint)] md:hidden">{zh ? "双指缩放" : "Pinch to zoom"}</span>
            <span className="pill">{rows[0]?.trade_date} → {last.trade_date}</span>
          </div>
        }
        prov={zh ? "等权收益为全市场算术平均；沪深300 为指数日收益；广度为上涨 /（上涨 + 下跌）" : "EW mean return; CSI 300 index return; breadth = adv / (adv + dec)"}
        padded={false}
        bodyClass="pt-0"
        footer={
          <div className="provline">
            <span>SOURCE <b>daily / daily_basic / index_daily</b></span>
            <span>N <b>{rows.length}</b></span>
            <span>{zh ? "等权" : "EW"}</span>
            <span>{zh ? "统计未截尾" : "unclipped statistics"}</span>
            <a className="r hover:underline" href="#/about">{zh ? "口径说明 →" : "Method →"}</a>
          </div>
        }
      >
        <div className="h-[400px] px-1 pb-1 md:h-[440px] md:px-2">
          <ZoomChart
            ref={chart1}
            option={optBreadth}
            ariaLabel={zh ? "区间收益与广度。滚轮缩放、拖拽平移、双击复位" : "Return and breadth. Scroll to zoom, drag to pan, double-click to reset"}
            ghostSrc={ghost?.src[0] ?? null}
            ghostKey={ghost?.id}
            onGhostEnd={clearGhost}
          />
        </div>
      </Card>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 xl:col-span-6">
          <Card
            index="02"
            title={zh ? "集中度：Top10 波动占比" : "Concentration"}
            subtitle={
              zh
                ? "柱：每5交易日均值（按最新交易日右对齐）；线：20日均值（含区间前19个交易日）"
                : "Bars: 5-session average, right-aligned to the latest session; line: 20-session average (uses 19 sessions before the range)"
            }
            right={
              <div className="flex items-center gap-3 text-[10.5px] text-[var(--faint)]">
                <span className="flex items-center gap-1">
                  <i className="inline-block h-[7px] w-[3px] rounded-sm" style={{ background: p.text2, opacity: 0.5 }} />
                  {zh ? "5日均值" : "5-session"}
                </span>
                <span className="flex items-center gap-1">
                  <i className="inline-block h-[2px] w-4" style={{ background: p.accent }} />
                  20D
                </span>
                {coverage.partial > 0 && (
                  <span className="flex items-center gap-1">
                    <i className="inline-block h-[7px] w-[3px] rounded-sm" style={{ background: p.copper, opacity: 0.62 }} />
                    {zh ? "含部分日" : "partial"}
                  </span>
                )}
              </div>
            }
            prov={zh ? "Top10 波动占比 = 前10权重股绝对贡献之和 / 全体绝对贡献之和；Top5% 为涨幅前5%股票的正收益份额" : "Top10 absolute-contribution share; top-5% positive-return share"}
            padded={false}
            bodyClass="pt-0"
            footer={
              <div className="provline">
                <span>SOURCE <b>daily / daily_basic</b></span>
                <span>{zh ? "前一日全市场流通市值权重" : "prior-day float-cap weights"}</span>
                <span className="r">{zh ? "按最新交易日右对齐，最旧一组可能不足5日" : "Right-aligned 5-session blocks; the oldest block may be shorter"}</span>
              </div>
            }
          >
            <div className="h-[260px] px-1 pb-1 md:px-2">
              <ZoomChart
                ref={chart2}
                option={optConc}
                ariaLabel={zh ? "集中度。滚轮缩放、拖拽平移、双击复位" : "Concentration. Scroll to zoom, drag to pan, double-click to reset"}
                ghostSrc={ghost?.src[1] ?? null}
                ghostKey={ghost?.id}
                onGhostEnd={clearGhost}
              />
            </div>
          </Card>
        </div>

        <div className="col-span-12 xl:col-span-6">
          <Card
            index="03"
            title={zh ? "分化度：横截面离散" : "Dispersion"}
            subtitle={zh ? "实线 CSD（灰）· 实线 IQR（金）· 等权与加权差（EW−CW）见 tooltip" : "Solid CSD (gray) and IQR (gold); the EW−CW gap is in the tooltip"}
            right={
              <div className="flex items-center gap-2 text-[10.5px] text-[var(--faint)]">
                <span className="inline-block h-[2px] w-3" style={{ background: p.text2 }} />
                CSD
                <span className="inline-block h-[2px] w-3" style={{ background: p.accent }} />
                IQR
              </div>
            }
            prov={zh ? "CSD = 横截面收益标准差；IQR = 75 分位 − 25 分位" : "CSD = cross-sectional std; IQR = q75 − q25"}
            padded={false}
            bodyClass="pt-0"
            footer={
              <div className="provline">
                <span>SOURCE <b>daily</b></span>
                <span>{zh ? "全市场" : "all A-shares"}</span>
                <span className="r">{zh ? "越高 = 个股越分化" : "higher = more dispersed"}</span>
              </div>
            }
          >
            <div className="h-[260px] px-1 pb-1 md:px-2">
              <ZoomChart
                ref={chart3}
                option={optDisp}
                ariaLabel={zh ? "分化度。滚轮缩放、拖拽平移、双击复位" : "Dispersion. Scroll to zoom, drag to pan, double-click to reset"}
                ghostSrc={ghost?.src[2] ?? null}
                ghostKey={ghost?.id}
                onGhostEnd={clearGhost}
              />
            </div>
          </Card>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 pt-0.5 text-[10.5px] text-[var(--faint)]">
        <span className="font-mono">
          {`${zh ? "来源" : "Source"}: ${displaySource(meta?.source)} · daily / daily_basic / index_daily`}
        </span>
        <span className="mono">
          {last.trade_date} · {zh ? "日均成交额" : "avg turnover"} {money(rows.reduce((a, r) => a + r.amount, 0) / rows.length)}
          {prev ? ` · ${zh ? "前值" : "prev"} ${shortDate(prev.trade_date)}` : ""}
        </span>
      </div>
    </div>
  );
}
