/** Position estimates assume unchanged shares; dividends and trades are not a ledger. */
export function finiteQuantity(value: unknown): number {
  if (typeof value === "boolean" || value === null || typeof value === "object") throw new Error("Invalid quantity");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Quantity must be finite and nonnegative");
  return n;
}

export function validCode(code: string): string {
  if (!/^\d{6}\.(SH|SZ)$/.test(code)) throw new Error("Invalid A-share code");
  return code;
}

export function holdingMetrics(row: { shares?: number; cost?: number; close?: number | null;
  pre_close?: number | null; ret?: number | null; is_stale?: boolean; quote_missing?: boolean }) {
  const shares = finiteQuantity(row.shares ?? 0);
  const cost = finiteQuantity(row.cost ?? 0);
  const price = row.close != null && Number.isFinite(row.close) && row.close > 0 ? row.close : null;
  const prior = row.pre_close != null && Number.isFinite(row.pre_close) && row.pre_close > 0 ? row.pre_close : null;
  const quoteUnknown = price === null || !!row.quote_missing;
  const todayKnown = !quoteUnknown && !row.is_stale && prior !== null;
  return { shares, cost, mv: shares * (price ?? 0),
    pnl: price !== null && cost > 0 ? (price-cost)*shares : 0,
    pnlPct: price !== null && cost > 0 ? price/cost-1 : 0,
    today: shares === 0 ? 0 : todayKnown ? shares * (price! - prior!) : null,
    startMv: todayKnown ? shares * prior! : null, quoteUnknown };
}

export function portfolioReturn(rows: { shares: number; today: number | null; startMv: number | null }[]): number | null {
  const invested = rows.filter(r => r.shares > 0);
  if (!invested.length || invested.some(r => r.today === null || r.startMv === null)) return null;
  const start = invested.reduce((a, r) => a + r.startMv!, 0);
  return start > 0 ? invested.reduce((a, r) => a + r.today!, 0)/start : null;
}

/** RFC4180-style quoted cells; validate the entire import before any writes. */
export function parseWatchCsv(text: string): {ts_code: string; shares: number; cost: number}[] {
  text = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false;
  for (let i=0; i<text.length; i++) {
    const c=text[i];
    if (c === '"') {
      if (quoted && text[i+1] === '"') { field+='"'; i++; }
      else if (quoted || field === "") quoted=!quoted;
      else throw new Error("Invalid CSV quoting");
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      record.push(field.trim()); field="";
      if (c !== ',') { if (record.some(Boolean)) records.push(record); record=[]; if(c==='\r' && text[i+1]==='\n') i++; }
    } else field+=c;
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  record.push(field.trim()); if (record.some(Boolean)) records.push(record);
  if (records.shift()?.join(',') !== 'ts_code,shares,cost') throw new Error("CSV header: ts_code,shares,cost");
  const seen = new Set<string>();
  return records.map((r, i) => {
    if (r.length !== 3) throw new Error(`CSV row ${i+2}: expected 3 fields`);
    const ts_code=validCode(r[0]);
    if (seen.has(ts_code)) throw new Error(`Duplicate code: ${ts_code}`);
    seen.add(ts_code);
    return {ts_code, shares:finiteQuantity(r[1]),cost:finiteQuantity(r[2])};
  });
}

export const escapeHtml = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g,
  c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]!));

/** 带符号金额。非有限值保持未知（W5-10：NaN/Infinity 不再显示 "+¥NaN"/"+¥∞"）。 */
export const signedMoney = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  return `${v < 0 ? '−' : '+'}¥${Math.abs(v).toLocaleString('en-US')}`;
};

/** 先按**未舍入**原始值定符号、再四舍五入显示（W6-07 负零）。
 *  (-0.5, 0) 元不再舍入成 -0 后被当成上涨：符号取原始值，显示 −¥0。 */
export const signedMoneyRounded = (v: number): string => {
  if (!Number.isFinite(v)) return "—";
  const sign = v < 0 ? '−' : '+';
  return `${sign}¥${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
};

/** 涨跌方向（图表着色用）。非有限/缺值 → flat；-0 按原始值判号。 */
export const signedTone = (v: number | null | undefined): "up" | "down" | "flat" => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "flat";
  if (v > 0) return "up";
  if (v < 0 || Object.is(v, -0)) return "down";
  return "flat";
};

/** 自选行的报价状态：missing=股票池外/无任何行情，stale=只有过期报价（W9-17/W5-12）。 */
export interface QuoteStateRow {
  ts_code: string;
  is_stale?: boolean;
  quote_missing?: boolean;
  quote_date?: string | null;
}

export function quoteState(row: QuoteStateRow): "missing" | "stale" | "ok" {
  if (row.quote_missing) return "missing";
  if (row.is_stale) return "stale";
  return "ok";
}

/** 把自选行拆成「未收录/无行情」与「报价过期」两类，供 banner 分别提示。 */
export function watchQuoteIssues(rows: readonly QuoteStateRow[]): { missing: string[]; stale: string[] } {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const row of rows) {
    const state = quoteState(row);
    if (state === "missing") missing.push(row.ts_code);
    else if (state === "stale") stale.push(row.ts_code);
  }
  return { missing, stale };
}

/** CSV 导入池校验（W9-19）：返回不在股票池内的代码；未提供股票池时不做判断。
 *  只用于提示，不阻止导入。 */
export function unknownWatchCodes(
  codes: readonly string[],
  universe: ReadonlySet<string> | null | undefined,
): string[] {
  if (!universe || !universe.size) return [];
  return codes.filter((code) => !universe.has(code));
}
