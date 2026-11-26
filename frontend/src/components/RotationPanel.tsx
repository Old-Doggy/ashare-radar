/** 行业强度云（轮动模式）播放容器。
 *
 * 职责：档位状态、rAF 播放循环、矩阵/平滑/轴范围计算、把每帧 series 推给 LiveChart。
 * 数字与排名一律取原始列；只有图形坐标经过 smoothMatrix 平滑。
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SectorRollDay } from "../lib/api";
import type { Palette } from "../lib/theme";
import { bounds, coordAt, leadingIndices, sampleTrail, smoothMatrix, toMatrix, type Matrix } from "../lib/rotation";
import { rotationBase, rotationFrame, type RotationBubble, type RotationFrameData } from "../lib/charts6";
import LiveChart, { type LiveChartHandle } from "./LiveChart";
import { PlaybackBar, type PlaybackGroup } from "./PlaybackBar";
import { pct } from "../lib/format";

type RollW = 5 | 10 | 20;
type WinW = 30 | 60 | 120;

const ROLL_OPTS: RollW[] = [5, 10, 20];
const WIN_OPTS: WinW[] = [30, 60, 120];
const SMOOTH_OPTS = [
  { v: 0, k: "smOff" },
  { v: 3, k: "smWeak" },
  { v: 6, k: "smMid" },
  { v: 12, k: "smStrong" },
  { v: 20, k: "smStronger" },
  { v: 32, k: "smExtreme" },
] as const;
const TRAIL_OPTS = [
  { v: 12, k: "tail12" },
  { v: 30, k: "tail30" },
  { v: 60, k: "tail60" },
  { v: 9999, k: "tailFull" },
] as const;
const LABEL_OPTS = [8, 18, 31] as const;
const MS_PER_DAY = 620;
const TRAIL_LINE_DAYS = 30;

const RET_KEY: Record<RollW, "ret_r5" | "ret_r10" | "ret_r20"> = { 5: "ret_r5", 10: "ret_r10", 20: "ret_r20" };
const BR_KEY: Record<RollW, "br_r5" | "br_r10" | "br_r20"> = { 5: "br_r5", 10: "br_r10", 20: "br_r20" };
const RANK_KEY: Record<RollW, "rank_r5" | "rank_r10" | "rank_r20"> = { 5: "rank_r5", 10: "rank_r10", 20: "rank_r20" };

type NumberKey = "ret_r5" | "ret_r10" | "ret_r20" | "br_r5" | "br_r10" | "br_r20" | "rank_r5" | "rank_r10" | "rank_r20";

function numberAt(row: SectorRollDay | null | undefined, key: NumberKey): number | null {
  if (!row) return null;
  const value = (row as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usePrefersReducedMotion(): boolean {
  return useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
}

export interface RotationPanelHandle {
  pause: () => void;
  getPos: () => number;
  /** 先同步暂停 rAF，再取当前帧 PNG（F6-6：导出前必须 pause）。 */
  exportPng: (bg: string) => { url: string; date: string } | null;
  /** 测试/验收用：当前档位快照 */
  snapshot: () => { pos: number; playing: boolean; smoothHalf: number; rollW: number; winLen: number };
}

interface Props {
  rows: SectorRollDay[];
  p: Palette;
  lang: string;
  selected: string | null;
  onSelect: (name: string) => void;
}

export const RotationPanel = forwardRef<RotationPanelHandle, Props>(function RotationPanel(
  { rows, p, lang, selected, onSelect },
  ref,
) {
  const { t } = useTranslation();
  const zh = lang !== "en";
  const reduceMotion = usePrefersReducedMotion();
  const liveRef = useRef<LiveChartHandle>(null);

  const [rollW, setRollW] = useState<RollW>(10);
  const [winLen, setWinLen] = useState<WinW>(30);
  // X5：prefers-reduced-motion 命中时初始平滑更狠（强=12），降低视觉运动量。
  const [smoothHalf, setSmoothHalf] = useState<number>(reduceMotion ? 12 : 20);
  const [tailLen, setTailLen] = useState<number>(9999);
  const [labelTop, setLabelTop] = useState<number>(18);
  const [speed, setSpeed] = useState<number>(1);
  const [playing, setPlaying] = useState<boolean>(false);
  const [hover, setHover] = useState<number>(-1);

  const days = useMemo(() => [...new Set(rows.map((r) => r.trade_date))].sort(), [rows]);
  const sectors = useMemo(() => [...new Set(rows.map((r) => r.sw_l1))].sort((a, b) => a.localeCompare(b, "zh")), [rows]);
  const total = Math.min(winLen, days.length);
  const endDay = days.length - 1;
  const startDay = Math.max(0, days.length - total);
  const K = Math.max(1, endDay - startDay + 1);

  const [pos, setPos] = useState<number>(() => K - 1);
  const posRef = useRef(pos);
  posRef.current = pos;
  const rafRef = useRef(0);

  useEffect(() => {
    setPos((prev) => Math.min(prev, Math.max(0, K - 1)));
  }, [K]);

  // 扁平行 → [frame][sector] 矩阵；再平滑（只影响图形坐标）
  const rawRows = useMemo(() => {
    const index = new Map<string, SectorRollDay>();
    for (const row of rows) index.set(`${row.trade_date}|${row.sw_l1}`, row);
    return days.map((day) => sectors.map((sector) => index.get(`${day}|${sector}`) ?? null));
  }, [rows, days, sectors]);

  const raw = useMemo<Matrix>(() => {
    const retKey = RET_KEY[rollW];
    const brKey = BR_KEY[rollW];
    return toMatrix(
      rows,
      sectors,
      days,
      (row) => {
        const value = numberAt(row, retKey);
        return value === null ? null : value * 100;
      },
      (row) => {
        const value = numberAt(row, brKey);
        return value === null ? null : value * 100;
      },
    );
  }, [rows, sectors, days, rollW]);

  const smooth = useMemo(() => smoothMatrix(raw, smoothHalf), [raw, smoothHalf]);
  const band = useMemo(() => bounds(smooth, startDay, endDay), [smooth, startDay, endDay]);
  const columns = useMemo(() => sectors.map((_, si) =>
    smooth.slice(startDay, endDay + 1).map((f) => f[si] ?? null),
  ), [sectors, smooth, startDay, endDay]);
  const maxAmount = useMemo(() => {
    let max = 0;
    for (const rows of rawRows.slice(startDay, endDay + 1)) {
      for (const row of rows) {
        if (typeof row?.amount === "number" && Number.isFinite(row.amount)) max = Math.max(max, row.amount);
      }
    }
    return max;
  }, [rawRows, startDay, endDay]);

  const selIdx = useMemo(() => {
    const index = selected ? sectors.indexOf(selected) : -1;
    return index >= 0 ? index : -1;
  }, [selected, sectors]);

  const focus = hover >= 0 ? hover : selIdx;
  const frameIdx = Math.min(endDay, Math.max(startDay, startDay + Math.round(pos)));
  const frame = Math.min(days.length - 1, Math.max(0, frameIdx));


  const labelIdx = useMemo(() => {
    const lastRows = rawRows[endDay] ?? [];
    const rankKey = RANK_KEY[rollW];
    const order = sectors
      .map((_, i) => ({ i, rank: numberAt(lastRows[i], rankKey) }))
      .filter((o): o is { i: number; rank: number } => o.rank !== null)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, labelTop);
    return new Set(order.map((o) => o.i));
  }, [rawRows, endDay, sectors, rollW, labelTop]);

  const frameData = useMemo<RotationFrameData>(() => {
    const retKey = RET_KEY[rollW];
    const brKey = BR_KEY[rollW];
    const rankKey = RANK_KEY[rollW];
    const rowFrame = rawRows[frame] ?? [];
    const bubbles: RotationBubble[] = sectors.map((name, si) => {
      const row = rowFrame[si] ?? null;
      const rank = numberAt(row, rankKey);
      const amt = typeof row?.amount === "number" && Number.isFinite(row.amount) && row.amount >= 0 ? row.amount : null;
      return {
        name,
        coord: coordAt(columns[si], pos),
        ret: numberAt(row, retKey),
        breadth: numberAt(row, brKey),
        rank,
        amt,
        weight: amt !== null && maxAmount > 0 ? amt / maxAmount : 0,
      };
    });
    const col = columns[focus] ?? [];
    const trail = focus >= 0 ? sampleTrail(col, pos, tailLen, TRAIL_LINE_DAYS, 70) : { dots: [], line: [] };
    const ghost = col[0] ?? null;
    const current = bubbles[focus]?.coord ?? null;
    return {
      bubbles,
      focus: selIdx,
      hover,
      labelIdx,
      trail,
      ghost,
      current,
      displacementValid: col.slice(0, Math.ceil(pos) + 1).every((p) => p !== null),
      focusName: focus >= 0 ? sectors[focus] : "",
    };
  }, [columns, rawRows, sectors, frame, focus, selIdx, hover, labelIdx, rollW, tailLen, pos, maxAmount]);

  useEffect(() => {
    liveRef.current?.setBase(rotationBase(p, band, rollW, lang));
  }, [p, band, rollW, lang]);

  useEffect(() => {
    liveRef.current?.patchSeries(rotationFrame(p, frameData));
  }, [p, frameData, band, rollW, lang]);

  // rAF 播放循环：唯一一处 requestAnimationFrame，卸载/StrictMode 都会 cancel（X13/X14）
  useEffect(() => {
    if (!playing) return;
    let last = 0;
    const step = (now: number) => {
      if (!last) last = now;
      const dt = Math.min(120, Math.max(0, now - last));
      last = now;
      setPos((prev) => {
        const next = prev + dt / (MS_PER_DAY / speed);
        if (next >= K - 1) return K > 1 ? 0 : K - 1;
        return next;
      });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [playing, speed, K]);

  // X10 键盘：空格播放/暂停、← → 单日步进、Esc 退出播放
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "Escape") {
        setPlaying(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, a, [contenteditable=true]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((v) => !v);
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setPos((v) => Math.max(0, Math.round(v) - 1));
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setPos((v) => Math.min(K - 1, Math.round(v) + 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [K]);

  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const events = useMemo(
    () => ({
      mouseover: (params: unknown) => {
        const i = (params as { data?: { idx?: number } })?.data?.idx;
        if (typeof i === "number") setHover(i);
      },
      mouseout: () => setHover(-1),
      click: (params: unknown) => {
        const name = (params as { data?: { name?: string } })?.data?.name;
        if (name) selectRef.current(name);
      },
    }),
    [],
  );

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const pauseNow = () => {
    setPlaying(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
  };

  const nowDate = days[frame] ?? "—";
  useImperativeHandle(
    ref,
    () => ({
      pause: pauseNow,
      getPos: () => posRef.current,
      exportPng: (bg) => {
        pauseNow();
        const url = liveRef.current?.getDataURL(bg);
        return url ? { url, date: nowDate } : null;
      },
      snapshot: () => ({ pos: posRef.current, playing: playingRef.current, smoothHalf, rollW, winLen }),
    }),
    [smoothHalf, rollW, winLen, nowDate],
  );

  const groups: PlaybackGroup[] = [
    {
      label: t("rotate.window"),
      value: winLen,
      options: WIN_OPTS.map((v) => ({ v, k: zh ? `${v}日` : `${v}d` })),
      onChange: (v) => {
        setWinLen(v as WinW);
        setPos(Math.max(0, Math.min(v, days.length) - 1));
        setPlaying(false);
      },
    },
    {
      label: t("rotate.roll"),
      value: rollW,
      options: ROLL_OPTS.map((v) => ({ v, k: String(v) })),
      onChange: (v) => {
        setRollW(v as RollW);
        setPos(Math.max(0, Math.min(winLen, days.length) - 1));
        setPlaying(false);
      },
    },
    {
      label: t("rotate.smooth"),
      value: smoothHalf,
      options: SMOOTH_OPTS.map((o) => ({ v: o.v, k: t(`rotate.${o.k}`) })),
      onChange: (v) => setSmoothHalf(v),
    },
    {
      label: t("rotate.trail"),
      value: tailLen,
      options: TRAIL_OPTS.map((o) => ({ v: o.v, k: t(`rotate.${o.k}`) })),
      onChange: (v) => setTailLen(v),
      important: true,
    },
    {
      label: t("rotate.labels"),
      value: labelTop,
      options: LABEL_OPTS.map((v) => ({ v, k: String(v) })),
      onChange: (v) => setLabelTop(v),
    },
  ];

  const leaders = leadingIndices(frameData.bubbles.map((bubble) => bubble.rank)).map((i) => frameData.bubbles[i]);
  const leader = leaders[0];
  const leaderNames = leaders.map((bubble) => bubble.name).join(zh ? "、" : ", ");

  return (
    <div
      className="flex h-full flex-col"
      data-testid="rotation-panel"
      data-playing={playing ? "1" : "0"}
      data-smoothing={smoothHalf}
      data-roll={rollW}
      data-window={winLen}
      data-trail={tailLen}
      data-labels={labelTop}
      data-pos={pos.toFixed(3)}
      data-frame={frame}
      data-leader-rank={leader ? String(leader.rank) : ""}
      data-leader-name={leaderNames}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pb-1 pt-2 md:px-4">
        <span className="mono text-[16px] leading-none text-[var(--accent)]">{nowDate}</span>
        <span className="text-[11px] text-[var(--muted)]">{playing ? t("rotate.playing") : `${Math.round(pos) + 1} / ${K}`}</span>
        <span className="ml-auto text-[11.5px] text-[var(--muted)]">
          {leader ? (
            <>
              {t(leaders.length > 1 ? "rotate.tiedLeading" : "rotate.leading")} <b className="text-[var(--text)]">{leaderNames}</b>{" "}
              <span className={`mono ${(leader.ret ?? 0) >= 0 ? "text-[var(--up)]" : "text-[var(--down)]"}`}>{pct(leader.ret)}</span>{" "}
              <span className="mono text-[var(--faint)]">#{leader.rank}</span>
            </>
          ) : (
            "—"
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 px-1 pb-1 md:px-2">
        <LiveChart ref={liveRef} height="100%" onEvents={events} ariaLabel={zh ? "行业强度云轮动图" : "Sector rotation cloud"} />
      </div>
      <div className="px-3 pb-1 text-[10.5px] leading-relaxed text-[var(--faint)] md:px-4">{t("rotate.hint")}</div>
      <PlaybackBar
        n={K}
        pos={pos}
        playing={playing}
        onToggle={() => setPlaying((v) => !v)}
        onReplay={() => {
          setPos(0);
          setPlaying(true);
        }}
        onSeek={(value) => {
          setPlaying(false);
          setPos(Math.max(0, Math.min(K - 1, value)));
        }}
        onStep={(delta) => {
          setPlaying(false);
          setPos((v) => Math.max(0, Math.min(K - 1, Math.round(v) + delta)));
        }}
        speed={speed}
        onSpeed={setSpeed}
        groups={groups}
        date={nowDate}
      />
    </div>
  );
});
