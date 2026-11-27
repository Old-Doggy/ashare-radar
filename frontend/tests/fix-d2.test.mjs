/**
 * D2（Sectors / Stocks / Watchlist + charts3/5/6）修复回归测试。
 *
 * 修复对应关系：
 * - W8-02/W8-03  行业排序 tiebreak / 默认选中不依赖行序（rotation.ts）
 * - W8-05        分布条轴域自适应（rotation.ts）
 * - W8-06        breadth 口径文案（rotation.ts）
 * - W8-07        缺月行业保留为 —（rotation.ts sortHeatRows/heatGroups + MonthlyGrid）
 * - W9-01        市值散点 x 轴域自适应（charts3.ts logCapDomain）
 * - W9-02/P1-6   K 线前复权模型（charts3.ts klineSeriesModel / klineOption）
 * - W6-07/W6-13  贡献图负零着色、label 与 tooltip 同源（charts5.ts）
 * - W9-15        行业暴露 pill 与图同口径（charts5.ts sectorExposureGroups）
 * - W5-10        signedMoney 非有限守卫（holdings.ts）
 * - W9-17/W5-12  报价状态分类（holdings.ts）
 * - W9-19        导入池代码校验（holdings.ts unknownWatchCodes）
 * - W5-13/W14-15 CSV 公式注入中和（download.ts）
 * - W6-06        轮动强度 y 轴 headroom（charts3.ts rotationPulse）
 * - W6-10        charts6 系列数不变量
 *
 * 只依赖 node 内置模块 + typescript（dev 依赖），不联网、不读生产数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// format.ts 在模块级读取 window.location / localStorage，先放好桩再 import。
globalThis.window = { location: { search: "" } };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// 1) 无运行时依赖的模块：node --experimental-strip-types 直接解析
const download = await import("../src/lib/download.ts");
const holdings = await import("../src/lib/holdings.ts");
const rotation = await import("../src/lib/rotation.ts");

// 2) 带 `./theme` 等无扩展名运行时导入的图表模块：按既有 chart-safety.test.mjs 的做法
//    用 typescript transpile 到临时目录、把相对导入补成 .mjs 后再 import。
const temporary = mkdtempSync(join(tmpdir(), "ashare-radar-fix-d2-"));
process.on("exit", () => rmSync(temporary, { recursive: true, force: true }));
const frontend = dirname(dirname(fileURLToPath(import.meta.url)));
const entries = ["charts3", "charts5", "charts6", "theme", "format", "html", "holdings", "rotation"];
for (const name of entries) {
  const source = readFileSync(join(frontend, "src", "lib", `${name}.ts`), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  writeFileSync(
    join(temporary, `${name}.mjs`),
    output.replace(/(from\s+["'])(\.\/[^"']+)(["'])/g, "$1$2.mjs$3"),
  );
}
const bundle = join(temporary, "index.mjs");
writeFileSync(bundle, entries.map((name) => `export * from './${name}.mjs';`).join("\n"));
const charts = await import(pathToFileURL(bundle));
const p = charts.paletteFor("dark", false);

/* ============================ CSV 导出（W5-13 / W14-15 / W9-07） ============================ */

test("CSV 单元格：引号/逗号/换行 RFC4180 转义，null 为空", () => {
  const csv = download.toCsv([["a,b", 'say "hi"', "line\nbreak", null]]);
  assert.equal(csv, '"a,b","say ""hi""","line\nbreak",""');
  assert.equal(download.toCsv([["h1", "h2"], [1, 2]]), '"h1","h2"\n"1","2"');
});

test("CSV 公式注入：= + - @ \\t \\r 开头的文本前置单引号，数值列不受影响", () => {
  const csv = download.toCsv([["=1+1", "@SUM(A1:A9)", "+1+1", "-2+3", "\t=1+1", "\r=cr", "正常名称", -5]]);
  assert.ok(csv.includes('"\'=1+1"'), csv);
  assert.ok(csv.includes('"\'@SUM(A1:A9)"'), csv);
  assert.ok(csv.includes('"\'+1+1"'), csv);
  assert.ok(csv.includes('"\'−2+3"') || csv.includes('"\' -2+3"') || csv.includes('"\'-2+3"'), csv);
  assert.ok(csv.includes('"\'\t=1+1"'), csv);
  assert.ok(csv.includes('"\'\r=cr"'), csv);
  assert.ok(csv.includes('"正常名称"'), csv);
  // 数值 -5 是数值单元格，不能被加上前缀变成文本
  assert.ok(csv.endsWith('"-5"'), csv);
  assert.equal(download.neutralizeCsvCell("plain"), "plain");
  assert.equal(download.neutralizeCsvCell("=cmd"), "'=cmd");
});

/* ======================== holdings：非有限 / 负零 / 报价状态 / 导入池 ======================== */

test("signedMoney 非有限值保持未知，不出现 +¥NaN / +¥∞（W5-10）", () => {
  assert.equal(holdings.signedMoney(NaN), "—");
  assert.equal(holdings.signedMoney(Infinity), "—");
  assert.equal(holdings.signedMoney(-Infinity), "—");
  assert.equal(holdings.signedMoney(-1234.5), "−¥1,234.5");
});

test("未舍入判号：(-0.5,0) 元显示为亏损侧 −¥0（W6-07）", () => {
  assert.equal(holdings.signedMoneyRounded(-0.4), "−¥0");
  assert.equal(holdings.signedMoneyRounded(0.4), "+¥0");
  assert.equal(holdings.signedMoneyRounded(-123), "−¥123");
  assert.equal(holdings.signedMoneyRounded(NaN), "—");
  assert.equal(holdings.signedTone(-0.4), "down");
  assert.equal(holdings.signedTone(0.4), "up");
  assert.equal(holdings.signedTone(0), "flat");
  assert.equal(holdings.signedTone(null), "flat");
});

test("报价状态区分「未收录/无行情」与「报价过期」（W9-17 / W5-12）", () => {
  assert.equal(holdings.quoteState({ ts_code: "000003.SZ", quote_missing: true }), "missing");
  assert.equal(holdings.quoteState({ ts_code: "000005.SZ", is_stale: true, quote_date: "2024-03-05" }), "stale");
  assert.equal(holdings.quoteState({ ts_code: "600519.SH" }), "ok");
  const issues = holdings.watchQuoteIssues([
    { ts_code: "000003.SZ", quote_missing: true },
    { ts_code: "000005.SZ", is_stale: true },
    { ts_code: "600519.SH" },
  ]);
  assert.deepEqual(issues, { missing: ["000003.SZ"], stale: ["000005.SZ"] });
});

test("CSV 导入池校验只提示、不阻塞（W9-19）", () => {
  const universe = new Set(["000001.SZ", "600519.SH"]);
  assert.deepEqual(holdings.unknownWatchCodes(["000001.SZ", "123456.SH"], universe), ["123456.SH"]);
  assert.deepEqual(holdings.unknownWatchCodes(["123456.SH"], null), []);
  assert.deepEqual(holdings.unknownWatchCodes(["123456.SH"], new Set()), []);
});

/* ============================ 行业页纯函数（W8 系列） ============================ */

const latestSectors = [
  { sw_l1: "交通运输", breadth: 0.45283, ew_ret: -0.001566 },
  { sw_l1: "煤炭", breadth: 1.0, ew_ret: 0.024749 },
  { sw_l1: "社会服务", breadth: 0.166667, ew_ret: -0.01674 },
  { sw_l1: "钢铁", breadth: 0.45283, ew_ret: 0.00457 },
  { sw_l1: "美容护理", breadth: 0.166667, ew_ret: -0.011363 },
  { sw_l1: "银行", breadth: 1.0, ew_ret: 0.009744 },
];

test("行业广度榜排序与输入行序无关（W8-03 tiebreak）", () => {
  const a = rotation.sortSectorBoard(latestSectors).map((r) => r.sw_l1);
  const b = rotation.sortSectorBoard([...latestSectors].reverse()).map((r) => r.sw_l1);
  assert.deepEqual(a, b);
  // breadth 100% 并列时按等权收益 → 煤炭(+2.47%) 在银行(+0.97%) 前；
  // 45.28% 并列时按等权收益 → 钢铁(+0.46%) 在交通运输(-0.16%) 前。
  assert.deepEqual(a.slice(0, 4), ["煤炭", "银行", "钢铁", "交通运输"]);
});

test("默认选中行业不依赖 rows[0]，API/静态双路径一致（W8-02）", () => {
  const fromStatic = rotation.pickDefaultSector(latestSectors);
  const fromApi = rotation.pickDefaultSector([...latestSectors].reverse());
  assert.equal(fromStatic, "煤炭");
  assert.equal(fromApi, fromStatic);
  assert.equal(rotation.pickDefaultSector(latestSectors, "银行"), "银行");
  assert.equal(rotation.pickDefaultSector(latestSectors, "不存在的行业"), "煤炭");
  assert.equal(rotation.pickDefaultSector([]), null);
});

test("breadth 文案明确「平盘剔除」（W8-06）", () => {
  const zh = rotation.breadthBasisText("zh");
  assert.ok(zh.includes("上涨") && zh.includes("平盘") && zh.includes("剔除"), zh);
  const en = rotation.breadthBasisText("en");
  assert.ok(en.includes("flats excluded"), en);
});

test("q10–q90 分布条轴域默认 ±11%，越界时自适应且不截尾（W8-05）", () => {
  assert.equal(rotation.distributionDomain(-0.0439, 0.0418), 0.11);
  assert.equal(rotation.distributionDomain(null, null), 0.11);
  assert.equal(rotation.distributionDomain(-0.2001, 0.2001), 0.21);
  // 自适应轴域有 1% 取整留白，-20.01%/q10 不再贴边被截断
  assert.ok(rotation.distributionPercent(-0.2001, 0.21) < 5);
  assert.ok(rotation.distributionPercent(0.2001, 0.21) > 95);
  assert.equal(rotation.distributionPercent(0, 0.11), 50);
  assert.equal(rotation.distributionPercent(null, 0.11), null);
  const lo = rotation.distributionPercent(-0.2, 0.21);
  const hi = rotation.distributionPercent(0.2, 0.21);
  assert.ok(lo > 0 && hi < 100, "自适应轴域下极值不应贴边被截");
});

test("缺月行业保留并排到末尾，不因 score=null 整行消失（W8-07）", () => {
  const rows = [
    { name: "缺月行业", score: null, values: [null, null] },
    { name: "银行", score: 0.1, values: [0.01, 0.09] },
    { name: "煤炭", score: 0.2, values: [0.1, 0.09] },
    { name: "电子", score: -0.1, values: [0.02, -0.12] },
  ];
  const sorted = rotation.sortHeatRows(rows).map((r) => r.name);
  assert.deepEqual(sorted, ["煤炭", "银行", "电子", "缺月行业"]);
  const all = rotation.heatGroups(rows, "all");
  assert.equal(all.length, 1);
  assert.equal(all[0].length, rows.length, "全部模式必须保留全部行业");
  assert.equal(rotation.missingHeatCount(rows), 1);
  const focus = rotation.heatGroups(
    Array.from({ length: 31 }, (_, i) => ({
      name: `行业${i}`,
      score: i < 28 ? i / 100 : null,
      values: [],
    })),
    "focus",
  );
  assert.equal(focus.length, 2);
  assert.equal(focus.flat().length, 12);
  assert.equal(focus[0][0].name, "行业27", "缺月行不得进入领涨组");
});

/* ============================ K 线 / 散点（P1-6 / W9-01 / W9-02） ============================ */

test("市值散点 x 轴域包含万亿市值股，不再硬编码 [0,4]（W9-01）", () => {
  // 2026-11-26 payload 流通市值前 5 的 log10(亿元)：4.4083 / 4.3959 / 4.3152 / 4.2640 / 4.1994
  const top5 = [4.4083, 4.3959, 4.3152, 4.264, 4.1994];
  const others = [3.9534, 3.9518, 3.9396, 2.1, 0.0];
  const values = [...top5, ...others];
  const domain = charts.logCapDomain(values);
  assert.ok(domain.max >= 4.4083, `max=${domain.max} 必须覆盖最大市值点`);
  assert.ok(values.every((v) => v >= domain.min && v <= domain.max), "所有点必须落在轴域内");
  assert.deepEqual(charts.logCapDomain([]), { min: 0, max: 4 });
  assert.ok(charts.logCapDomain([1, 2]).max >= 2);
});

test("散点降采样强制保留极端市值点，轴域与可见点一致（W9-01 根因之二）", () => {
  // 5221 行、每 7 行抽 1 行（746 点）：若最大市值行 index%7 != 0，等距抽样会把它丢掉。
  const rows = Array.from({ length: 5221 }, (_, i) => ({ ts_code: `S${String(i).padStart(6, "0")}`, circ_mv: 100 + i }));
  rows[3].circ_mv = 256033857; // 农业银行量级（万亿），index 3 不是 7 的倍数
  const pool = charts.scatterSample(rows, 800, 8);
  assert.ok(pool.some((r) => r.ts_code === "S000003"), "最大市值股必须进入抽样池");
  const xs = pool.map((r) => Math.log10(Math.max(r.circ_mv / 1e4, 0.5)));
  const domain = charts.logCapDomain(xs);
  const topX = Math.log10(Math.max(256033857 / 1e4, 0.5));
  assert.ok(domain.max >= topX, "轴域必须覆盖被强制保留的极端点");
  assert.ok(xs.every((x) => x >= domain.min && x <= domain.max), "抽样池内所有点都不得被轴裁掉");
  assert.ok(pool.length <= 746 + 8, "强制保留点数有上限");
  assert.deepEqual(charts.scatterSample([], 800, 8), []);
});

test("K 线模型兼容旧 6 元组（未复权）并标注 adjusted=false（W9-02 兼容）", () => {
  const old = [
    ["2026-11-24", 10, 11, 9, 10.5, 1000],
    ["2026-11-25", 10.5, 12, 10, 11, 1200],
  ];
  const model = charts.klineSeriesModel(old);
  assert.equal(model.adjusted, false);
  assert.equal(model.lastAdj, null);
  assert.equal(model.bars.length, 2);
  assert.equal(model.bars[0].closeRaw, model.bars[0].close);
  const option = charts.klineOption(p, model, "zh");
  assert.ok(Array.isArray(option.series));
  assert.equal(option.series[0].type, "candlestick");
});

test("K 线模型识别 7 元组前复权序列，并可还原原始收盘（P1-6）", () => {
  // 2:1 除权：除权前 adj=1.0 raw=100，除权后 adj=2.0 raw=50；前复权后两日 close 都是 50。
  const adjusted = [
    ["2026-06-10", 50, 51, 49, 50, 1000, 1.0],
    ["2026-06-11", 50, 52, 49.5, 50.5, 1100, 2.0],
  ];
  const model = charts.klineSeriesModel(adjusted);
  assert.equal(model.adjusted, true);
  assert.equal(model.lastAdj, 2.0);
  assert.equal(model.bars[0].close, 50);
  assert.equal(Math.round(model.bars[0].closeRaw * 100) / 100, 100, "close_raw = close_adj × last_adj / adj");
  assert.equal(Math.round(model.bars[1].closeRaw * 100) / 100, 50.5);
  // 连涨跌都是真实收益：50.5/100 - 1 = -49.5% 是原始价含除权跳空 → 复权序列不出现 -49.5% 假暴跌
  assert.notEqual(model.bars[0].close, 100);
});

test("K 线模型对象输入优先使用后端 close_raw，tooltip 同时给复权价与原始收盘（W9-02）", () => {
  const points = [
    { trade_date: "2026-11-24", open: 10, high: 11, low: 9, close: 10.5, vol: 100, adj_factor: 1.1, close_raw: 9.55, adjust: "qfq" },
    { trade_date: "2026-11-25", open: 10.5, high: 12, low: 10, close: 11, vol: 120, adj_factor: 1.1, close_raw: 10, adjust: "qfq" },
  ];
  const model = charts.klineSeriesModel(points);
  assert.equal(model.adjusted, true);
  assert.equal(model.bars[0].closeRaw, 9.55, "对象里的 close_raw 不得被重算覆盖");
  const option = charts.klineOption(p, model, "zh");
  const html = option.tooltip.formatter([{ dataIndex: 1 }]);
  assert.ok(html.includes("前复权"), html);
  assert.ok(html.includes("原始收盘"), html);
  assert.ok(html.includes("11.00"), html);
  assert.ok(!html.includes("NaN"), html);
});

test("旧静态包经 api.ts 归一（adjust=none, close_raw==close）不得误标为前复权", () => {
  // api.ts D3 契约：6 元组静态包映射为 adjust:"none"、adj_factor:null、close_raw=close
  const model = charts.klineSeriesModel([
    { trade_date: "2026-11-25", open: 10.5, high: 12, low: 10, close: 11, vol: 120, adj_factor: null, close_raw: 11, adjust: "none" },
  ]);
  assert.equal(model.adjusted, false);
  assert.equal(model.bars[0].closeRaw, 11);
  const html = charts.klineOption(p, model, "zh").tooltip.formatter([{ dataIndex: 0 }]);
  assert.ok(html.includes("未复权"), html);
});

/* ============================ 贡献图 / 行业暴露（W6-07 / W6-13 / W9-15 / W5-10） ============================ */

test("贡献图按未舍入值判号：(-0.5,0) 元是亏损色，label 与 tooltip 同源（W6-07/W6-13）", () => {
  const rows = [
    { ts_code: "000001.SZ", name: "平安银行", sw_l1: "银行", close: 10, ret: -0.001, shares: 10, cost: 10, mv: 100, pnl: -0.4, today: -0.4 },
    { ts_code: "600519.SH", name: "贵州茅台", sw_l1: "食品饮料", close: 1600, ret: 0.01, shares: 100, cost: 1500, mv: 160000, pnl: 10000, today: 1600 },
  ];
  const series = charts.contributionSeries(rows);
  const loss = series.find((d) => d.name === "平安银行");
  assert.equal(loss.tone, "down", "极小亏损不得染成上涨色");
  assert.equal(loss.value, 0, "显示值可以舍入到 0");
  assert.equal(loss.text, "−¥0", "label/tooltip 保持负号");

  const option = charts.contributionChart(p, rows, "zh");
  const lossItem = option.series[0].data.find((d) => d.name === "平安银行");
  assert.equal(lossItem.itemStyle.color, p.down);
  assert.equal(option.series[0].label.formatter({ data: lossItem, value: lossItem.value }), "−¥0");
  const tip = option.tooltip.formatter({ data: lossItem });
  assert.ok(tip.includes("−¥0"), tip);
  assert.ok(tip.includes("平安银行"), tip);
});

test("未知今日盈亏不进入贡献序列，也不伪装成 +¥0（W5-10）", () => {
  const series = charts.contributionSeries([
    { ts_code: "000005.SZ", name: "世纪星源", sw_l1: "环保", close: 1, ret: 0, shares: 100, cost: 1, mv: 100, pnl: 0, today: null },
  ]);
  assert.deepEqual(series, []);
});

test("行业暴露 pill 与图表同口径：未填股数不进入分组（W9-15）", () => {
  const rows = [
    { ts_code: "600519.SH", name: "贵州茅台", sw_l1: "食品饮料", close: 1600, ret: 0.01, shares: 100, cost: 1500, mv: 160000, pnl: 10000, today: 1600 },
    { ts_code: "300750.SZ", name: "宁德时代", sw_l1: "电力设备", close: 200, ret: 0.02, shares: 200, cost: 180, mv: 40000, pnl: 4000, today: 4000 },
    { ts_code: "601318.SH", name: "中国平安", sw_l1: "非银金融", close: 50, ret: 0, shares: 0, cost: 0, mv: 0, pnl: 0, today: 0 },
    { ts_code: "000003.SZ", name: "000003.SZ", sw_l1: "", close: 0, ret: 0, shares: 0, cost: 0, mv: 0, pnl: 0, today: 0 },
  ];
  const groups = charts.sectorExposureGroups(rows, "zh");
  assert.equal(groups.length, 2, "只有 2 只有股数的持仓计入暴露");
  assert.ok(groups.every((g) => g.n === 1));
  const option = charts.sectorExposureChart(p, rows, "zh");
  assert.equal(option.yAxis.data.length, groups.length, "pill 数必须等于图表分组数");
  const label = option.series[0].label.formatter({ value: 12.64 });
  assert.equal(label, "12.6%", "label 精度与 tooltip 一致（W6-13）");
  const tip = option.tooltip.formatter({ data: { name: "食品饮料", value: 12.6, n: 1 } });
  assert.ok(tip.includes("12.6%"), tip);
});

test("reduced-motion 初始平滑比常规默认更狠，方向不再反（W8-04）", () => {
  const normal = rotation.initialSmoothHalfLife(false);
  const reduced = rotation.initialSmoothHalfLife(true);
  assert.equal(normal, 20);
  assert.equal(reduced, 32);
  assert.ok(reduced > normal, "半衰期越长帧间运动越小；reduced-motion 不能取更小的值");

  // 直接验证方向：同一噪声序列，半衰期 32 的帧间抖动必须 <= 半衰期 12（旧实现的值）
  const noisy = Array.from({ length: 80 }, (_, t) => [{ x: Math.sin(t / 3) * 8 + (t % 5) * 0.6, y: 50 + Math.cos(t / 4) * 20 }]);
  const jerk = (m) => m.slice(1).reduce((sum, frame, i) => {
    const a = m[i][0], b = frame[0];
    return sum + (a && b ? Math.abs(b.x - a.x) + Math.abs(b.y - a.y) : 0);
  }, 0);
  const j12 = jerk(rotation.smoothMatrix(noisy, 12));
  const j32 = jerk(rotation.smoothMatrix(noisy, 32));
  assert.ok(j32 <= j12, `smoothing 32 的帧间运动(${j32.toFixed(1)}) 必须不超过 12(${j12.toFixed(1)})`);
});

test("轮动领涨标签：收益未知保持中性色（CR2-03）", () => {
  assert.equal(rotation.leaderRetTone(null), "flat");
  assert.equal(rotation.leaderRetTone(undefined), "flat");
  assert.equal(rotation.leaderRetTone(0), "flat");
  assert.equal(rotation.leaderRetTone(0.03), "up");
  assert.equal(rotation.leaderRetTone(-0.02), "down");
});

/* ============================ 轮动图不变量（W6-06 / W6-10） ============================ */

test("轮动强度 y 轴留 headroom，最高柱不会被 toFixed 裁掉（W6-06）", () => {
  const rows = [
    { trade_date: "2026-01-05", rotation_intensity: 2.0 },
    { trade_date: "2026-01-06", rotation_intensity: 2.04 },
    { trade_date: "2026-01-07", rotation_intensity: 2.08 },
  ];
  const option = charts.rotationPulse(p, rows, "zh");
  const dataMax = Math.max(...option.series[0].data.map((d) => Number(d.value)));
  assert.ok(option.yAxis.max >= dataMax, `yAxis.max=${option.yAxis.max} 必须 >= 数据最大值 ${dataMax}`);
});

test("rotationFrame 系列数等于 SERIES_COUNT（W6-10 不再是无引用的死声明）", () => {
  const emptyFrame = {
    bubbles: [],
    focus: -1,
    hover: -1,
    labelIdx: new Set(),
    trail: { dots: [], line: [] },
    ghost: null,
    current: null,
    displacementValid: false,
    focusName: "",
  };
  const series = charts.rotationFrame(p, emptyFrame);
  assert.equal(series.length, charts.SERIES_COUNT);
  assert.equal(charts.SERIES_COUNT, 6);
});
