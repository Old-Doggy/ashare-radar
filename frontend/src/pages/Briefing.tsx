import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, distributionCoverage, sourceLabel } from "../lib/api";
import { paletteFor } from "../lib/theme";
import { versionLabel, money, num, pct, ratio, weekday } from "../lib/format";
import { regimeLabel, regimeOf, verdict } from "../lib/regime";
import { distributionChart, returnBreadth } from "../lib/charts";
import { DataState } from "../components/DataState";
import { percentile } from "../lib/viewMetrics";
import EChart from "../components/EChart";
import { useUI } from "../store/ui";

/**
 * A4 每日体检简报：路由 /briefing 使用打印视图（Shell 的 printMode + @media print），
 * 由无头浏览器「打印为 PDF」生成对外交付物。旧版注释里提到的打印参数在全仓并无消费点（W9-24）。
 */
export default function Briefing() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const zh = lang === "zh";
  const L = (cn: string, en: string) => zh ? cn : en;
  const { colorblind } = useUI();
  // 简报固定白底，因此配色固定取浅色系；色盲模式必须跟着切到蓝/橙（W14-05）。
  const p = paletteFor("light", colorblind);

  const { data: meta, isError: metaError } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const d = meta?.last_trade_date;
  const { data: series, isError: seriesError, isPending: seriesPending } = useQuery({
    queryKey: ["market-all"],
    queryFn: () => api.marketSeries(),
  });
  const { data: detail } = useQuery({
    queryKey: ["market-day", d],
    queryFn: () => api.marketDay(d as string),
    enabled: !!d,
  });
  const { data: dist } = useQuery({
    queryKey: ["distribution", d],
    queryFn: () => api.distribution(d as string),
    enabled: !!d,
  });

  const rows = series ?? [];
  const last = rows[rows.length - 1];
  if (!last) return <DataState error={metaError || seriesError} loading={seriesPending && !seriesError} />;

  const recent = rows.slice(-60);
  const sectors = detail?.sectors ?? [];
  const byBreadth = [...sectors].sort((a, b) => b.breadth - a.breadth);
  const top = byBreadth.slice(0, 3);
  const bottom = byBreadth.slice(-3).reverse();
  const contrib = (detail?.contributors ?? []).slice(0, 3);
  const regime = regimeOf(last);
  const zhaban = last.broken_rate ?? null;
  const prev20 = rows.slice(-21, -1);
  const comparable = prev20.filter((r) => r.breadth != null && Number.isFinite(r.breadth));
  const breadthDelta = last.breadth == null || !comparable.length ? null : (last.breadth - comparable.reduce((a, r) => a + r.breadth, 0) / comparable.length) * 100;
  const breadthPctile = percentile(rows.slice(-250).map((r) => r.breadth), last.breadth);
  const distCov = distributionCoverage(dist);
  const partialDays = meta?.data_quality?.n_partial_days ?? meta?.data_quality?.partial_days?.length ?? null;
  const unavailable = meta?.sources
    ? Object.entries(meta.sources).filter(([, value]) => String(value).toLowerCase() === "unavailable").map(([key]) => key)
    : [];

  return (
    <div className="briefing mx-auto max-w-[1040px] rounded-xl border border-[var(--border)] bg-white p-4 text-[#101828] shadow-sm sm:p-8">
      <div className="flex items-start justify-between border-b border-[#e4e7ec] pb-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#667085]">{zh ? "A股雷达" : "Ashare Radar"}</div>
          <h1 className="serif mt-1 text-[27px] font-bold tracking-tight">{L("A股市场体检简报", "A-share daily market report")}</h1>
          <div className="mt-1 text-[12px] text-[#667085]">
            {last.trade_date} · {weekday(last.trade_date, lang)} · {L("数据源", "Source")} {sourceLabel(meta, lang)}
          </div>
        </div>
        <div className="text-right">
          <div className="rounded-full bg-[#f2f4f7] px-3 py-1 text-[12px] font-medium text-[#344054]">
            {regimeLabel(regime, lang)}
          </div>
          <div className="mt-2 text-[11px] text-[#98a2b3]">{meta?.n_stocks ?? "—"} {L("只股票", "stocks")} · {meta?.n_days ?? "—"} {L("个交易日", "sessions")}</div>
        </div>
      </div>

      {meta?.alert && <div role="alert" className="mt-3 rounded border border-amber-500 p-2 text-sm">{L("更新失败", "Update failed")}: {meta.alert.message}</div>}
      <p className="mt-5 max-w-[62ch] text-[16px] font-semibold leading-[1.6] tracking-tight">
        {verdict(last, lang).replace(/。$/, "")}
      </p>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
        {[
          { k: L("等权收益", "EW return"), v: pct(last.ew_ret), tone: (last.ew_ret ?? 0) >= 0 ? p.up : p.down },
          { k: L("上涨占比", "Breadth"), v: ratio(last.breadth, 0), tone: "#101828" },
          { k: L("涨停 / 跌停", "Limit-up / down"), v: `${num(last.limit_up_n)} / ${num(last.limit_down_n)}`, tone: "#101828" },
          { k: L("成交额", "Turnover"), v: money(last.amount, lang), tone: "#101828" },
          { k: L("分化度", "Dispersion"), v: `${(last.csd * 100).toFixed(2)}pp`, tone: "#101828" },
          { k: L("Top10 波动占比", "Top10 absolute share"), v: ratio(last.top10_share, 0), tone: "#101828" },
        ].map((s) => (
          <div key={s.k} className="rounded-lg border border-[#e4e7ec] bg-[#fafbfc] px-2.5 py-2">
            <div className="text-[11px] uppercase tracking-wider text-[#98a2b3]">{s.k}</div>
            <div className="mono mt-1 text-[15px] font-semibold" style={{ color: s.tone }}>
              {s.v}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-[#e4e7ec] p-3">
          <div className="text-[12px] font-semibold text-[#344054]">{L("近 60 日：收益 × 广度", "Last 60 sessions: return × breadth")}</div>
          <div className="mt-1 text-[11px] text-[#98a2b3]">{L("柱：等权收益 · 线：沪深300 · 下：上涨占比", "Bars: EW return · line: CSI 300 · lower: breadth")}</div>
          <div className="mt-2 h-[260px]">
            <EChart
              option={{ ...returnBreadth(p, recent, lang), animation: false }}
              ariaLabel={L("近 60 日收益与广度：柱为等权收益，线为沪深300，下图为上涨占比", "Last 60 sessions return and breadth: bars are equal-weight return, line is CSI 300, lower panel is breadth")}
            />
          </div>
        </div>
        <div className="rounded-lg border border-[#e4e7ec] p-3">
          <div className="text-[12px] font-semibold text-[#344054]">{L("当日个股收益分布", "Daily stock return distribution")}</div>
          <div className="mt-1 text-[11px] text-[#98a2b3]">
            {dist
              ? L(
                  `±11% 外 ${distCov.omitted ?? "—"} 只不绘制（入箱 ${num(distCov.binned)} / 样本 ${num(distCov.total)}）· 虚线为中位数`,
                  `${distCov.omitted ?? "—"} stocks outside ±11% omitted (binned ${num(distCov.binned)} / sample ${num(distCov.total)}) · dashed line: median`,
                )
              : L("暂无分布数据", "Distribution unavailable")}
          </div>
          <div className="mt-2 h-[260px]">
            {dist?.bins?.length ? <EChart option={{ ...distributionChart(p, dist.bins, dist.stats, lang), animation: false }} ariaLabel={L("当日个股收益分布直方图，±11% 外个股未绘制", "Daily stock return histogram; stocks outside ±11% are omitted")} /> : null}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-[#e4e7ec] p-3">
          <div className="text-[12px] font-semibold text-[#344054]">{L("最广泛参与", "Broadest participation")}</div>
          <div className="mt-2 space-y-1.5">
            {top.map((s) => (
              <div key={s.sw_l1} className="flex items-center justify-between text-[12px]">
                <span className="text-[#344054]">{s.sw_l1}</span>
                <span className="mono text-[#667085]">
                  {ratio(s.breadth, 0)} · <span style={{ color: (s.ew_ret ?? 0) >= 0 ? p.up : p.down }}>{pct(s.ew_ret)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-[#e4e7ec] p-3">
          <div className="text-[12px] font-semibold text-[#344054]">{L("最弱参与", "Weakest participation")}</div>
          <div className="mt-2 space-y-1.5">
            {bottom.map((s) => (
              <div key={s.sw_l1} className="flex items-center justify-between text-[12px]">
                <span className="text-[#344054]">{s.sw_l1}</span>
                <span className="mono text-[#667085]">
                  {ratio(s.breadth, 0)} · <span style={{ color: (s.ew_ret ?? 0) >= 0 ? p.up : p.down }}>{pct(s.ew_ret)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-[#e4e7ec] p-3">
          <div className="text-[12px] font-semibold text-[#344054]">{L("最大贡献个股", "Largest absolute contributors")}</div>
          <div className="mt-2 space-y-1.5">
            {contrib.map((c) => (
              <div key={c.ts_code} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-[#344054]">{c.name}</span>
                {/* W9-23：列表按 |贡献| 排序，因此必须显示贡献 pp（而不是涨跌幅），涨跌幅放在括号里 */}
                <span className="mono shrink-0">
                  <span style={{ color: (c.contrib ?? 0) >= 0 ? p.up : p.down }}>
                    {c.contrib == null ? "—" : `${c.contrib >= 0 ? "+" : ""}${(c.contrib * 100).toFixed(3)}pp`}
                  </span>
                  <span className="ml-1 text-[#98a2b3]">({pct(c.ret)})</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-[#e4e7ec] bg-[#fafbfc] p-3">
        <div className="text-[12px] font-semibold text-[#344054]">{L("今日三条", "Three observations")}</div>
        <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-[#475467]">
          <li>
            ① {L("广度", "Breadth")} {ratio(last.breadth, 0)}，{L("较20日均值", "vs 20-session mean")} {breadthDelta == null ? "—" : (breadthDelta >= 0 ? "+" : "") + breadthDelta.toFixed(1)}pp，{L("近一年分位", "past-year percentile")} {breadthPctile == null ? "—" : `${breadthPctile}%`}（{L("250 日窗口，含当日", "250-session window, includes today")}）。
          </li>
          <li>
            ② {L("最强参与", "Broadest")}: {top[0]?.sw_l1} {ratio(top[0]?.breadth ?? null, 0)}；{L("最弱参与", "Narrowest")}: {bottom[0]?.sw_l1}{" "}
            {ratio(bottom[0]?.breadth ?? null, 0)}（{L("收益", "return")} {pct(bottom[0]?.ew_ret ?? null)}）。
          </li>
          <li>
            ③ {L("涨停", "Limit-ups")} {num(last.limit_up_n)} / {L("跌停", "downs")} {num(last.limit_down_n)}，{L("炸板率", "broken rate")} {zhaban === null ? "—" : ratio(zhaban, 0)}，{L("连板家数", "2+ streak count")} {num(last.streak_n)}，{L("最高板数", "max streak")} {last.max_streak ?? "—"}。
          </li>
        </ul>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#e4e7ec] pt-3 font-mono text-[11px] text-[#98a2b3]">
        <span className="rounded border border-[#e4e7ec] px-1.5 py-0.5 text-[#475467]">raw</span>
        <span>→</span>
        <span className="rounded border border-[#e4e7ec] px-1.5 py-0.5 text-[#475467]">core.market_day</span>
        <span>→</span>
        <span className="rounded border border-[#e4e7ec] px-1.5 py-0.5 text-[#475467]">mart.market_day</span>
        <span>→</span>
        <span className="rounded border border-[#e4e7ec] px-1.5 py-0.5 text-[#475467]">page</span>
        <span className="ml-auto">N {meta?.n_stocks ?? "—"} · {L("等权 · 统计保留原始收益", "EW · statistics use raw returns")}</span>
      </div>

      <div className="mt-2 flex flex-col gap-1 text-[11px] leading-relaxed text-[#98a2b3] sm:flex-row sm:items-center sm:justify-between">
        <span>
          {L("炸板率", "Broken rate")} {zhaban === null ? "—" : ratio(zhaban, 0)} · {L("连板家数", "2+ streak count")} {num(last.streak_n)} · {L("最高板数", "Max streak")} {last.max_streak ?? "—"} · {L("新高", "New highs")} {last.new_high_n ?? "—"} / {L("新低", "lows")} {last.new_low_n ?? "—"}
        </span>
        <span className="sm:text-right">{zh ? "A股雷达" : "Ashare Radar"} {versionLabel(meta?.version)} · {L("数据截至", "Data as of")} {last.trade_date}</span>
      </div>

      {/* W14-03/W14-04：对外打印件披露数据许可、已知限制与免责声明（与 About / NOTICE 一致）。 */}
      <div className="mt-3 border-t border-[#e4e7ec] pt-3 text-[11px] leading-relaxed text-[#667085]">
        <div>
          {L(
            "数据许可：行情数据来自 Tushare（用户须自行持有合法权限，不得再分发原始数据）；本简报仅供研究参考，不构成投资建议。",
            "Data licence: market data comes from Tushare (users must hold their own valid permissions and must not redistribute raw data). This report is for research reference only and is not investment advice.",
          )}
        </div>
        <div className="mt-1">
          {L("已知限制：", "Known limitations: ")}
          {L(
            "行业为当前静态映射非历史成员；官方名单/两融等可选数据可能因权限缺失（缺失保持未知）；5%/非5% 涨跌停档位在 2026-07-06 起存在上游断裂。",
            "industry labels are current static mappings, not historical membership; optional data (official limit list, margin) may be unavailable and stays unknown; the 5%/non-5% limit band has an upstream break since 2026-07-06.",
          )}
          {partialDays != null ? L(` 历史部分交易日：${partialDays} 天（权重类指标在这些日期为未知）。`, ` Partial trading days in history: ${partialDays} (weight-based metrics stay unknown on those days).`) : ""}
          {unavailable.length ? L(` 当前不可用数据集：${unavailable.join(" / ")}。`, ` Unavailable datasets: ${unavailable.join(" / ")}.`) : ""}
        </div>
      </div>
    </div>
  );
}
