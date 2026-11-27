/** 轮动图纯函数：帧化矩阵 / 指数平滑 / 浮点帧插值 / 轨迹采样 / 轴范围。
 *
 * 只依赖数值，不碰 DOM、不碰 echarts —— `node --experimental-strip-types` 可直接单测。
 * 口径约定：矩阵里存的是**显示坐标**（收益与广度都 ×100，单位 %）；
 * 排名与所有展示数字一律取原始列，平滑只作用于图形坐标。
 */

export interface Pt {
  x: number;
  y: number;
}

/** [frame][sector] 的固定顺序矩阵；缺失为 null。 */
export type Matrix = (Pt | null)[][];

export interface TrailDot {
  t: number;
  p: Pt;
}

export interface Trail {
  dots: TrailDot[];
  /** 实线点；null 表示此处数据有缺口，折线必须断开（不能用一条直线跨过空档）。 */
  line: (Pt | null)[];
}

export interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** 演示数据/接口行的最小形状：其余列由 keyX/keyY 取值。 */
export interface RollRow {
  trade_date: string;
  sw_l1: string;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 固定窗口兜底轴范围：有限、且含 x=0 / y=50（B8/B9）。 */
const EMPTY_BOUNDS: Bounds = { x0: -1, x1: 1, y0: 0, y1: 100 };

/** 把扁平行折成 [frame][sector] 矩阵；缺行/缺值为 null，不用前值填充（B1）。 */
export function toMatrix<T extends RollRow>(
  rows: readonly T[],
  sectors: readonly string[],
  days: readonly string[],
  keyX: (row: T) => number | null | undefined,
  keyY: (row: T) => number | null | undefined,
): Matrix {
  const out: Matrix = days.map(() => sectors.map(() => null));
  if (!rows.length || !sectors.length || !days.length) return out;

  const dayIndex = new Map<string, number>();
  days.forEach((d, i) => {
    if (!dayIndex.has(d)) dayIndex.set(d, i);
  });
  const sectorIndex = new Map<string, number>();
  sectors.forEach((s, i) => {
    if (!sectorIndex.has(s)) sectorIndex.set(s, i);
  });

  for (const row of rows) {
    const di = dayIndex.get(row.trade_date);
    const si = sectorIndex.get(row.sw_l1);
    if (di === undefined || si === undefined) continue;
    const x = keyX(row);
    const y = keyY(row);
    if (!finite(x) || !finite(y)) continue; // B1：缺值留空，不沿用前值
    out[di][si] = { x, y };
  }
  return out;
}

interface Moments {
  n: number;
  mx: number;
  my: number;
  vx: number;
  vy: number;
}

function moments(cells: Iterable<Pt>): Moments {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of cells) {
    if (!finite(p.x) || !finite(p.y)) continue;
    n += 1;
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
  }
  if (!n) return { n: 0, mx: 0, my: 0, vx: 0, vy: 0 };
  const mx = sx / n;
  const my = sy / n;
  return {
    n,
    mx,
    my,
    vx: Math.max(0, sxx / n - mx * mx),
    vy: Math.max(0, syy / n - my * my),
  };
}

/** 指数平滑 + 离散度还原（R3）。null 会重置 EMA 状态，断点前后不混合（B2）。
 *  全局方差退化为 0 或样本 < 2 时缩放系数取 1（B3/B10）。 */
export function smoothMatrix(m: Matrix, halfLife: number): Matrix {
  const frames = m.length;
  const sectors = frames ? Math.max(...m.map((f) => f.length)) : 0;
  const out: Matrix = m.map((frame) => frame.map((p) => (p ? { x: p.x, y: p.y } : null)));
  if (!(halfLife > 0)) return out;

  const alpha = 1 - Math.pow(0.5, 1 / halfLife);
  for (let s = 0; s < sectors; s += 1) {
    let ex: number | null = null;
    let ey: number | null = null;
    for (let t = 0; t < frames; t += 1) {
      const p = m[t]?.[s] ?? null;
      if (!p || !finite(p.x) || !finite(p.y)) {
        ex = null; // B2：断点重置，避免跨缺口混合
        ey = null;
        continue;
      }
      ex = ex === null ? p.x : alpha * p.x + (1 - alpha) * ex;
      ey = ey === null ? p.y : alpha * p.y + (1 - alpha) * ey;
      out[t][s] = { x: ex, y: ey };
    }
  }

  // EMA 会把离散度压小（半衰期越长压得越狠）。做一次全局线性还原：
  // 均值/方差回到原始水平，不改变相对位置，也不改变排序。
  const smoothed = moments(out.flat().filter((p): p is Pt => p !== null));
  const raw = moments(m.flat().filter((p): p is Pt => p !== null));
  if (smoothed.n < 2 || raw.n < 2 || smoothed.vx <= 1e-12 || smoothed.vy <= 1e-12) return out; // B3/B10
  const kx = Math.sqrt(Math.max(1e-12, raw.vx) / smoothed.vx);
  const ky = Math.sqrt(Math.max(1e-12, raw.vy) / smoothed.vy);
  if (!finite(kx) || !finite(ky)) return out;
  for (let t = 0; t < frames; t += 1) {
    for (let s = 0; s < out[t].length; s += 1) {
      const p = out[t][s];
      if (!p) continue;
      out[t][s] = {
        x: raw.mx + (p.x - smoothed.mx) * kx,
        y: Math.max(0, Math.min(100, raw.my + (p.y - smoothed.my) * ky)),
      };
    }
  }
  return out;
}

/** 只在相邻有效帧内插值，缺失交易日没有坐标。 */
export function coordAt(col: readonly (Pt | null)[], pos: number): Pt | null {
  const last = col.length - 1;
  if (last < 0) return null;
  const raw = finite(pos) ? pos : 0;
  const p = Math.min(last, Math.max(0, raw));
  const k0 = Math.floor(p);
  const k1 = Math.min(last, k0 + 1);
  const f = p - k0;
  const a = col[k0] ?? null;
  const b = col[k1] ?? null;
  if (f === 0) return a;
  if (!a || !b) return null;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** 采样区间 [a,b] 之间的整数帧里是否出现过缺失点（用于折断实线，R5/P2b）。 */
function missingBetween(col: readonly (Pt | null)[], a: number, b: number): boolean {
  const lo = Math.floor(Math.min(a, b));
  const hi = Math.ceil(Math.max(a, b));
  for (let k = lo; k <= hi; k += 1) if (!col[k]) return true;
  return false;
}

/** 轨迹采样：全程面包屑点 + 最近 lineDays 实线（R5）。
 *  pos < 1 时不抛错：要么 2 点，要么 1 点 + 空线（B7）。
 *  line 中的 null 是断点标记：跨过缺失帧的实线必须断开，不能连成直线。 */
export function sampleTrail(
  col: readonly (Pt | null)[],
  pos: number,
  tailLen: number = Number.POSITIVE_INFINITY,
  lineDays = 30,
  maxDots = 70,
): Trail {
  const last = col.length - 1;
  if (last < 0) return { dots: [], line: [] };
  const clamped = Math.min(last, Math.max(0, finite(pos) ? pos : 0));
  const tail = finite(tailLen) ? Math.max(0, Math.min(tailLen, clamped)) : clamped;
  const t0 = clamped - tail;
  const span = clamped - t0;

  if (span <= 1e-9) {
    const p = coordAt(col, clamped);
    return { dots: p ? [{ t: clamped, p }] : [], line: [] }; // B7 兜底：1 点 + 空线
  }

  const cap = Math.max(2, Math.floor(finite(maxDots) ? maxDots : 70));
  const n = Math.min(cap, Math.max(2, Math.round(span * 1.2) + 1));
  const dots: TrailDot[] = [];
  const broken: boolean[] = []; // broken[i]：第 i 个点与前一个点之间存在缺失帧
  let prevT: number | null = null;
  for (let i = 0; i < n; i += 1) {
    const t = t0 + (span * i) / (n - 1);
    const p = coordAt(col, t);
    if (!p) continue;
    dots.push({ t, p });
    broken.push(prevT === null ? false : missingBetween(col, prevT, t));
    prevT = t;
  }
  const lineFrom = clamped - Math.max(0, finite(lineDays) ? lineDays : 0);
  const line: (Pt | null)[] = [];
  dots.forEach((dot, i) => {
    if (dot.t < lineFrom) return;
    if (broken[i] && line.length) line.push(null);
    line.push(dot.p);
  });
  return { dots, line };
}

/** 固定窗口的轴范围（用平滑后的矩阵算，C4）。窗口内全空 → 有限兜底（B8），且含 0/50（B9）。 */
export function bounds(m: Matrix, startDay: number, endDay: number): Bounds {
  const frames = m.length;
  if (!frames) return { ...EMPTY_BOUNDS };
  const lo = Math.max(0, Math.min(frames - 1, Math.min(startDay, endDay)));
  const hi = Math.max(0, Math.min(frames - 1, Math.max(startDay, endDay)));
  let x0 = 0, x1 = 0, y0 = 50, y1 = 50;
  let hasData = false;
  for (let t = lo; t <= hi; t += 1) {
    for (const p of m[t] ?? []) {
      if (!p || !finite(p.x) || !finite(p.y)) continue;
      hasData = true;
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
  }
  if (!hasData) return { ...EMPTY_BOUNDS };
  const padX = Math.max(1.2, (x1 - x0) * 0.14);
  const padY = Math.max(1.2, (y1 - y0) * 0.18);
  x0 -= padX;
  x1 += padX;
  y0 -= padY;
  y1 += padY;
  const result: Bounds = {
    x0: Number(x0.toFixed(2)),
    x1: Number(x1.toFixed(2)),
    y0: Math.max(0, Number(y0.toFixed(1))),
    y1: Math.min(100, Number(y1.toFixed(1))),
  };
  if (![result.x0, result.x1, result.y0, result.y1].every(finite)) return { ...EMPTY_BOUNDS }; // B8
  return result;
}

export function leadingIndices(ranks: readonly (number | null)[]): number[] {
  const best = Math.min(...ranks.filter(finite));
  return ranks.flatMap((rank, i) => rank === best ? [i] : []);
}

/* ===== 行业页（Sectors）展示口径纯函数：排序 / 默认选中 / breadth 文案 / 分布条 / 月度热力 =====
 * 这些函数只做展示口径，不重算后端指标；放在本模块是因为它们与轮动同属行业页，
 * 且模块无运行时依赖，`node --experimental-strip-types` 可直接单测。 */

export interface SectorBoardRow {
  sw_l1: string;
  breadth: number | null;
  ew_ret?: number | null;
}

const valueOr = (v: number | null | undefined, fallback: number): number => (finite(v) ? v : fallback);

/** 行业广度榜排序：广度降序 → 等权收益降序 → 名称码位（W8-03）。
 *  加入 tiebreak 后，API（ew_ret DESC）与静态 payload（trade_date, sw_l1）两路径名次一致。 */
export function sortSectorBoard<T extends SectorBoardRow>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => {
    const ba = valueOr(a.breadth, -Infinity);
    const bb = valueOr(b.breadth, -Infinity);
    if (ba !== bb) return bb - ba;
    const ea = valueOr(a.ew_ret, -Infinity);
    const eb = valueOr(b.ew_ret, -Infinity);
    if (ea !== eb) return eb - ea;
    return a.sw_l1.localeCompare(b.sw_l1, "zh");
  });
}

/** 默认选中行业（W8-02）：显式参数存在则优先；否则按确定规则取（广度最大→收益最大→名称）。
 *  绝不使用 rows[0]，因此在线 API 与离线 payload 首屏选中的是同一行业。 */
export function pickDefaultSector(
  rows: readonly SectorBoardRow[],
  preferred?: string | null,
): string | null {
  if (preferred && rows.some((r) => r.sw_l1 === preferred)) return preferred;
  const board = sortSectorBoard(rows);
  return board.length ? board[0].sw_l1 : null;
}

/** breadth 口径文案（W8-06）：契约 = 上涨家数/(上涨+下跌)，平盘剔除。
 *  页面标题/副标题/口径说明统一走这一句，避免再写成“上涨股票占比/100% 的股票在涨”。 */
export function breadthBasisText(lang: string): string {
  return lang === "en"
    ? "advancers / (advancers + decliners); flats excluded"
    : "上涨家数 /（上涨 + 下跌），平盘剔除";
}

/** q10–q90 分布条轴域（W8-05）：默认 ±11%，数据越界时按 |q10|/|q90| 自适应并向上取整到 1%。
 *  返回的是半宽（如 0.21 表示 ±21%），条形位置统一用 distributionPercent 映射，不再静默截尾。 */
export function distributionDomain(
  q10: number | null | undefined,
  q90: number | null | undefined,
  floor = 0.11,
): number {
  const values = [q10, q90].filter(finite).map((v) => Math.abs(v));
  const dom = Math.max(floor, ...values);
  if (!finite(dom) || dom <= 0) return floor;
  // 向上取整到 1%，减去微小容差避免 0.11*100=11.0000001 被进到 12
  return Math.ceil(dom * 100 - 1e-6) / 100;
}

/** 把收益映射到分布条 0..100 位置；未知返回 null（调用方保持“—”/不画）。 */
export function distributionPercent(
  value: number | null | undefined,
  domain: number,
): number | null {
  if (!finite(value) || !finite(domain) || domain <= 0) return null;
  return Math.max(0, Math.min(100, ((value + domain) / (2 * domain)) * 100));
}

export interface HeatRow {
  name: string;
  score: number | null;
  values: (number | null)[];
}

/** 月度热力排序（W8-07）：有 score 的按累计收益降序，缺月的行保留并排到末尾（灰显），
 *  同分按名称码位，保证行数 = 行业总数而不是被 filter 掉。 */
export function sortHeatRows<T extends { name: string; score: number | null }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => {
    const sa = finite(a.score) ? a.score : null;
    const sb = finite(b.score) ? b.score : null;
    if (sa !== null && sb !== null && sa !== sb) return sb - sa;
    if (sa === null && sb !== null) return 1;
    if (sa !== null && sb === null) return -1;
    return a.name.localeCompare(b.name, "zh");
  });
}

/** 月度热力分组：all=全部行业一组；focus=领涨/落后各 split 个（缺月行自然落在末尾组）。
 *  返回值中缺月行仍然存在，由 MonthlyGrid 灰显。 */
export function heatGroups<T extends { name: string; score: number | null }>(
  rows: readonly T[],
  scope: "focus" | "all",
  split = 6,
): T[][] {
  const sorted = sortHeatRows(rows);
  if (!sorted.length) return [];
  if (scope === "all") return [sorted];
  if (sorted.length <= split * 2) return [sorted];
  return [sorted.slice(0, split), sorted.slice(-split)];
}

export function missingHeatCount(rows: readonly { score: number | null }[]): number {
  return rows.filter((r) => !finite(r.score)).length;
}

/* ===== 无障碍：reduced-motion 初始平滑（W8-04） ===== */

/** 常规默认平滑半衰期（“更强”档） */
export const DEFAULT_SMOOTH_HALF_LIFE = 20;
/** prefers-reduced-motion 命中的初始平滑半衰期：必须比常规默认**更狠**（半衰期越长帧间运动越小）。 */
export const REDUCED_MOTION_SMOOTH_HALF_LIFE = 32;

/** W8-04：reduced-motion 的初始平滑方向修正。
 *  旧实现取 12（低于常规 20），导致减少动态效果的用户反而得到更大帧间运动。 */
export function initialSmoothHalfLife(reduceMotion: boolean): number {
  return reduceMotion ? REDUCED_MOTION_SMOOTH_HALF_LIFE : DEFAULT_SMOOTH_HALF_LIFE;
}

/** 轮动面板“领涨/领跌”标签的方向色（CR2-03）：
 *  收益未知时保持中性（flat），不得用 `(ret ?? 0) >= 0` 把 null 染成上涨色。 */
export function leaderRetTone(ret: number | null | undefined): "up" | "down" | "flat" {
  if (!finite(ret) || ret === 0) return "flat";
  return ret > 0 ? "up" : "down";
}
