export type Theme = "dark" | "light";

export interface Palette {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  border: string;
  text: string;
  text2: string;
  muted: string;
  faint: string;
  up: string;
  upSoft: string;
  down: string;
  downSoft: string;
  accent: string;
  accentSoft: string;
  copper: string;
  copperSoft: string;
  warn: string;
  grid: string;
  axis: string;
}

const dark: Palette = {
  bg: "#08090b",
  panel: "#0f1114",
  panel2: "#14171b",
  panel3: "#1a1d22",
  border: "#1e2126",
  text: "#ecedef",
  text2: "#c5c9d1",
  muted: "#9aa1aa",
  faint: "#7b828c",
  up: "#e5484d",
  upSoft: "rgba(229,72,77,0.16)",
  down: "#1fa97a",
  downSoft: "rgba(31,169,122,0.16)",
  accent: "#d9a441",
  accentSoft: "rgba(217,164,65,0.16)",
  copper: "#c9a227",
  copperSoft: "rgba(201,162,39,0.14)",
  warn: "#d9a441",
  grid: "rgba(255,255,255,0.2)",
  axis: "rgba(255,255,255,0.32)",
};

/* 浅色主题：faint/accent/copper 对 bg(#f6f2e8)/panel/panel2/panel3 全部 ≥4.5:1（W14-10）。
 * 旧值 #7f7768=3.96、#a16207=4.40、#9a6b16=4.18 不达 WCAG AA。 */
const light: Palette = {
  bg: "#f6f2e8",
  panel: "#fffdf8",
  panel2: "#f3eee3",
  panel3: "#e9e3d5",
  border: "#e2dbcb",
  text: "#1a1b1d",
  text2: "#45413a",
  muted: "#665f53",
  faint: "#6b6355",
  up: "#a83a3a",
  upSoft: "rgba(168,58,58,0.10)",
  down: "#2e6b57",
  downSoft: "rgba(46,107,87,0.10)",
  accent: "#8a5406",
  accentSoft: "rgba(138,84,6,0.10)",
  copper: "#7d5710",
  copperSoft: "rgba(140,47,47,0.08)",
  warn: "#b54708",
  grid: "rgba(26,27,29,0.46)",
  axis: "rgba(26,27,29,0.55)",
};

const darkCb: Palette = {
  ...dark,
  up: "#4c8dff",
  down: "#e8a33d",
  upSoft: "rgba(76,141,255,.16)",
  downSoft: "rgba(232,163,61,.16)",
};
const lightCb: Palette = {
  ...light,
  up: "#175cd3",
  down: "#b54708",
  upSoft: "rgba(23,92,211,.10)",
  downSoft: "rgba(181,71,8,.10)",
};

/* 未知主题（?theme=neon / 被污染的 localStorage）绝不能返回 undefined：
 * 否则页面读 p.up 直接白屏且刷新后不可恢复（W5-02）。 */
const knownTheme = (theme: unknown, fallback: Theme): Theme =>
  theme === "dark" || theme === "light" ? theme : fallback;

export const isTheme = (value: unknown): value is Theme => value === "dark" || value === "light";

/** 静态色板表（打印/简报用浅色）；直接用 palettes[非法值] 仍会 undefined，故保留 paletteFor。 */
export const palettes: Record<Theme, Palette> = { dark, light };

export const paletteFor = (theme: Theme, colorblind: boolean): Palette => {
  const safe = knownTheme(theme, "dark");
  if (colorblind) return safe === "dark" ? darkCb : lightCb;
  return safe === "dark" ? dark : light;
};

/** 分类色板：不含红绿，红绿只表方向 */
export const seriesColors = (p: Palette): string[] =>
  p.bg === "#f6f2e8"
    ? ["#8a5406", "#9d174d", "#b45309", "#7c2d12", "#1f2937", "#a21caf", "#a16207", "#4b5563"]
    : SW_COLORS;

export const SW_COLORS = [
  "#d9a441",
  "#e0619b",
  "#c47a3d",
  "#8a7f6a",
  "#b58b5a",
  "#d65db1",
  "#a8a29a",
  "#6b6255",
];

/** 系统级「减少动态效果」：CSS 已有 @media 规则，ECharts 动画也要关掉（W14-16）。 */
export const prefersReducedMotion = (): boolean => {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
};

/** ECharts 基础主题：字体、提示框、坐标轴、动画 */
export function baseChart(p: Palette) {
  const reduced = prefersReducedMotion();
  return {
    backgroundColor: "transparent",
    animation: !reduced,
    animationDuration: reduced ? 0 : 240,
    animationEasing: "cubicOut" as const,
    textStyle: {
      fontFamily:
        '"Inter Variable", Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
      color: p.text2,
      fontSize: 12.5,
    },
    tooltip: {
      backgroundColor: p.panel2,
      borderColor: p.border,
      borderWidth: 1,
      padding: [9, 11],
      textStyle: { color: p.text, fontSize: 12.5 },
      extraCssText:
        "backdrop-filter: blur(10px); border-radius: 8px; box-shadow: 0 16px 40px rgba(0,0,0,.42);",
      axisPointer: {
        type: "line" as const,
        lineStyle: { color: p.axis, width: 1, type: "dashed" as const },
      },
    },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
  };
}

export function axisStyle(p: Palette) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: p.muted,
      fontSize: 12,
      fontFamily: "JetBrains Mono Variable, JetBrains Mono, monospace",
    },
    splitLine: { show: true, lineStyle: { color: p.grid, width: 1 } },
  };
}

export interface SymmetricDomain {
  /** y 轴对称上限（≥ floor，且一定覆盖 includeMax）。 */
  max: number;
  /** 超出轴上限的真实观测（含原始值）；绘制时可放在端部，但不能丢真实值。 */
  clipped: Array<{ index: number; value: number }>;
}

/**
 * 双侧坐标轴自适应域：按分位留白，但绝不允许「先截尾再作图」。
 * 超过轴上限的点会被如实列出（clipped），由页面对其做端部标记 + 图注真实值（P1-4/W9-03）。
 * 纯函数、无 import，便于 node --test 直接断言轴域。
 */
export function symmetricDomain(
  values: ReadonlyArray<number | null | undefined>,
  options: { percentile?: number; headroom?: number; floor?: number; step?: number; includeMax?: number } = {},
): SymmetricDomain {
  const percentile = Math.min(0.999, Math.max(0, options.percentile ?? 0.99));
  const headroom = Math.max(1, options.headroom ?? 1.15);
  const floor = Math.max(1, options.floor ?? 100);
  const step = Math.max(1, options.step ?? 100);
  const includeMax = Math.max(0, options.includeMax ?? 0);

  const magnitudes = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .map((v) => Math.abs(v))
    .sort((a, b) => a - b);
  const quantile = magnitudes.length
    ? magnitudes[Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * percentile))]
    : 0;
  const max = Math.ceil(Math.max(quantile * headroom, includeMax, floor) / step) * step;

  const clipped: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) > max) {
      clipped.push({ index, value });
    }
  });
  return { max, clipped };
}
