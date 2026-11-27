/**
 * D1 修复回归测试（Today / Market / Regime + charts.ts / charts2.ts / viewMetrics.ts）。
 *
 * 纯函数直接 import；图表 option 与 TSX 组件用 typescript.transpileModule 转译后调用，
 * 输入构造数据/真实 payload 抽取值（见各断言注释），不启动浏览器。
 */
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as echarts from "echarts";

import {
  coverageGaps,
  cumulativeReturn,
  displaySource,
  mostConcentratedDay,
  pickRange,
  staleBanner,
  staleBannerText,
  statusKind,
  topGainers,
} from "../src/lib/viewMetrics.ts";

// format.ts / charts.ts 在模块顶层读 window/localStorage，先打桩再动态 import 转译产物
globalThis.window = { location: { search: "" } };
globalThis.localStorage = { getItem: () => null };

const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), "ashare-radar-d1-test-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));

function transpile(name, extension = "ts") {
  const source = readFileSync(join(frontend, "src", extension === "tsx" ? "components" : "lib", `${name}.${extension}`), "utf8");
  const result = ts.transpileModule(source, {
    fileName: `${name}.${extension}`,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // classic JSX 只生成 React.createElement（组件函数不执行），避免在临时目录解析 react/jsx-runtime
      ...(extension === "tsx" ? { jsx: ts.JsxEmit.React } : {}),
    },
  }).outputText;
  writeFileSync(
    join(temporary, `${name}.mjs`),
    result.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, "$1$2.mjs$3"),
  );
}

for (const name of ["charts", "charts2", "theme", "format", "html", "regime"]) transpile(name);
transpile("Sparkline", "tsx");
writeFileSync(
  join(temporary, "index.mjs"),
  ["charts", "charts2", "theme", "format", "html", "regime"].map((name) => `export * from './${name}.mjs';`).join("\n"),
);
const lib = await import(pathToFileURL(join(temporary, "index.mjs")));
const sparkline = await import(pathToFileURL(join(temporary, "Sparkline.mjs")));

const dark = lib.paletteFor("dark", false);
const light = lib.paletteFor("light", false);
const colorblind = lib.paletteFor("dark", true);

/** 2026-11-26 是周四；11-27 周五、11-28 周六、11-29 周日、11-30 周一（与审核基准一致）。 */
const shanghai = (iso) => Date.parse(iso);
const FRI_NOON = shanghai("2026-11-27T04:00:00Z");
const SAT_NOON = shanghai("2026-11-28T04:00:00Z");
const SUN_NOON = shanghai("2026-11-29T04:00:00Z");
const MON_NOON = shanghai("2026-11-30T04:00:00Z");
const MON_2200 = shanghai("2026-11-30T14:00:00Z");

const dayOf = (index) => new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
const marketRow = (index, overrides = {}) => ({
  trade_date: dayOf(index),
  n_valid: 5200,
  n_adv: 2600,
  n_dec: 2500,
  breadth: 0.5,
  ew_ret: 0.001,
  cw_ret: 0.001,
  top10_share: 0.1 + (index % 5) * 0.01,
  gain_share_top5pct: 0.3,
  hhi: 50,
  csd: 0.0279,
  iqr: 0.0249,
  amount: 1.3e12,
  hs300_ret: 0.0006,
  ...overrides,
});
const sector = (overrides = {}) => ({
  sw_l1: "合成",
  ew_ret: 0.01,
  breadth: 0.6,
  amount: 1e9,
  n: 100,
  iqr: 0.02,
  ...overrides,
});

/* ------------------------------------------------------------------ W7-01 */

test("W7-01 今日三件事按 EW 收益降序 + 行业名 tie-break 显式排序（静态/API 一致）", () => {
  // 静态 payload 的 sectors 顺序是 sw_l1（交通运输/传媒在前），API 顺序是 ew_ret DESC；前端必须自己定序
  const sectors = [
    { sw_l1: "交通运输", ew_ret: -0.0016, breadth: 0.4528 },
    { sw_l1: "传媒", ew_ret: -0.0083, breadth: 0.2786 },
    { sw_l1: "煤炭", ew_ret: 0.0247, breadth: 1.0 },
    { sw_l1: "石油石化", ew_ret: 0.0132, breadth: 0.7297 },
    { sw_l1: "银行", ew_ret: 0.0097, breadth: 1.0 },
  ];
  assert.deepEqual(topGainers(sectors, 2).map((s) => s.sw_l1), ["煤炭", "石油石化"]);
  // payload 行序变化不影响结果
  assert.deepEqual(topGainers([...sectors].reverse(), 2).map((s) => s.sw_l1), ["煤炭", "石油石化"]);
  // 同收益按行业名（码位）稳定定序
  const tied = [
    { sw_l1: "B行业", ew_ret: 0.01 },
    { sw_l1: "A行业", ew_ret: 0.01 },
    { sw_l1: "C行业", ew_ret: 0.02 },
  ];
  assert.deepEqual(topGainers(tied, 2).map((s) => s.sw_l1), ["C行业", "A行业"]);
  assert.deepEqual(topGainers([], 2), []);
});

/* ------------------------------------------------------------------ W7-02 */

test("W7-02 最集中日取该日 CSD，缺失 top10_share 的行不参与比较", () => {
  // 1Y 真实数字：最集中日 2026-10-21 top10=20.6%，当日 CSD 2.41pp（区间均值 2.95pp）
  const rows = [
    { trade_date: "2026-11-26", top10_share: 0.135261, csd: 0.027915 },
    { trade_date: "2026-10-21", top10_share: 0.205876, csd: 0.024102 },
    { trade_date: "2026-01-05", top10_share: null, csd: null },
  ];
  const maxC = mostConcentratedDay(rows);
  assert.equal(maxC.trade_date, "2026-10-21");
  assert.equal(`${(maxC.csd * 100).toFixed(2)}pp`, "2.41pp");
  // 旧实现会把 null 当 0；全为 null 时必须返回 null（页面显示 —）
  assert.equal(mostConcentratedDay([{ trade_date: "x", top10_share: null }]), null);
  assert.equal(mostConcentratedDay([]), null);
  assert.equal(mostConcentratedDay([{ trade_date: "x", top10_share: Number.NaN }]), null);
});

/* ------------------------------------------------------------------ W6-02 */

test("W6-02 集中度 5 日分组按最新交易日右对齐，切换区间末柱不漂移", () => {
  const rows = Array.from({ length: 250 }, (_, i) => marketRow(i));
  // 末 5 日 Top10 依次 1/2/3/4/5% → 均值 3%，右对齐后 3M 与 1Y 的末柱都应是 3
  rows.forEach((row, i) => {
    if (i >= rows.length - 5) row.top10_share = (i - (rows.length - 5) + 1) / 100;
  });
  const oneYear = lib.concentrationChart(dark, rows.slice(-250), "en");
  const threeMonth = lib.concentrationChart(dark, rows.slice(-66), "en");
  assert.equal(oneYear.series[0].data.at(-1), 3);
  assert.equal(threeMonth.series[0].data.at(-1), 3);
  // 3M 的 66 行 % 5 = 1：最旧一组只有 1 日，但末组仍是完整 5 日
  assert.equal(threeMonth.series[0].data.length, 14);
  const zoomed = lib.concentrationChart(dark, rows.slice(-66), "en", { pan: true });
  assert.equal(zoomed.xAxis.data.length, 14);
  // tooltip 中的组内交易日数：末组 = 5
  const html = zoomed.tooltip.formatter([{ axisValue: rows.at(-1).trade_date }]);
  assert.match(html, /5 session avg/);
});

test("W6-02 20 日均线用区间前 19 行预热，短区间开头不再缺线", () => {
  const rows = Array.from({ length: 20 }, (_, i) => marketRow(i, { top10_share: 0.2 }));
  const lead = Array.from({ length: 19 }, (_, i) => marketRow(300 + i, { top10_share: 0.1 }));
  const cold = lib.concentrationChart(dark, rows, "en");
  assert.equal(cold.series[1].data[0], null);
  const warm = lib.concentrationChart(dark, rows, "en", undefined, { lead });
  // 首个 5 日均值组 = 区间前 19 行中的末 15 行(10%) + 区间前 5 行(20%) → 12.5%
  assert.equal(warm.series[1].data[0], 12.5);
  // 预热不改变分组数量/日期
  assert.deepEqual(warm.xAxis.data, cold.xAxis.data);
});

/* ------------------------------------------------------------------ W6-01 */

test("W6-01 data_quality=partial 的组有标记与 tooltip 说明；字段缺失保持旧行为", () => {
  const rows = Array.from({ length: 5 }, (_, i) => marketRow(i));
  rows[2].data_quality = "partial";
  const marked = lib.concentrationChart(dark, rows, "en");
  const bar = marked.series[0].data[0];
  assert.equal(typeof bar, "object");
  assert.equal(bar.itemStyle.color, dark.copper);
  // 整组用浅色带标出（即使契约把 partial 日的 top10_share 置 NULL、柱缺失也能看出）
  assert.equal(marked.series[0].markArea.data.length, 1);
  assert.deepEqual(marked.series[0].markArea.data[0], [{ xAxis: -0.5 }, { xAxis: 0.5 }]);
  const html = marked.tooltip.formatter([{ axisValue: rows.at(-1).trade_date }]);
  assert.match(html, /partial/i);
  // partial 日 top10_share 为 NULL（新契约）：柱缺失但浅色带仍在，且 ECharts SSR 不报 NaN
  const nulled = rows.map((row, i) => (i === 2 ? { ...row, top10_share: null } : row));
  const holes = lib.concentrationChart(dark, nulled, "en");
  assert.equal(holes.series[0].data[0], null);
  assert.equal(holes.series[0].markArea.data.length, 1);
  for (const option of [marked, holes]) {
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 260 });
    try {
      chart.setOption({ ...option, animation: false });
      const svg = chart.renderToSVGString();
      assert.ok(svg.startsWith("<svg"));
      assert.ok(!svg.includes("NaN"));
    } finally {
      chart.dispose();
    }
  }
  // 旧离线包没有 data_quality 字段：仍然渲染纯数值柱，不误报
  const plain = lib.concentrationChart(dark, rows.map(({ data_quality, ...row }) => row), "en");
  assert.equal(typeof plain.series[0].data[0], "number");
  assert.equal(plain.series[0].markArea, undefined);
  assert.doesNotMatch(plain.tooltip.formatter([{ axisValue: rows.at(-1).trade_date }]), /partial/i);
});

test("W6-01/W6-15 集中度纵轴自适应且保留 0 基线；缩放模式交给 ECharts 按窗口自适应", () => {
  const calm = Array.from({ length: 250 }, (_, i) => marketRow(i, { top10_share: 0.13 }));
  const calmAxis = lib.concentrationChart(dark, calm, "en").yAxis;
  assert.equal(calmAxis.min, 0);
  assert.equal(calmAxis.max, 30); // 正常区间不再固定 0–100% 压到 1/7
  const spikyRows = Array.from({ length: 250 }, (_, i) =>
    marketRow(i, { top10_share: i >= 100 && i < 105 ? 0.62 : 0.13 }),
  );
  const spikyMax = lib.concentrationChart(dark, spikyRows, "en").yAxis.max;
  assert.ok(spikyMax >= 62 && spikyMax <= 100, `spike 必须完整可见，实际 max=${spikyMax}`);
  const zoomed = lib.concentrationChart(dark, calm, "en", { pan: true }).yAxis;
  assert.equal(zoomed.min, 0);
  assert.equal(zoomed.max, undefined); // filterMode=filter 时由窗口数据自适应
});

/* ------------------------------------------------------------------ W6-05 / W6-08 / W6-11 */

test("W6-05 象限色与契约一致：ew_ret == 0 归左半（breadth<50% 为普跌）", () => {
  const option = lib.sectorBubble(dark, [
    sector({ sw_l1: "零点跌破", ew_ret: 0, breadth: 0.4 }),
    sector({ sw_l1: "零点横盘", ew_ret: 0, breadth: 0.6 }),
    sector({ sw_l1: "上涨普涨", ew_ret: 0.01, breadth: 0.6 }),
    sector({ sw_l1: "上涨集中", ew_ret: 0.01, breadth: 0.4 }),
  ], "en");
  const colors = Object.fromEntries(option.series[0].data.map((point) => [point.name, point.itemStyle.color]));
  assert.equal(colors["零点跌破"], dark.down);
  assert.equal(colors["零点横盘"], dark.muted);
  assert.equal(colors["上涨普涨"], dark.up);
  assert.equal(colors["上涨集中"], dark.copper);
});

test("W6-08 气泡面积与成交额成比例（无加性常数）", () => {
  const option = lib.sectorBubble(dark, [
    sector({ sw_l1: "大", amount: 100 }),
    sector({ sw_l1: "小", amount: 1 }),
    sector({ sw_l1: "零", amount: 0 }),
  ], "en");
  const size = option.series[0].symbolSize;
  const big = size([0, 50, 100, 10, 1]);
  const small = size([0, 50, 1, 10, 1]);
  assert.equal(big, 28);
  assert.ok(Math.abs(small - 2.8) < 1e-9);
  assert.ok(Math.abs((big / small) ** 2 - 100) < 1e-9); // 面积比 = 成交额比
  assert.equal(size([0, 50, 0, 10, 1]), 0);
});

test("W6-11 tooltip 的 breadth 保留 1 位小数（49.5–49.99% 不再显示 50%）", () => {
  const sectorHtml = lib.sectorBubble(dark, [sector({ breadth: 0.499 })], "en").tooltip.formatter({
    data: { name: "合成", value: [1, 49.9, 1e8, 30, 2] },
  });
  assert.match(sectorHtml, /49\.9%/);
  const scatterHtml = lib.regimeScatter(dark, [marketRow(0, { breadth: 0.498907, ew_ret: 0.0001 })], null, "en")
    .tooltip.formatter({ data: { value: [0.01, 49.8907, 1e8, 0.02], rawRet: 0.01, rawBreadth: 49.8907, trade_date: "2025-11-17", regime: "Narrow rally" } });
  assert.match(scatterHtml, /49\.9%/);
  assert.doesNotMatch(scatterHtml, /50%/);
});

/* ------------------------------------------------------------------ W6-04 / W6-14 */

test("W6-04 regimeColor 从 Palette 派生（色盲/浅色主题不再写死红绿）", () => {
  assert.equal(lib.regimeColor("broad_up", dark), dark.up);
  assert.equal(lib.regimeColor("concentrated_up", dark), dark.copper);
  assert.equal(lib.regimeColor("broad_down", dark), dark.down);
  assert.equal(lib.regimeColor("mixed", dark), dark.muted);
  assert.equal(lib.regimeColor("unknown", dark), dark.faint);
  assert.equal(lib.regimeColor("broad_up", colorblind), colorblind.up);
  assert.notEqual(lib.regimeColor("broad_up", colorblind), "#e5484d");
  assert.equal(lib.regimeColor("broad_up", light), light.up);
});

test("W6-14 图例渐变与 tone 曲线同源采样：0% 处为沙色，±3% 饱和为涨/跌色", () => {
  const sand = lib.regimeSand(dark);
  assert.equal(lib.regimeToneColor(0, dark), sand);
  const stops = lib.regimeLegendGradient(dark).match(/#[0-9a-f]{6}/g);
  assert.equal(stops.length, 5);
  assert.equal(stops[0], dark.down);
  assert.equal(stops[2], sand);
  assert.equal(stops[4], dark.up);
  // 散点 0% 收益的点颜色也就是沙色（旧实现是偏红的 #bc6c44）
  const option = lib.regimeScatter(dark, [marketRow(0, { ew_ret: 0 })], null, "en");
  assert.equal(option.series[1].data[0].itemStyle.color, sand);
});

/* ------------------------------------------------------------------ W6-15 */

test("W6-15 ALL 区间缩放最小窗口约 12 个交易日（下限 0.4%）", () => {
  const rows = Array.from({ length: 2425 }, (_, i) => marketRow(i));
  const option = lib.returnBreadth(dark, rows, "en", { pan: true });
  const minSpan = option.dataZoom[0].minSpan;
  const sessions = (minSpan / 100) * rows.length;
  assert.ok(sessions >= 11.5 && sessions <= 12.5, `minSpan=${minSpan}% → ${sessions} 日`);
});

/* ------------------------------------------------------------------ W7-04 */

test("W7-04 覆盖不足披露使用 data_quality 优先、旧包退回 n_valid 低样本启发式（不硬编码天数）", () => {
  // 旧 payload：无 data_quality → 用区间中位数一半识别（示例 100 天中 1 天只有 100 只）
  const legacy = Array.from({ length: 100 }, (_, i) => ({ n_valid: 5000 }));
  legacy[7].n_valid = 100;
  const legacyGap = coverageGaps(legacy);
  assert.equal(legacyGap.partial, 0);
  assert.equal(legacyGap.lowSample, 1);
  assert.equal(legacyGap.total, 1);
  assert.equal(legacyGap.minNValid, 100);
  assert.equal(legacyGap.flagged, true);
  assert.equal(coverageGaps(legacy.filter((row) => row.n_valid === 5000)).flagged, false);
  // 新 payload：data_quality='partial' 权威，不再叠加启发式
  const modern = [
    { n_valid: 5000, data_quality: "ok" },
    { n_valid: 100, data_quality: "partial" },
    { n_valid: 200, data_quality: "ok" },
  ];
  const modernGap = coverageGaps(modern);
  assert.equal(modernGap.partial, 1);
  assert.equal(modernGap.lowSample, 0);
  assert.equal(modernGap.total, 1);
  assert.equal(coverageGaps([]).flagged, false);
});

/* ------------------------------------------------------------------ W5-09 */

test("W5-09 区间累计：任一日收益缺失/不可用则整体未知，不把缺日当平盘", () => {
  assert.ok(Math.abs(cumulativeReturn([0.1, 0.1]) - 0.21) < 1e-12);
  assert.equal(cumulativeReturn([0.1, null, 0.1]), null);
  assert.equal(cumulativeReturn([0.1, Number.NaN, 0.1]), null);
  assert.equal(cumulativeReturn([0.1, -1]), null);
  assert.equal(cumulativeReturn([]), null);
});

/* ------------------------------------------------------------------ W7-11 */

test("W7-11 非法 range 参数回退默认区间", () => {
  const allowed = ["3M", "6M", "1Y", "3Y", "ALL"];
  assert.equal(pickRange("FOO", allowed, "1Y"), "1Y");
  assert.equal(pickRange(null, allowed, "1Y"), "1Y");
  assert.equal(pickRange(undefined, allowed, "3Y"), "3Y");
  assert.equal(pickRange("3Y", allowed, "1Y"), "3Y");
});

/* ------------------------------------------------------------------ W7-12 / W7-03 */

test("W7-12 状态栏：meta/quality 都取不到是错误态，加载中不闪错误，warning 是告警态", () => {
  assert.equal(statusKind({ meta: null, quality: null, gates: [], metaError: true, qualityError: true }), "error");
  assert.equal(statusKind({ meta: null, quality: null, gates: [], metaError: true, qualityError: true, pending: true }), "loading");
  assert.equal(statusKind({ meta: null, quality: null, gates: [], pending: true }), "loading");
  assert.equal(
    statusKind({ meta: { status: "ok", warnings: [] }, quality: { passed: true }, gates: [{ pass: true }] }),
    "ok",
  );
  assert.equal(
    statusKind({ meta: { status: "ok", warnings: ["events unavailable"] }, quality: { passed: true }, gates: [{ pass: true }] }),
    "warn",
  );
  assert.equal(statusKind({ meta: { status: "stale" }, quality: { passed: true }, gates: [] }), "stale");
  assert.equal(statusKind({ meta: { status: "failed" }, quality: null, gates: [] }), "stale");
});

test("W7-03 数据源展示过滤 unavailable 占位值", () => {
  assert.equal(displaySource("tushare, unavailable"), "tushare");
  assert.equal(displaySource("tushare, unavailable, akshare"), "tushare, akshare");
  assert.equal(displaySource("unavailable"), "—");
  assert.equal(displaySource(null), "—");
});

/* ------------------------------------------------------------------ W5-05 */

test("W5-05 数据年龄横幅按交易日/更新时间判断，周末读周五数据不再误报", () => {
  // 周四数据 + 周五中午：正常（今晚才更新），不提示
  assert.equal(staleBanner("2026-11-26", FRI_NOON), null);
  // 周五数据 + 周日中午：只跨周末且未到更新窗口 → 不提示
  assert.equal(staleBanner("2026-11-27", SUN_NOON), null);
  // 周四数据 + 周五中午：周三之后缺周四 → 真断供
  assert.deepEqual(staleBanner("2026-11-25", FRI_NOON), { days: 2, reason: "gap" });
  // 周四数据 + 周六中午：缺周五的交易日 → 提示
  assert.deepEqual(staleBanner("2026-11-26", SAT_NOON), { days: 2, reason: "gap" });
  // 周五数据 + 周一中午：开盘日盘中，尚未到更新窗口 → 不提示
  assert.equal(staleBanner("2026-11-27", MON_NOON), null);
  // 周五数据 + 周一 21:40（实际更新在 21:45 左右）：尚未到判定期 → 不提示
  assert.equal(staleBanner("2026-11-27", shanghai("2026-11-30T13:40:00Z")), null);
  // 周五数据 + 周一 22:00（上海已过更新判定期）：今日数据尚未更新 → 提示
  assert.deepEqual(staleBanner("2026-11-27", MON_2200), { days: 3, reason: "today-missing" });
  // 同日/未来日期/空值：不提示
  assert.equal(staleBanner("2026-11-27", FRI_NOON), null);
  assert.equal(staleBanner(null, FRI_NOON), null);
  // 文案：英文单数、中文语义
  assert.match(staleBannerText({ days: 1, reason: "gap" }, "2026-11-26", "en"), /1 calendar day ago/);
  assert.doesNotMatch(staleBannerText({ days: 1, reason: "gap" }, "2026-11-26", "en"), /1 calendar days/);
  assert.match(staleBannerText({ days: 2, reason: "gap" }, "2026-11-25", "zh"), /休市日/);
  assert.match(staleBannerText({ days: 3, reason: "today-missing" }, "2026-11-27", "zh"), /今日数据尚未更新/);
});

/* ------------------------------------------------------------------ W6-12 */

test("W6-12 Sparkline 过滤非有限值并在缺失处断线，英文 aria 文案", () => {
  const geometry = sparkline.sparklineGeometry([1, Number.NaN, 3, null, 5, 6], 84, 26);
  assert.equal(geometry.hasData, true);
  assert.ok(!geometry.line.includes("NaN"));
  // 两段有效数据被缺失切断：只有最后一段（索引 4-5）能构成折线，单点段被丢弃
  assert.equal((geometry.line.match(/M/g) ?? []).length, 1);
  assert.equal(geometry.lastValue, 6);
  assert.equal(geometry.firstValue, 1);
  assert.equal(geometry.lastPoint[0], 82); // width - pad
  // 空/单点/全缺失：返回空占位，不把 null 当 0 画线
  assert.equal(sparkline.sparklineGeometry([], 84, 26).hasData, false);
  assert.equal(sparkline.sparklineGeometry([5, null], 84, 26).hasData, false);
  assert.equal(sparkline.sparklineGeometry([null, null, null], 84, 26).hasData, false);
  // 整段有效时有面积填充
  assert.ok(sparkline.sparklineGeometry([1, 2, 3], 84, 26).area);
  // lang 文案
  assert.match(sparkline.sparklineLabel("en"), /last 20 sessions/);
  assert.match(sparkline.sparklineLabel("zh"), /近 20 个交易日走势/);
});

/* ------------------------------------------------------------------ W6-10 */

test("W6-10 死代码清理：regime 不再导出无人引用的 quadrants", () => {
  assert.equal("quadrants" in lib, false);
});
