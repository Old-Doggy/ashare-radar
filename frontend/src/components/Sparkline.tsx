interface Props {
  /** 序列值；null / NaN / Infinity 视为缺失，折线在该点断开而不是画成 0（W6-12）。 */
  values: (number | null | undefined)[];
  tone?: "up" | "down" | "accent" | "neutral";
  width?: number;
  height?: number;
  fill?: boolean;
  /** UI 语言，用于 aria-label / <title>；默认中文保持旧行为（W6-12/W7-06）。 */
  lang?: string;
  /** 覆盖默认可访问性文案（调用方已本地化时用）。 */
  label?: string;
}

export interface SparklineGeometry {
  hasData: boolean;
  /** 连续有效段组成的折线 path（缺失处断开）。 */
  line: string;
  /** 仅当整段都有效时填充的闭合面积 path。 */
  area: string | null;
  lastPoint: [number, number] | null;
  firstValue: number | null;
  lastValue: number | null;
}

/** 迷你走势图的纯几何计算：非有限值不断线补齐、不当作 0。 */
export function sparklineGeometry(
  values: (number | null | undefined)[],
  width = 84,
  height = 26,
): SparklineGeometry {
  const finite = (values ?? []).map((value) => (value != null && Number.isFinite(value) ? value : null));
  const valid = finite.filter((value): value is number => value != null);
  const empty: SparklineGeometry = { hasData: false, line: "", area: null, lastPoint: null, firstValue: null, lastValue: null };
  if (valid.length < 2) return empty;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const span = max - min || 1;
  const pad = 2;
  const x = (index: number) => pad + (index / (finite.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);

  const segments: string[] = [];
  let current: string[] = [];
  let lastPoint: [number, number] | null = null;
  finite.forEach((value, index) => {
    if (value == null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    const point: [number, number] = [x(index), y(value)];
    current.push(`${current.length ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`);
    lastPoint = point;
  });
  if (current.length) segments.push(current.join(" "));

  const line = segments.filter((segment) => segment.includes("L")).join(" ");
  const area = finite.every((value) => value != null) && lastPoint
    ? `${line} L${x(finite.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`
    : null;
  return { hasData: true, line, area, lastPoint, firstValue: finite[0] ?? null, lastValue: finite[finite.length - 1] ?? null };
}

export const sparklineLabel = (lang: string, sessions = 20): string =>
  lang === "en" ? `Trend over the last ${sessions} sessions` : `近 ${sessions} 个交易日走势`;

export function Sparkline({ values, tone = "neutral", width = 84, height = 26, fill = true, lang = "zh", label }: Props) {
  const geometry = sparklineGeometry(values, width, height);
  const text = label ?? sparklineLabel(lang);
  if (!geometry.hasData) return <div style={{ width, height }} role="img" aria-label={text} />;
  const color =
    tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "accent" ? "var(--accent)" : "var(--muted)";
  const id = `sg-${tone}-${width}-${height}-${values.length}-${Math.round((geometry.firstValue ?? 0) * 1e6)}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={text}>
      <title>{text}</title>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && geometry.area && <path d={geometry.area} fill={`url(#${id})`} />}
      {geometry.line && <path d={geometry.line} fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
      {geometry.lastPoint && <circle cx={geometry.lastPoint[0]} cy={geometry.lastPoint[1]} r="1.8" fill={color} />}
    </svg>
  );
}
