import { cumulativePath } from "../lib/viewMetrics";
import { useId } from "react";
import type { Palette } from "../lib/theme";
import { pct } from "../lib/format";

export interface MonthGroup {
  name: string;
  /** 区间累计收益；窗口内缺月时为 null（W8-07：保留该行业并灰显，不整行丢弃） */
  score: number | null;
  values: (number | null)[];
}

function MiniCard({
  row,
  months,
  min,
  max,
  p,
  lang,
  onSelect,
}: {
  row: MonthGroup;
  months: string[];
  min: number;
  max: number;
  p: Palette;
  lang: string;
  onSelect: (name: string) => void;
}) {
  const id = useId().replace(/:/g, "");
  const zh = lang !== "en";
  const w = 220;
  const h = 74;
  const span = max - min || 1;
  const values = cumulativePath(row.values);
  const hasLine = values.some((v) => v != null);
  const x = (i: number) => 4 + (i / Math.max(1, values.length - 1)) * (w - 8);
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const pts = values.map((v, i) => (v == null ? null : [x(i), y(v)]));
  const line = pts.map((pt, i) => (pt ? `${i && pts[i - 1] ? "L" : "M"}${pt[0].toFixed(1)},${pt[1].toFixed(1)}` : "")).join(" ");
  const area = hasLine ? `${line} L${x(values.length - 1).toFixed(1)},${h - 6} L4,${h - 6} Z` : "";
  // 缺月行业：不画折线，灰显 “—” 并注明数据不足
  const missing = row.score == null;
  const color = missing ? p.muted : row.score! >= 0 ? p.up : p.down;
  const zero = y(0);
  const last = values[values.length - 1];
  return (
    <button
      type="button"
      onClick={() => onSelect(row.name)}
      className={`group rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 pb-1.5 pt-2 text-left transition-colors hover:border-[var(--accent)]/60 hover:bg-[var(--panel-2)] ${missing ? "opacity-70" : ""}`}
      title={`${row.name} · ${months[0]} → ${months[months.length - 1]}${missing ? ` · ${zh ? "窗口内缺月，累计收益未知" : "missing months; cumulative return unknown"}` : ""}`}
    >
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="truncate text-[11.5px] text-[var(--text-2)]">{row.name}</span>
        <span className={`mono shrink-0 text-[11px] ${missing ? "text-[var(--faint)]" : row.score! >= 0 ? "text-[var(--up)]" : "text-[var(--down)]"}`}>
          {pct(row.score)}
        </span>
      </div>
      {hasLine ? (
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-1 block" aria-hidden>
          <defs>
            <linearGradient id={`g-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0.01" />
            </linearGradient>
          </defs>
          <line x1="4" x2={w - 4} y1={zero} y2={zero} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 3" />
          <path d={area} fill={`url(#g-${id})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          {last != null && <circle cx={x(values.length - 1)} cy={y(last)} r="2.6" fill={color} />}
        </svg>
      ) : (
        <div className="mt-1 flex h-[74px] items-center justify-center rounded border border-dashed border-[var(--border)] text-[10.5px] text-[var(--faint)]">
          {zh ? "数据不足（窗口内缺月）" : "Insufficient data (missing months)"}
        </div>
      )}
      <div className="mt-0.5 flex justify-between font-mono text-[9.5px] text-[var(--faint)]">
        <span>{months[0]?.slice(2, 7)}</span>
        <span>{months[months.length - 1]?.slice(2, 7)}</span>
      </div>
    </button>
  );
}

export function MonthlyGrid({
  groups,
  months,
  p,
  lang,
  onSelect,
}: {
  groups: MonthGroup[][];
  months: string[];
  p: Palette;
  lang: string;
  onSelect: (name: string) => void;
}) {
  const values = groups.flat().flatMap((g) => cumulativePath(g.values).filter((v): v is number => v != null));
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const pad = Math.max(0.01, (hi - lo) * 0.08);
  const min = lo - pad;
  const max = hi + pad;
  const zh = lang !== "en";
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group, gi) => {
        const groupMissing = group.filter((r) => r.score == null).length;
        const label =
          groups.length === 1
            ? `${group.length} ${zh ? "个行业" : "sectors"}`
            : gi === 0
              ? zh ? "领涨 6" : "Top 6"
              : groupMissing > 0
                ? zh ? "落后 / 缺月" : "Bottom / missing"
                : zh ? "落后 6" : "Bottom 6";
        return (
        <div key={gi}>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="micro">{label}</span>
            <span className="mono text-[9.5px] text-[var(--faint)]">{zh ? "同一纵轴 · 区间累计" : "shared scale · cumulative"}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {group.map((row) => (
              <MiniCard key={row.name} row={row} months={months} min={min} max={max} p={p} lang={lang} onSelect={onSelect} />
            ))}
          </div>
        </div>
        );
      })}
    </div>
  );
}
