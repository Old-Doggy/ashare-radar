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
