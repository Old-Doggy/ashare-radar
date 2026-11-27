/**
 * D3 修复回归测试（Sentiment/Briefing/About/ChartLab/Shell + 全局 i18n/主题/api 类型）。
 *
 * 覆盖：
 *  1) P1-4/W9-03：新高新低坐标轴不再先截尾；轴域覆盖最新值、超界点保留真实值；
 *  2) W5-02/W14-10：非法主题有保底色板；浅色主题 faint/accent/copper 对比度 ≥4.5；
 *  3) W5-01：money() 实时跟随语言源（无需等下一次渲染）；
 *  4) W9-06/W14-14：版本串统一走 meta.version，页面不再硬编码 v0.3；
 *  5) W5-03/W5-04/W9-04/W5-07：api 归一（valuation/quality null、distribution 覆盖统计、静态缺集合报错）；
 *  6) W14-01/§3：所有 /api 请求带 X-Requested-With: ashare-radar；
 *  7) W14-09：<html lang> 同步；W14-08：Shell 为 briefing/labs 提供 title 兜底；
 *  8) W9-04/W9-13/W9-14/W9-24：ChartLab/Briefing 文案与数字口径；
 *  9) W7-07：CommandPalette 快捷键 hint 与 Shell 实现一致；
 * 10) 前端不伪造安全响应头（CSP 由服务端 after_request 负责，前端加 meta CSP 会破坏 SPA）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const readSource = (relative) => readFile(new URL(relative, import.meta.url), "utf8");
const sourceUrl = (relative) => new URL(relative, import.meta.url).href;

/* ------------------------------------------------------------------ */
/* 0. 工具：把 TS 文件转成可在 node 里 import 的 data: 模块            */
/* ------------------------------------------------------------------ */
let seq = 0;
async function importTs(relative, rewrites = {}) {
  let source = await readSource(relative);
  for (const [from, to] of Object.entries(rewrites)) source = source.replace(from, to);
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(`${js}\n//${seq++}`).toString("base64")}`);
}

async function staticApi(payload) {
  globalThis.window = { __BL_DATA__: payload };
  const cache = new Map();
  globalThis.localStorage = { getItem: (k) => cache.get(k) ?? null, setItem: (k, v) => cache.set(k, v) };
  const holdingsUrl = sourceUrl("../src/lib/holdings.ts");
  return (await importTs("../src/lib/api.ts", { '"./holdings"': JSON.stringify(holdingsUrl) })).api;
}

const day = { trade_date: "2026-11-26", ew_ret: 0.01, n_valid: 5221 };
const basePayload = (over = {}) => ({
  meta: { last_trade_date: day.trade_date, source: "tushare, unavailable", sources: { daily: "tushare", limit_list_d: "unavailable" } },
  market: [day],
  stocks: [],
  watch_pool: [],
  contrib: {},
  sectors: {},
  distribution: {},
  sector_monthly: [],
  stock_series: {},
  ...over,
});

/* ------------------------------------------------------------------ */
/* 1. P1-4 / W9-03：新高新低轴域（不先截尾）                            */
/* ------------------------------------------------------------------ */
test("high/low axis: domain always covers the latest value and lists real out-of-axis values", async () => {
  const { symmetricDomain } = await importTs("../src/lib/theme.ts");
  // 近似真实 120 日窗口：绝大多数日子在 100-149，倒数第二日 2000，最大新低日 2838；
  // 最新一天（2026-11-26）新低 = 2111，必须落在轴内。
  const values = Array.from({ length: 120 }, (_, i) => (i === 119 ? 2838 : i === 118 ? 2000 : 100 + (i % 50)));
  const domain = symmetricDomain(values, { includeMax: 2111 });
  assert.ok(domain.max >= 2111, "y 轴必须覆盖最新一天的真实值 2111");
  assert.ok(domain.max < 2838, "轴域按分位自适应，不应被单个极值拉到 2838");
  const clipped = domain.clipped.map((entry) => entry.value);
  assert.deepEqual(clipped, [2838], "超出轴上限的观测必须保留真实值（2838），不能静默变成轴上限");
  assert.equal(domain.clipped[0].index, 119);
  // 轴上限不得低于 floor，且为整数刻度
  assert.equal(symmetricDomain([0, 0, 0]).max, 100);
  assert.equal(symmetricDomain([10, 20, 30]).max % 100, 0);
  // 更大的真实极值也必须出现在 clipped 里，不能被静默丢弃
  const extreme = symmetricDomain([...values, 9999], { includeMax: 2111 }).clipped.map((e) => e.value);
  assert.ok(extreme.includes(9999));
});

test("Sentiment high/low chart no longer clips data before drawing", async () => {
  const source = await readSource("../src/pages/Sentiment.tsx");
  assert.match(source, /symmetricDomain\(/, "应使用自适应轴域（theme.symmetricDomain）");
  assert.doesNotMatch(source, /const clip = \(v: number\) => Math\.min\(v, cap\)/, "旧版先截尾的 clip 不能保留");
  assert.doesNotMatch(source, /min: -cap[\s\S]{0,40}max: cap/, "y 轴不再用截尾 cap 固定范围");
  assert.match(source, /new_low_n == null \? null : clamp\(-r\.new_low_n\)/, "新低数据用真实值 clamp 到轴端");
  assert.match(source, /真实值/, "图注必须说明真实值未截尾");
  // W9-09：封板质量截止日期动态读取，不再硬编码
  assert.doesNotMatch(source, /数据截至 2026-05-22/);
  assert.match(source, /sealLast/);
  // W9-12：连板 y 轴自适应
  assert.doesNotMatch(source, /gridIndex: 1, min: 0, max: 10\b/);
  assert.match(source, /streakMax/);
  // W9-10/W9-11：tooltip 绝对值与官方名单口径标注
  assert.match(source, /Math\.abs\(r\.limit_down_n\)/);
  assert.match(source, /官方名单口径/);
});

/* ------------------------------------------------------------------ */
/* 2. W5-02 / W14-10：主题白名单 + 浅色对比度                          */
/* ------------------------------------------------------------------ */
const luminance = (hex) => {
  const clean = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("theme whitelist: unknown theme still yields a complete palette", async () => {
  const { paletteFor, palettes, isTheme } = await importTs("../src/lib/theme.ts");
  assert.equal(isTheme("neon"), false);
  for (const theme of ["neon", "light", undefined, "dark"]) {
    const p = paletteFor(theme, false);
    for (const key of ["bg", "panel", "panel2", "text", "muted", "faint", "up", "down", "accent", "copper"]) {
      assert.equal(typeof p[key], "string", `paletteFor(${theme}) 缺少 ${key}`);
    }
  }
  assert.equal(palettes.light.bg, "#f6f2e8");
});

test("light theme faint/accent/copper meet WCAG AA 4.5:1 on every light surface", async () => {
  const { palettes } = await importTs("../src/lib/theme.ts");
  const light = palettes.light;
  const surfaces = [light.bg, light.panel, light.panel2, light.panel3];
  for (const key of ["faint", "accent", "copper"]) {
    for (const surface of surfaces) {
      assert.ok(contrast(light[key], surface) >= 4.5, `${key} ${light[key]} vs ${surface} = ${contrast(light[key], surface).toFixed(2)} < 4.5`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. W5-01：money() 实时语言                                          */
/* ------------------------------------------------------------------ */
test("money follows the language source at call time (no render lag)", async () => {
  const format = await importTs("../src/lib/format.ts");
  format.registerLanguageSource(() => "en");
  assert.equal(format.money(1e9), "¥1.0B");
  format.registerLanguageSource(() => "zh");
  assert.equal(format.money(1e9), "10.0亿");
  // 显式传参仍然优先（charts/lib 内部 27 处历史调用不变）
  assert.equal(format.money(1000, "en"), "¥1K");
});

/* ------------------------------------------------------------------ */
/* 4. W9-06 / W14-14：版本一致性                                       */
/* ------------------------------------------------------------------ */
test("version label is shared and pages no longer hardcode v0.3", async () => {
  const format = await importTs("../src/lib/format.ts");
  assert.equal(format.versionLabel("0.4.3"), "v0.4.3");
  assert.equal(format.versionLabel("v0.4.2"), "v0.4.2");
  assert.equal(format.versionLabel(null), `v${format.VERSION_FALLBACK}`);
  for (const page of ["../src/pages/Briefing.tsx", "../src/pages/About.tsx"]) {
    const source = await readSource(page);
    assert.doesNotMatch(source, /v0\.3\b/, `${page} 仍有硬编码 v0.3`);
    assert.match(source, /versionLabel\(meta\?\.version\)/, `${page} 应从 meta.version 注入版本`);
  }
});

/* ------------------------------------------------------------------ */
/* 5. api 契约归一（W5-03 / W5-04 / W9-04 / W5-07）                     */
/* ------------------------------------------------------------------ */
test("distribution coverage reveals omitted tails instead of pretending full coverage", async () => {
  const api = await staticApi(
    basePayload({
      distribution: {
        "2026-11-26": {
          bins: [
            { b: 0, n: 100, lo: -0.11, hi: -0.105 },
            { b: 1, n: 200, lo: -0.105, hi: -0.1 },
          ],
          stats: { n: 5221, med: 0.001, p05: -0.05, p25: -0.02, p75: 0.02, p95: 0.05, mean: 0, sd: 0.02 },
        },
      },
    }),
  );
  const { distributionCoverage } = await importTs("../src/lib/api.ts", {
    '"./holdings"': JSON.stringify(sourceUrl("../src/lib/holdings.ts")),
  });
  const dist = await api.distribution("2026-11-26");
  const coverage = distributionCoverage(dist);
  assert.equal(coverage.total, 5221, "旧 payload 没有 n_total 时用 stats.n");
  assert.equal(coverage.binned, 300, "旧 payload 没有 n_binned 时用 bins 合计");
  assert.equal(coverage.omitted, 4921);
  // 新 payload 直接采用后端给出的真实覆盖数
  const fresh = distributionCoverage({
    bins: [{ b: 0, n: 5199, lo: -0.11, hi: 0.11 }],
    stats: { n: 5221, med: 0, p05: 0, p25: 0, p75: 0, p95: 0, mean: 0, sd: 0 },
    n_total: 5221,
    n_binned: 5199,
    n_excluded_lt: 11,
    n_excluded_gt: 11,
  });
  assert.deepEqual(fresh, { total: 5221, binned: 5199, excludedLt: 11, excludedGt: 11, omitted: 22 });
  // 静态导出器曾把覆盖统计放进 stats：两种结构都必须能读出真实数
  const nested = distributionCoverage({
    bins: [{ b: 0, n: 5199, lo: -0.11, hi: 0.11 }],
    stats: { n: 5221, med: 0, p05: 0, p25: 0, p75: 0, p95: 0, mean: 0, sd: 0, n_total: 5221, n_binned: 5199, n_excluded_lt: 11, n_excluded_gt: 11 },
  });
  assert.deepEqual(nested, { total: 5221, binned: 5199, excludedLt: 11, excludedGt: 11, omitted: 22 });
});

test("quality/valuation normalize to null instead of {} (no white screen / null%)", async () => {
  const api = await staticApi(basePayload({ quality: {}, pe_percentile: { "000678.SZ": { pe: null, pct: null, n: 0 } } }));
  assert.equal(await api.quality(), null);
  assert.equal(await api.valuation("000001.SZ"), null);
  const pe = await api.valuation("000678.SZ");
  assert.equal(pe.pct, null);
  assert.equal(pe.pe, null);
  // 清空为 null 的 quality 也不能崩溃（页面统一 quality?.gates ?? []）
  assert.doesNotThrow(() => (api.quality() || []).map?.((x) => x));
});

test("static collection datasets missing from an old export fail loudly instead of silently empty", async () => {
  const api = await staticApi(basePayload());
  assert.throws(() => api.rotation(), /Not included in this offline export/);
  assert.throws(() => api.updates());
  assert.throws(() => api.sectorRanks());
});

test("stock series: qfq 7-tuples and legacy 6-tuples are normalized with adjust metadata", async () => {
  const api = await staticApi(
    basePayload({
      stock_series: {
        "600519.SH": [
          ["2026-11-25", 100, 101, 99, 100, 1000, 2],
          ["2026-11-26", 101, 102, 100, 101.5, 1200, 2],
        ],
        "000001.SZ": [
          ["2026-11-25", 10, 11, 9, 10, 100],
          ["2026-11-26", 10, 12, 9, 11, 200],
        ],
      },
    }),
  );
  const fresh = await api.stockSeries("600519.SH");
  assert.equal(fresh[0].adjust, "qfq");
  assert.equal(fresh[0].adj_factor, 2);
  const legacy = await api.stockSeries("000001.SZ");
  assert.equal(legacy[0].adjust, "none");
  assert.equal(legacy[0].adj_factor, null);
});

test("source label filters the unavailable placeholder out of the data-source name", async () => {
  const api = await importTs("../src/lib/api.ts", {
    '"./holdings"': JSON.stringify(sourceUrl("../src/lib/holdings.ts")),
  });
  const meta = { source: "tushare, unavailable", sources: { daily: "tushare", limit_list_d: "unavailable", margin: "unavailable" } };
  assert.equal(api.sourceLabel(meta, "zh"), "tushare");
  assert.deepEqual(api.unavailableDatasetNames(meta).sort(), ["limit_list_d", "margin"]);
  assert.equal(api.sourceLabel({ source: "unavailable" }, "zh"), "不可用");
});

/* ------------------------------------------------------------------ */
/* 6. §3：请求头 + 错误映射                                            */
/* ------------------------------------------------------------------ */
test("api requests carry X-Requested-With so GET /api/watchlist is not rejected", async () => {
  globalThis.window = {}; // 非静态模式
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, statusText: "OK", json: async () => [] };
  };
  const { api } = await importTs("../src/lib/api.ts", {
    '"./holdings"': JSON.stringify(sourceUrl("../src/lib/holdings.ts")),
  });
  await api.watchlist();
  await api.meta();
  for (const call of calls) {
    assert.equal(call.init.headers?.["X-Requested-With"], "ashare-radar", `${call.url} 缺少 X-Requested-With`);
  }
});

test("4xx responses surface as status-carrying errors for the retry policy", async () => {
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
  const apiMod = await importTs("../src/lib/api.ts", {
    '"./holdings"': JSON.stringify(sourceUrl("../src/lib/holdings.ts")),
  });
  await assert.rejects(() => apiMod.api.marketDay("2020-01-01"), (error) => {
    assert.equal(error.name, "ApiError");
    assert.equal(error.status, 404);
    return true;
  });
});

/* ------------------------------------------------------------------ */
/* 7. W14-09 / W14-08：html lang 与 title 兜底                         */
/* ------------------------------------------------------------------ */
test("setLang writes <html lang>, and Shell titles briefing/labs pages", async () => {
  const i18nSource = await readSource("../src/lib/i18n.ts");
  assert.match(i18nSource, /document\.documentElement\.lang\s*=\s*language === "en" \? "en" : "zh-CN"/);
  const uiSource = await readSource("../src/store/ui.ts");
  assert.match(uiSource, /applyDocumentLang/);
  assert.match(uiSource, /isTheme\(queryTheme\)/, "非法 ?theme= 必须走白名单");
  assert.match(uiSource, /stripSearchParam\("theme"\)/, "非法 ?theme= 要从 URL 清掉");
  const shell = await readSource("../src/components/Shell.tsx");
  assert.match(shell, /location\.pathname\.startsWith\("\/briefing"\)\) return t\("nav\.briefing"\)/);
  assert.match(shell, /location\.pathname\.startsWith\("\/labs"\)\) return t\("nav\.labs"\)/);
  const html = await readSource("../index.html");
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i, "前端不应自行注入 CSP（由服务端 after_request 负责，注入会破坏 SPA）");
});

/* ------------------------------------------------------------------ */
/* 8. W9-04 / W9-13 / W9-14 / W9-24：ChartLab / Briefing 文案          */
/* ------------------------------------------------------------------ */
test("distribution cards state the ±11% omission with real counts, not the old wrong claim", async () => {
  for (const page of ["../src/pages/ChartLab.tsx", "../src/pages/Briefing.tsx"]) {
    const source = await readSource(page);
    assert.doesNotMatch(source, /端点箱汇总区间外收益|tail bins include outliers|端点箱包含区间外收益/, `${page} 仍有错误的口径文案`);
    assert.match(source, /distributionCoverage/, `${page} 应使用 api.distributionCoverage`);
    assert.match(source, /±11% 外/, `${page} 应明确「±11% 外 N 只不绘制」`);
  }
  const labs = await readSource("../src/pages/ChartLab.tsx");
  assert.doesNotMatch(labs, /点击色块可选行业/, "云图没有 click 处理就不能宣称可点击（W9-13）");
  assert.match(labs, /Seven live-data demos/, "英文 demo 数量必须与 7 张卡片一致（W9-14）");
  assert.match(labs, /All demos →/, "未知 demo 需要返回链接（W9-24）");
  assert.match(labs, /含当月至今|month-to-date/, "小倍数需标注含当月至今（W9-20）");
  const briefing = await readSource("../src/pages/Briefing.tsx");
  assert.match(briefing, /\(c\.contrib \* 100\)\.toFixed\(3\)\}pp/, "最大贡献个股应显示 pp（W9-23）");
  assert.match(briefing, /breadthPctile == null \? "—" : `\$\{breadthPctile\}%`/, "分位需带 %（W9-24）");
  assert.doesNotMatch(briefing, /\?print=1/, "已不存在的 print=1 参数注释必须删除（W9-24）");
});

/* ------------------------------------------------------------------ */
/* 9. W7-07：命令面板 hint 与 Shell 快捷键实现一致                      */
/* ------------------------------------------------------------------ */
test("command palette shortcuts are actually implemented in Shell", async () => {
  const palette = await readSource("../src/components/CommandPalette.tsx");
  const shell = await readSource("../src/components/Shell.tsx");
  assert.doesNotMatch(palette, /hint: "⌘ [LIBR]"/, "未实现的 ⌘ 快捷键 hint 必须删除");
  // G 系列导航：hint 的字母必须都在 Shell 的 leader 映射里
  for (const key of ["T", "M", "R", "S", "K", "E", "W", "A"]) {
    assert.match(palette, new RegExp(`hint: "G ${key}"`));
  }
  for (const route of ["t: \"/\"", "m: \"/market\"", "r: \"/regime\"", "s: \"/sectors\"", "k: \"/stocks\"", "e: \"/sentiment\"", "w: \"/watchlist\"", "a: \"/about\""]) {
    assert.ok(shell.includes(route), `Shell 缺少 leader 路由 ${route}`);
  }
  // Alt 系列：hint 与实现同名
  for (const hint of ["Alt T", "Alt I", "Alt B", "Alt R"]) {
    assert.ok(palette.includes(`hint: "${hint}"`), `palette 缺少 ${hint} hint`);
  }
  for (const key of ["t", "i", "b", "r"]) {
    assert.match(shell, new RegExp(`key === "${key}"`), `Shell 缺少 Alt ${key.toUpperCase()} 处理`);
  }
});

/* ------------------------------------------------------------------ */
/* 10. About 披露（W14-03/04、W9-05/21/22）                            */
/* ------------------------------------------------------------------ */
test("About discloses licence/limitations and reconciles with dates", async () => {
  const source = await readSource("../src/pages/About.tsx");
  assert.match(source, /数据许可/);
  assert.match(source, /免责声明/);
  assert.match(source, /已知限制/);
  assert.match(source, /sourceLabel\(meta, lang\)/, "数据源展示需过滤 unavailable（W9-22）");
  assert.match(source, /generated_at/, "对账需显示快照日期（W9-05）");
  assert.match(source, /不可验证（0 对样本）/, "pairs=0 需显示不可验证（W9-05）");
  assert.match(source, /最近更新记录（共 \$\{updates\?\.length \?\? 0\} 条/, "更新日志标题需动态计数（W9-21）");
  assert.match(source, /meta\?\.data_quality/, "已知限制需读取 meta.data_quality（W14-04）");
});
