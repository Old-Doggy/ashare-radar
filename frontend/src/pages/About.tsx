import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, sourceLabel, unavailableDatasetNames } from "../lib/api";
import { versionLabel } from "../lib/format";
import { Card, MicroLabel } from "../components/Card";
import { PageHead } from "../components/PageHead";

const METRICS: { k: string; zh: string; en: string; f: string }[] = [
  { k: "breadth", zh: "上涨占比", en: "Breadth", f: "N(涨) / (N(涨)+N(跌))，剔除平盘与无有效收益" },
  { k: "ew_ret", zh: "等权收益", en: "Equal-weight return", f: "mean(pct_chg/100)，有效且非上市前5交易日样本" },
  { k: "cw_ret", zh: "流通市值加权", en: "Float-cap weighted return", f: "Σ wᵢrᵢ，w用上一市场交易日circ_mv，在当日可用样本归一；当日权重覆盖不足时输出 NULL" },
  { k: "hhi", zh: "集中度 HHI", en: "HHI", f: "Σ wᵢ² × 10000，越大越集中" },
  { k: "top10_share", zh: "Top10 波动占比", en: "Top10 share", f: "Top10 全市场流通市值权重股 |wᵢrᵢ| / Σ|wᵢrᵢ|，w = 前一日流通市值权重" },
  { k: "csd", zh: "分化度", en: "Dispersion", f: "横截面收益标准差（pp）" },
  { k: "iqr", zh: "IQR", en: "IQR", f: "q75 − q25，抗极值" },
  { k: "limit_up", zh: "涨停", en: "Limit-up", f: "成熟有效样本 close ≥ stk_limit.up_limit × 0.999；缺限价未知。5%/非5% 档由 stk_limit 派生（2026-07-06 起上游档位断裂）" },
  { k: "new_high", zh: "新高", en: "New high", f: "adj_close ≥ 过去 252 日最高（需满 250 日历史）" },
  { k: "ma250", zh: "MA250 上方", en: "Above MA250", f: "adj_close > MA250 的股票占比（相等视为未站上）" },
  { k: "data_quality", zh: "数据质量", en: "Data quality", f: "ok / partial；权重覆盖 <95% 或有效样本 <前20日中位数95% 记为 partial，权重类指标输出未知" },
];

const METRIC_EN: Record<string, string> = {
  breadth: "Advancers / (advancers + decliners); flat and invalid returns excluded",
  ew_ret: "Arithmetic mean of pct_chg/100 for eligible established stocks",
  cw_ret: "Sum(w × return); weights use previous market session float cap, normalized over available eligible stocks; NULL when weight coverage is insufficient",
  hhi: "Sum(w²) × 10,000; larger values indicate concentration",
  top10_share: "Top10 by prior-session weight: sum(abs(w × return)) / total absolute contributions",
  csd: "Sample cross-sectional standard deviation; display in pp",
  iqr: "q75 minus q25",
  limit_up: "Eligible close ≥ positive official limit price × 0.999; missing limits stay unknown. The 5%/non-5% band is derived from stk_limit (upstream band break since 2026-07-06)",
  new_high: "Adjusted close ≥ 252-observation maximum, with at least 250 observations",
  ma250: "Share above MA250 among stocks with sufficient valid history (equal counts as not above)",
  data_quality: "ok / partial; partial when weight coverage <95% or valid sample <95% of the trailing 20-session median — weight-based metrics then stay unknown",
};

const GATE_ZH: Record<number, string> = {
  1: "股票数及环比",
  2: "主键唯一",
  3: "价格合法性",
  4: "收益一致性",
  5: "字段覆盖率",
  6: "广度日变化合理性",
  7: "行业覆盖",
  8: "复权因子",
  9: "与昨日连续性",
  10: "成交量额有效",
  11: "涨跌停价覆盖",
  12: "四指数完整",
  13: "指数收益一致",
  14: "上市日期完整",
  15: "历史完整性",
  16: "限价档稳定性",
};

/** 门禁 6 实际检查的是「广度日变化」而不是当日广度，显示当日广度的同时标注语义（W9-08 缓解）。 */
const fmtGate = (g: { id: number; value: number | null; message?: string }) => {
  if (g.value === null || g.value === undefined) return "—";
  if (g.id === 6) return `${(g.value * 100).toFixed(2)}%（当日广度）`;
  if ([4, 5, 7, 11].includes(g.id)) return `${(g.value * 100).toFixed(2)}%`;
  if (g.id === 9) return `${(g.value * 100).toFixed(2)}pp`;
  if (g.id === 1) return g.value.toLocaleString("en-US");
  return `${g.value}`;
};

export default function About() {
  const { i18n } = useTranslation();
  const lang = i18n.language;
  const zh = lang === "zh";
  const { data: meta } = useQuery({ queryKey: ["meta"], queryFn: api.meta });
  const { data: quality } = useQuery({ queryKey: ["quality"], queryFn: api.quality });
  const { data: updates } = useQuery({ queryKey: ["updates"], queryFn: api.updates });
  const { data: reconcile } = useQuery({ queryKey: ["reconcile"], queryFn: api.reconcile });

  const gates = quality?.gates ?? [];
  const gatesPassed = gates.filter((g) => g.pass).length;
  const source = sourceLabel(meta, lang);
  const unavailable = unavailableDatasetNames(meta);
  const dataQuality = meta?.data_quality ?? null;
  const partialDays = dataQuality?.n_partial_days ?? dataQuality?.partial_days?.length ?? null;
  const partialList = (dataQuality?.partial_days ?? []).slice(0, 8);
  const warnings = meta?.warnings ?? [];
  const version = versionLabel(meta?.version);
  const reconcileVerifiable = (reconcile?.pairs ?? 0) > 0;
  const reconcileDays =
    reconcile && reconcile.pairs && reconcile.stocks ? Math.round(reconcile.pairs / reconcile.stocks) : null;

  return (
    <div className="flex flex-col gap-4">
      <PageHead
        kicker={`${zh ? "方法与数据" : "Method"} / ${version}`}
        title={zh ? "数据口径与血缘" : "Data lineage and definitions"}
        dek={zh ? "数据血缘、指标口径、质量门禁、更新日志、源间对账、数据许可与已知限制" : "Lineage, metric definitions, quality gates, update log, reconciliation, data licence and known limitations"}
        chips={
          <>
            <span className="pill">{meta?.last_trade_date ?? "—"}</span>
            <span className="pill">{zh ? "门禁" : "Gates"} {quality ? `${gatesPassed}/${gates.length}` : "—"}</span>
            <span className="pill">{source}</span>
            {partialDays != null && partialDays > 0 ? (
              <span className="pill chip-up">{zh ? `历史部分交易日 ${partialDays}` : `${partialDays} partial days`}</span>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-7">
          <Card title={lang === "en" ? "Data lineage" : "数据血缘"}>
            <div className="flex flex-col gap-2">
              {[
                { n: lang === "en" ? "Tushare Pro / snapshot" : "Tushare Pro / 本地快照", d: lang === "en" ? "daily, daily_basic, adj_factor, stk_limit, limit_list_d, moneyflow" : "daily、daily_basic、adj_factor、stk_limit、limit_list_d、moneyflow" },
                { n: "raw parquet", d: lang === "en" ? "Immutable landing zone, deduped by (ts_code, trade_date)" : "原始落地层，按 (ts_code, trade_date) 去重" },
                { n: "DuckDB · core", d: lang === "en" ? "stock_day, index_day, limit_event, flow_day, margin_day" : "stock_day、index_day、limit_event、flow_day、margin_day" },
                { n: "DuckDB · mart", d: lang === "en" ? "market_day, sector_day, monthly aggregates" : "market_day、sector_day、月度聚合" },
                { n: lang === "en" ? "App" : "应用层", d: lang === "en" ? "Flask API / single-file static export" : "Flask API / 单文件静态导出" },
              ].map((s, i) => (
                <div key={s.n} className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
                  <span className="mono mt-[1px] text-[11px] text-[var(--faint)]">0{i + 1}</span>
                  <div>
                    <div className="text-[13px] text-[var(--text)]">{s.n}</div>
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--muted)]">{s.d}</div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="col-span-12 xl:col-span-5">
          <Card title={lang === "en" ? "Snapshot status" : "数据状态"}>
            <div className="grid grid-cols-2 gap-3">
              {[
                { k: lang === "en" ? "Source" : "数据源", v: source },
                { k: lang === "en" ? "Version" : "版本", v: version },
                { k: lang === "en" ? "First date" : "起始日", v: meta?.first_trade_date || "—" },
                { k: lang === "en" ? "Last date" : "截止日", v: meta?.last_trade_date || "—" },
                { k: lang === "en" ? "Sessions" : "交易日", v: meta?.n_days ?? "—" },
                { k: lang === "en" ? "Stocks" : "最新股票数", v: meta?.n_stocks ?? "—" },
                { k: lang === "en" ? "Universe" : "股票池", v: "SSE+SZSE" },
                { k: lang === "en" ? "Data quality" : "数据质量", v: dataQuality ? (partialDays ? `partial · ${partialDays}D` : "ok") : "—" },
              ].map((s) => (
                <div key={s.k} className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
                  <MicroLabel>{s.k}</MicroLabel>
                  <div className="mono mt-1 text-[13px] text-[var(--text)]">{s.v}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-[var(--warn)]/30 bg-[var(--warn)]/5 px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--muted)]">
              {lang === "en"
                ? "Industry labels use current static mappings, not historical membership. Stocks without a known listing date are excluded. A 5% price limit is not proof of historical ST status. Optional event data may be unavailable; missing values stay unknown."
                : "行业使用当前静态映射，并非历史时点成员；缺上市日期的股票不进入指标样本。5%价格限制不等于历史ST身份。可选事件数据可能因权限缺失，缺失值保持未知。"}
            </div>
            {unavailable.length ? (
              <div className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted)]">
                {lang === "en" ? "Unavailable datasets: " : "当前不可用数据集："}
                <span className="mono text-[var(--text-2)]">{unavailable.join(" / ")}</span>
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      <Card
        title={lang === "en" ? "Quality gates" : "质量门禁"}
        subtitle={
          quality
            ? `${quality.date} · ${quality.rows} rows · ${
                quality.passed
                  ? lang === "en"
                    ? "all blocking checks passed (latest day only)"
                    : "阻断级检查全部通过（仅当日）"
                  : lang === "en"
                    ? "blocking failures"
                    : "存在阻断项"
              }`
            : lang === "en"
              ? "no report yet (missing quality file is reported, not hidden)"
              : "暂无报告（质量文件缺失会显式提示，不静默通过）"
        }
        right={
          <span className="pill h-[24px] px-2 text-[11px]">
            {quality ? `${gatesPassed}/${gates.length}` : "—"}
          </span>
        }
        padded={false}
        bodyClass="pt-0"
      >
        {gates.length ? (
          <div className="grid grid-cols-1 gap-1.5 px-4 pb-3 sm:grid-cols-3">
            {gates.map((g) => (
              <div key={g.id} title={g.message} className="flex items-center gap-2 rounded-md bg-[var(--panel-2)] px-2.5 py-[6px]">
                <span className="mono w-3 text-[11px] text-[var(--faint)]">{g.id}</span>
                <span
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ background: g.pass ? "var(--down)" : g.level === "block" ? "var(--up)" : "var(--warn)" }}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-2)]">
                  {lang === "en" ? g.name : GATE_ZH[g.id] ?? g.name}
                </span>
                <span className="mono text-[11px] text-[var(--muted)]">{fmtGate(g)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 pb-3 text-[12px] text-[var(--muted)]">
            {lang === "en" ? "No gate report available for the latest session." : "最新交易日暂无门禁报告。"}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-7">
          <Card
            title={lang === "en" ? "Update log" : "更新日志"}
            subtitle={
              lang === "en"
                ? `Last update records (${updates?.length ?? 0} available, up to 30 shown)`
                : `最近更新记录（共 ${updates?.length ?? 0} 条，最多显示 30 条）`
            }
            right={<span className="pill h-[24px] px-2 text-[11px]">{updates?.length ?? 0}</span>}
            padded={false}
            bodyClass="pt-0"
          >
            <div className="max-h-[260px] overflow-y-auto px-4 pb-3">
              <table className="w-full border-collapse text-[11.5px]">
                <thead className="sticky top-0 bg-[var(--panel)]">
                  <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--faint)]">
                    <th className="py-1.5 font-medium">{lang === "en" ? "Date" : "日期"}</th>
                    <th className="font-medium">{lang === "en" ? "Status" : "状态"}</th>
                    <th className="text-right font-medium">{lang === "en" ? "Days" : "天数"}</th>
                    <th className="text-right font-medium">{lang === "en" ? "Sec" : "耗时"}</th>
                    <th className="text-right font-medium">{lang === "en" ? "Warn" : "告警"}</th>
                  </tr>
                </thead>
                <tbody>
                  {(updates ?? []).map((u) => (
                    <tr key={u.date} className="border-t border-[var(--border)]">
                      <td className="mono py-[5px] text-[var(--text-2)]">{u.date}</td>
                      <td>
                        <span
                          className="inline-block h-[5px] w-[5px] rounded-full"
                          style={{ background: u.status === "ok" ? "var(--down)" : "var(--warn)" }}
                        />
                        <span className="ml-1.5 text-[var(--muted)]">{u.status}</span>
                      </td>
                      <td className="mono text-right text-[var(--text-2)]">{u.days}</td>
                      <td className="mono text-right text-[var(--text-2)]">{u.duration ?? "—"}</td>
                      <td className="mono text-right text-[var(--muted)]">{u.warnings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!updates?.length && (
                <div className="py-4 text-[12px] text-[var(--muted)]">{lang === "en" ? "No update records available." : "暂无更新记录。"}</div>
              )}
            </div>
          </Card>
        </div>
        <div className="col-span-12 xl:col-span-5">
          <Card
            title={lang === "en" ? "Source reconciliation" : "源间对账"}
            subtitle={
              reconcile
                ? `${reconcile.generated_at ?? "—"} · ${
                    reconcileVerifiable
                      ? lang === "en"
                        ? `${reconcile.stocks ?? "—"} stocks × ${reconcileDays ?? "—"} days = ${reconcile.pairs} pairs`
                        : `${reconcile.stocks ?? "—"} 只 × ${reconcileDays ?? "—"} 日 = ${reconcile.pairs} 对`
                      : lang === "en"
                        ? "unverifiable (0 pairs)"
                        : "不可验证（0 对样本）"
                  }`
                : lang === "en"
                  ? "no reconciliation snapshot"
                  : "暂无对账快照"
            }
            right={<span className="pill h-[24px] px-2 text-[11px]">QA</span>}
          >
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { k: lang === "en" ? "Pairs" : "样本对", v: reconcileVerifiable ? `${reconcile?.pairs}` : "—" },
                { k: "MAE (pp)", v: reconcileVerifiable ? `${reconcile?.mae_pp ?? "—"}` : "—" },
                { k: "P95 (pp)", v: reconcileVerifiable ? `${reconcile?.p95_pp ?? "—"}` : "—" },
                { k: "Max (pp)", v: reconcileVerifiable ? `${reconcile?.max_pp ?? "—"}` : "—" },
              ].map((x) => (
                <div key={x.k} className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2">
                  <MicroLabel>{x.k}</MicroLabel>
                  <div className="mono mt-1 text-[14px] text-[var(--text)]">{x.v}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
              {lang === "en"
                ? "Sampled cross-check only; Tushare remains the primary source. Differences above 0.1pp are flagged. A snapshot date older than the data date is shown, never implied to be current."
                : "仅抽样交叉校验，主源仍是 Tushare；差异 >0.1pp 会被标记。快照日期早于数据日期时会直接显示，不暗示“当日已对账”。"}
            </p>
          </Card>
        </div>
      </div>

      {/* W14-03/W14-04：数据许可、免责声明与已知限制（与仓库 NOTICE / docs/known_limitations.md 对齐）。 */}
      <Card
        title={lang === "en" ? "Data licence, disclaimer and known limitations" : "数据许可、免责与已知限制"}
        subtitle={lang === "en" ? "What this data may be used for, and where it is known to be incomplete" : "数据可用范围，以及已知不完整之处"}
      >
        <div className="flex flex-col gap-3 text-[12px] leading-relaxed text-[var(--text-2)]">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
            <div className="font-semibold text-[var(--text)]">{lang === "en" ? "Data licence" : "数据许可"}</div>
            <p className="mt-1 text-[var(--muted)]">
              {lang === "en"
                ? "Market data comes from Tushare Pro. Users must hold their own valid Tushare permissions and must not redistribute raw data. The MIT licence on this repository covers the software only, not the bundled data or screenshots. Screenshots in the docs are for demonstration only."
                : "行情数据来自 Tushare Pro。使用者须自行持有合法的 Tushare 权限，不得再分发原始数据。本仓库的 MIT 许可证只覆盖软件，不覆盖内置行情数据与截图；文档中的截图仅作演示。"}
            </p>
            {/*
              离线单文件包没有可路由的 NOTICE 文件（Flask 只服务 dist/，file:// 亦然），
              因此这里用自包含段落披露；完整条款见仓库根目录 NOTICE 与 docs/known_limitations.md。
            */}
            <p className="mt-1 text-[11px] text-[var(--faint)]">
              {lang === "en" ? "Full text: NOTICE and docs/known_limitations.md in the repository." : "完整条款见仓库根目录 NOTICE 与 docs/known_limitations.md。"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
            <div className="font-semibold text-[var(--text)]">{lang === "en" ? "Disclaimer" : "免责声明"}</div>
            <p className="mt-1 text-[var(--muted)]">
              {lang === "en"
                ? "This tool is for research and educational reference only. It is not investment advice, and data may differ from the exchanges or other vendors. Use at your own risk."
                : "本工具仅供研究与学习参考，不构成投资建议；数据可能与交易所或其它数据商不一致。据此操作风险自负。"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
            <div className="font-semibold text-[var(--text)]">{lang === "en" ? "Known limitations" : "已知限制"}</div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--muted)]">
              <li>
                {lang === "en"
                  ? "ST 5%/10% limit band: since 2026-07-06 the upstream stk_limit source returns a 10% band for former ST stocks; 5% band counts are not trustworthy in that window (no fabricated backfill)."
                  : "ST 5%/10% 档位：2026-07-06 起上游 stk_limit 对原 ST 股返回 10% 档，该窗口内 5% 档计数不可信（未伪造回补）。"}
              </li>
              <li>
                {lang === "en"
                  ? "Margin data only aggregates SSE+SZSE; any missing exchange day outputs NULL instead of a partial sum (T+1 latest day may also be empty)."
                  : "两融仅汇总 SSE+SZSE；任一交易所缺失当日输出 NULL，不给部分和（T+1 最新日也可能为空）。"}
              </li>
              <li>
                {lang === "en"
                  ? "History repair: 192 partial trading days were backfilled; the data-quality metadata below records what remains partial. Weight-based metrics stay unknown on partial days."
                  : "历史回补：192 个部分交易日已回补；剩余 partial 情况记录在下方数据质量元信息中。partial 日的权重类指标保持未知。"}
              </li>
              <li>
                {lang === "en"
                  ? "Three delisted codes (000022/000043/300114) are retained as-is in the source snapshot and may still appear in historical rows."
                  : "三个退市代码（000022/000043/300114）按源快照保留，历史行中可能仍会出现。"}
              </li>
              <li>
                {lang === "en"
                  ? "Industry labels use current static mappings, not historical membership; official limit-list coverage is partial over history."
                  : "行业使用当前静态映射，不是历史时点成员；官方涨停名单在历史上覆盖不完整。"}
              </li>
            </ul>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
            <div className="font-semibold text-[var(--text)]">{lang === "en" ? "Payload metadata" : "载荷元信息"}</div>
            <div className="mt-1 grid grid-cols-1 gap-1 text-[var(--muted)] sm:grid-cols-2">
              <div>
                {lang === "en" ? "data_quality.n_partial_days" : "data_quality.n_partial_days"}:{" "}
                <span className="mono text-[var(--text-2)]">{partialDays ?? "—"}</span>
              </div>
              <div>
                {lang === "en" ? "data_quality.repaired_at" : "data_quality.repaired_at"}:{" "}
                <span className="mono text-[var(--text-2)]">{dataQuality?.repaired_at ?? "—"}</span>
              </div>
              <div>
                {lang === "en" ? "meta.version" : "meta.version"}: <span className="mono text-[var(--text-2)]">{meta?.version ?? "—"}</span>
              </div>
              <div>
                {lang === "en" ? "warnings" : "meta.warnings"}: <span className="mono text-[var(--text-2)]">{warnings.length}</span>
              </div>
            </div>
            {partialList.length ? (
              <div className="mt-1 text-[11.5px] text-[var(--muted)]">
                {lang === "en" ? "Partial days (first 8): " : "partial 交易日（前 8 个）："}
                <span className="mono text-[var(--text-2)]">{partialList.join(" · ")}</span>
              </div>
            ) : null}
            {warnings.length ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-[11.5px] text-[var(--accent)]">
                  {lang === "en" ? `Show ${warnings.length} source warnings` : `展开 ${warnings.length} 条源告警`}
                </summary>
                <ul className="mt-1 max-h-[160px] list-disc space-y-0.5 overflow-y-auto pl-5 text-[11px] text-[var(--muted)]">
                  {warnings.map((w, i) => (
                    <li key={`${i}-${w.slice(0, 12)}`} className="mono break-all">{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      </Card>

      <Card
        title={lang === "en" ? "Metric definitions" : "指标口径"}
        subtitle={lang === "en" ? "Core metrics from marts; display aggregation follows the metric contract" : "核心指标来自分析表；展示聚合遵循指标契约"}
        padded={false}
        bodyClass="pt-0"
      >
        <div className="overflow-x-auto px-4 pb-3">
          <table className="w-full min-w-[560px] border-collapse text-[12px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--faint)]">
                <th className="py-2 font-medium">{lang === "en" ? "Metric" : "指标"}</th>
                <th className="font-medium">{lang === "en" ? "Field" : "字段"}</th>
                <th className="font-medium">{lang === "en" ? "Definition" : "定义"}</th>
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => (
                <tr key={m.k} className="border-t border-[var(--border)]">
                  <td className="py-[7px] text-[12.5px] text-[var(--text)]">{lang === "en" ? m.en : m.zh}</td>
                  <td className="mono text-[11px] text-[var(--faint)]">{m.k}</td>
                  <td className="text-[12px] text-[var(--muted)]">{zh ? m.f : METRIC_EN[m.k]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="flex items-center justify-between pb-2 text-[11.5px] text-[var(--faint)]">
        <span>Ashare Radar {version} · DuckDB + Flask + React + ECharts</span>
        <span className="mono">data → lake → marts → app</span>
      </div>
    </div>
  );
}
