/**
 * G 代理（测试/CI 收口）前端数据契约回归。
 *
 * 目的：把「后端新增字段 → api.ts 类型/运行时 → 页面消费」的契约固定下来，
 * 与 fix-d1/d2/d3 的单点修复测试互补（这里不重复其断言）：
 *   1) 静态 payload 的 mart_market_day 追加列（weight_coverage/n_valid_ratio/
 *      data_quality/margin_n_exchanges/n_extreme_ret）经 api.marketSeries / marketDay
 *      原样透传，不得被归一化丢弃；
 *   2) meta.version / meta.data_quality / unavailable_datasets 在静态模式下原样透传
 *      （Briefing 页脚与 About 已知限制的数据来源）；
 *   3) api.ts 源码保留契约字段声明（node 测试不跑 tsc，静态断言兜底类型回退）；
 *   4) 静态 K 线 7 元组按 qfq 标注、6 元组按未复权标注（P1-6 双路径口径）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";

const readSource = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
const sourceUrl = (relative) => new URL(relative, import.meta.url).href;

let seq = 0;
async function importTs(relative, rewrites = {}) {
  let source = await readSource(relative);
  for (const [from, to] of Object.entries(rewrites)) source = source.replace(from, to);
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(`${js}\n//${seq++}`).toString("base64")}`);
}

const day = {
  trade_date: "2026-11-26",
  n_valid: 5221,
  breadth: 0.3327,
  ew_ret: 0.001,
  weight_coverage: 0.9990423290557364,
  n_valid_ratio: 1.0007667241709794,
  data_quality: "partial",
  margin_n_exchanges: 0,
  n_extreme_ret: 2,
  limit_up_non5pct_n: 71,
  limit_up_5pct_n: 0,
};

const payload = {
  meta: {
    last_trade_date: day.trade_date,
    first_trade_date: "2016-12-01",
    updated_at: "2026-11-27T18:00:00+08:00",
    n_stocks: 5221,
    n_days: 2425,
    source: "tushare",
    status: "ok",
    warnings: [],
    version: "0.4.3",
    sources: { daily: "tushare" },
    unavailable_datasets: ["limit_list_d", "margin"],
    data_quality: {
      partial_days: ["2026-11-26"],
      n_partial_days: 1,
      repaired_at: "2026-11-27T10:30:00+08:00",
    },
  },
  market: [day],
  market_monthly: [],
  stocks: [],
  watch_pool: [],
  contrib: { [day.trade_date]: [] },
  sectors: { [day.trade_date]: [] },
  distribution: {},
  sector_monthly: [],
  stock_series: {
    // 除权日：原始价减半（100 → 50）、adj_factor 翻倍（1 → 2），前复权价连续为 50。
    "600519.SH": [
      ["2026-06-10", 50, 50.5, 49.5, 50, 1000, 1],
      ["2026-06-11", 50, 50.5, 49.5, 50, 1000, 2],
    ],
    "000001.SZ": [["2026-06-11", 10, 11, 9, 10, 1000]],
  },
};

async function staticApi(data) {
  globalThis.window = { __BL_DATA__: data };
  const cache = new Map();
  globalThis.localStorage = {
    getItem: (key) => cache.get(key) ?? null,
    setItem: (key, value) => cache.set(key, value),
  };
  const holdingsUrl = sourceUrl("../src/lib/holdings.ts");
  const module = await importTs("../src/lib/api.ts", { '"./holdings"': JSON.stringify(holdingsUrl) });
  return module.api;
}

/* ---------------------------------------------------------------- 1. 市场新列 */
test("静态 payload 的 mart_market_day 追加列经 marketSeries/marketDay 原样透传", async () => {
  const api = await staticApi(payload);
  const series = await api.marketSeries();
  assert.deepEqual(series, [day]);
  const detail = await api.marketDay(day.trade_date);
  for (const key of [
    "weight_coverage", "n_valid_ratio", "data_quality",
    "margin_n_exchanges", "n_extreme_ret", "limit_up_non5pct_n", "limit_up_5pct_n",
  ]) {
    assert.equal(detail[key], day[key], `静态 market 行缺少 ${key}`);
  }
  // null/0 语义不得被归一成"默认值"：partial 日权重列应为 null 而非 0
  const partial = { ...day, cw_ret: null, hhi: null, data_quality: "partial" };
  const apiPartial = await staticApi({ ...payload, market: [partial] });
  const row = (await apiPartial.marketSeries())[0];
  assert.equal(row.cw_ret, null);
  assert.equal(row.data_quality, "partial");
});

/* ---------------------------------------------------------------- 2. meta 字段 */
test("静态 payload 的 meta.version/data_quality/unavailable_datasets 原样透传", async () => {
  const api = await staticApi(payload);
  const meta = await api.meta();
  assert.equal(meta.version, "0.4.3");
  assert.deepEqual(meta.data_quality.partial_days, ["2026-11-26"]);
  assert.equal(meta.data_quality.n_partial_days, 1);
  assert.deepEqual(meta.unavailable_datasets, ["limit_list_d", "margin"]);
  assert.deepEqual(meta.sources, { daily: "tushare" });
});

/* ---------------------------------------------------------------- 3. 类型契约声明 */
test("api.ts 保留新增字段的类型声明（防类型回退）", async () => {
  const source = await readSource("../src/lib/api.ts");
  for (const field of [
    "weight_coverage", "n_valid_ratio", "data_quality",
    "margin_n_exchanges", "n_extreme_ret", "limit_up_non5pct_n", "limit_up_5pct_n",
  ]) {
    assert.match(source, new RegExp(`${field}\\?:`), `api.ts MarketDay 缺少 ${field}`);
  }
  assert.match(source, /data_quality\?: DataQualityMeta \| null/, "Meta 缺少 data_quality 声明");
  assert.match(source, /version\?: string \| null/, "Meta 缺少 version 声明");
  assert.match(source, /unavailable_datasets\?: string\[\]/, "Meta 缺少 unavailable_datasets 声明");
  assert.match(source, /export type MarketDataQuality = "ok" \| "partial"/, "缺少 data_quality 枚举");
});

/* ---------------------------------------------------------------- 4. 静态 K 线双口径 */
test("静态 K 线 7 元组标记 qfq 且可还原原始价，6 元组标记未复权", async () => {
  const api = await staticApi(payload);
  const bars = await api.stockSeries("600519.SH");
  assert.equal(bars.length, 2);
  assert.equal(bars[0].adjust, "qfq");
  assert.equal(bars[1].adjust, "qfq");
  // 前复权价连续（除权日无假跳空）；close_raw 按窗口最后 adj_factor 还原原始价。
  assert.equal(bars[0].close, 50);
  assert.equal(bars[1].close, 50);
  assert.equal(bars[0].close_raw, 100);
  assert.equal(bars[1].close_raw, 50);
  const legacy = await api.stockSeries("000001.SZ");
  assert.equal(legacy[0].adjust, "none");
  assert.equal(legacy[0].close, 10);
});
