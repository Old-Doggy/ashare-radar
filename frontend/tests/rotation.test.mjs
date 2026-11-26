import test from "node:test";
import assert from "node:assert/strict";
import {
  bounds,
  coordAt,
  leadingIndices,
  sampleTrail,
  smoothMatrix,
  toMatrix,
} from "../src/lib/rotation.ts";

const pt = (x, y) => ({ x, y });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test("all sectors tied at the best original rank are leaders", () => {
  assert.deepEqual(leadingIndices([null, 1, 1, 3]), [1, 2]);
  assert.deepEqual(leadingIndices([null, null]), []);
});

test("axis bounds include a rare extreme sector rather than clipping it", () => {
  const band = bounds([[...Array.from({length: 100}, () => pt(2, 60)), pt(-35, 1)]], 0, 0);
  assert.ok(band.x0 <= -35 && band.y0 <= 1);
});

/** 总体均值/方差（与 rotation.ts 内还原逻辑同一口径）。 */
function moments(cells) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of cells) {
    if (!p) continue;
    n += 1;
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    syy += p.y * p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  return { n, mx, my, vx: sxx / n - mx * mx, vy: syy / n - my * my };
}

const allCells = (m) => m.flat();

test("B1 toMatrix leaves a missing row as null and never forward-fills", () => {
  const rows = [
    { trade_date: "2026-01-01", sw_l1: "A", x: 1, y: 60 },
    { trade_date: "2026-01-01", sw_l1: "B", x: -1, y: 40 },
    { trade_date: "2026-01-02", sw_l1: "A", x: 2, y: null },
    { trade_date: "2026-01-03", sw_l1: "A", x: 3, y: 70 },
  ];
  const m = toMatrix(
    rows,
    ["A", "B"],
    ["2026-01-01", "2026-01-02", "2026-01-03"],
    (r) => r.x,
    (r) => r.y,
  );
  assert.deepEqual(m[0], [pt(1, 60), pt(-1, 40)]);
  assert.deepEqual(m[1], [null, null], "缺行或 y 为 null 时留空，不沿用前值");
  assert.deepEqual(m[2], [pt(3, 70), null], "B 在末日缺行不能被前值填充");
  assert.deepEqual(toMatrix([], ["A"], ["2026-01-01"], (r) => r.x, (r) => r.y), [[null]]);
});

test("B2 smoothMatrix resets EMA state across nulls instead of bridging the gap", () => {
  const first = pt(100, 0);
  const last = pt(-100, 100);
  const m = [
    [first],
    [null],
    [last],
    [last],
  ];
  const out = smoothMatrix(m, 2);
  assert.equal(out[1][0], null);
  assert.deepEqual(out[0][0], first);
  assert.deepEqual(out[2][0], last, "断点后第一个点必须从原值起步");
  assert.deepEqual(out[3][0], last, "断点后的常量序列不得被断点前数据拉动");
});

test("B3 smoothMatrix on identical data stays finite and unchanged (no divide by zero)", () => {
  const m = Array.from({ length: 6 }, () => [pt(5, 50), pt(5, 50)]);
  const out = smoothMatrix(m, 20);
  for (const p of allCells(out)) {
    assert.deepEqual(p, pt(5, 50));
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("smoothMatrix restores the original dispersion (R3: no 13% squash)", () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const m = Array.from({ length: 60 }, (_, t) => [
    pt(t * 0.4 + rnd() * 6, 45 + t * 0.1 + rnd() * 18),
    pt(Math.sin(t / 5) * 5 + rnd() * 3, 55 + Math.cos(t / 7) * 9),
  ]);
  const out = smoothMatrix(m, 20);
  const a = moments(allCells(out));
  const b = moments(allCells(m));
  assert.equal(a.n, b.n);
  assert.ok(near(a.mx, b.mx, 1e-9), "均值还原");
  assert.ok(near(a.my, b.my, 1e-9), "均值还原");
  assert.ok(near(a.vx, b.vx, Math.max(1e-9, b.vx * 1e-9)), "x 方差还原");
  assert.ok(near(a.vy, b.vy, Math.max(1e-9, b.vy * 1e-9)), "y 方差还原");
});

test("B4 coordAt returns null when both neighbours are null", () => {
  assert.equal(coordAt([null, null], 0.5), null);
  assert.equal(coordAt([], 0), null);
});

test("coordinates on a missing integer frame and its adjacent intervals stay unknown", () => {
  const col = [pt(1, 2), null, pt(3, 4)];
  assert.deepEqual([0.5, 1, 1.5].map((pos) => coordAt(col, pos)), [null, null, null]);
  assert.deepEqual(coordAt(col, 2), pt(3, 4));
  assert.deepEqual(sampleTrail(col, 1.5, 1).line, []);
});

test("B6 coordAt clamps out-of-range frame positions", () => {
  const col = [pt(0, 0), pt(1, 10), pt(2, 20)];
  assert.deepEqual(coordAt(col, -5), pt(0, 0));
  assert.deepEqual(coordAt(col, 99), pt(2, 20));
  assert.deepEqual(coordAt(col, 0.5), pt(0.5, 5));
});

test("B7 sampleTrail at pos < 1 never throws and keeps at least one finite dot", () => {
  const col = Array.from({ length: 40 }, (_, i) => pt(i, 50 + i));
  const zero = sampleTrail(col, 0, 30);
  assert.equal(zero.line.length, 0);
  assert.ok(zero.dots.length >= 1);
  assert.ok(zero.dots.every((d) => Number.isFinite(d.t) && Number.isFinite(d.p.x)));

  const half = sampleTrail(col, 0.4, 30);
  assert.ok(half.dots.length >= 2, "0 < pos < 1 至少给两个点");

  const capped = sampleTrail(col, 39, Number.POSITIVE_INFINITY, 30, 5);
  assert.ok(capped.dots.length <= 5, "maxDots 上限生效");
  assert.ok(capped.line.length < capped.dots.length, "实线只覆盖最近 lineDays");
  assert.deepEqual(capped.line[capped.line.length - 1], capped.dots[capped.dots.length - 1].p);
});

test("sampleTrail breaks the solid line across missing frames instead of drawing a chord (R5/P2b)", () => {
  const col = Array.from({ length: 40 }, (_, i) => pt(i, 50 + i));
  col[27] = null;
  col[28] = null;
  const trail = sampleTrail(col, 39, Number.POSITIVE_INFINITY, 30, 70);
  const breakAt = trail.line.findIndex((p) => p === null);
  assert.ok(breakAt > 0, "跨缺失帧必须留下 null 断点");
  assert.ok(trail.line[breakAt - 1] !== null, "断点前应有点");
  assert.ok(trail.line[breakAt + 1] !== null, "断点后应有点");
  const gaps = trail.line.filter((p) => p === null).length;
  assert.equal(gaps, 1, "一处缺口只留一个断点");
});

test("sampleTrail on complete data never emits a break", () => {
  const col = Array.from({ length: 40 }, (_, i) => pt(i, 50 + i));
  const trail = sampleTrail(col, 39, Number.POSITIVE_INFINITY, 30, 70);
  assert.ok(trail.line.length > 0);
  assert.ok(trail.line.every((p) => p !== null));
});

test("B8/B9 bounds falls back to finite defaults containing 0 and 50, and never loses the quadrants", () => {
  const empty = bounds([], 0, 10);
  assert.deepEqual(empty, { x0: -1, x1: 1, y0: 0, y1: 100 });
  const holes = bounds([[null, null], [null, null]], 0, 1);
  assert.deepEqual(holes, { x0: -1, x1: 1, y0: 0, y1: 100 });

  const positive = Array.from({ length: 8 }, (_, t) => [pt(5 + t * 0.2, 60 + t * 0.5), pt(8, 70)]);
  const b = bounds(positive, 0, 7);
  assert.ok(b.x0 <= 0 && b.x1 >= 0, "x 轴必须含 0（象限竖线）");
  assert.ok(b.y0 <= 50 && b.y1 >= 50, "y 轴必须含 50（象限横线）");
  assert.ok(b.y0 >= 0 && b.y1 <= 100);
});

test("B10 bounds is always finite and smoothMatrix skips scaling for n < 2 samples", () => {
  const single = smoothMatrix([[pt(7, 50)]], 20);
  assert.deepEqual(single, [[pt(7, 50)]]);

  const col = Array.from({ length: 30 }, (_, i) => pt(Math.sin(i / 3) * 4, 40 + (i % 7) * 3));
  const m = col.map((p) => [p]);
  const sm = smoothMatrix(m, 20);
  const b = bounds(sm, 0, 29);
  assert.ok([b.x0, b.x1, b.y0, b.y1].every(Number.isFinite));
  for (const p of allCells(sm)) assert.ok(p === null || (Number.isFinite(p.x) && Number.isFinite(p.y)));
});
