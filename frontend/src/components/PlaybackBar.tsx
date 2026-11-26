import { useTranslation } from "react-i18next";
import { Segmented } from "./Segmented";

export interface PlaybackGroup {
  label: string;
  value: number;
  options: { v: number; k: string }[];
  onChange: (v: number) => void;
  /** 窄屏（<900px）是否保留这一组；X9：小屏只留播放 / 轨迹 / 倍速。 */
  important?: boolean;
}

interface Props {
  n: number;
  pos: number;
  playing: boolean;
  onToggle: () => void;
  onReplay: () => void;
  onSeek: (pos: number) => void;
  onStep: (d: number) => void;
  speed: number;
  onSpeed: (v: number) => void;
  groups?: PlaybackGroup[];
  /** 当前帧日期，供 aria-live 朗读 */
  date?: string;
}

const btn =
  "h-[27px] min-w-[27px] rounded border border-[var(--border)] px-2 font-mono text-[11px] " +
  "text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]";
const group = "items-center gap-1.5";

/** 播放控制条：播放/暂停、单日步进、重播、可折叠的档位组、倍速、进度滑杆。
 * Segmented 的泛型 T 是 string —— 所以 value 用 String()、onChange 里再 Number()。 */
export function PlaybackBar({
  n,
  pos,
  playing,
  onToggle,
  onReplay,
  onSeek,
  onStep,
  speed,
  onSpeed,
  groups = [],
  date,
}: Props) {
  const { t } = useTranslation();
  const max = Math.max(0, n - 1);
  return (
    <div
      className="flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 md:px-4"
      role="group"
      aria-label={t("rotate.playbackControls")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onToggle}
          aria-pressed={playing}
          className={`${btn} border-[var(--text)] bg-[var(--text)] text-[var(--panel)] hover:text-[var(--panel)]`}
        >
          {playing ? "❚❚" : "▶"} {playing ? t("rotate.pause") : t("rotate.play")}
        </button>
        <button onClick={() => onStep(-1)} className={btn} aria-label={t("rotate.prevDay")} title={`${t("rotate.prevDay")} (←)`}>
          ◀
        </button>
        <button onClick={() => onStep(1)} className={btn} aria-label={t("rotate.nextDay")} title={`${t("rotate.nextDay")} (→)`}>
          ▶|
        </button>
        <button
          onClick={onReplay}
          className={`${btn} px-2.5`}
          aria-label={t("rotate.replay")}
        >
          ⏮ {t("rotate.replay")}
        </button>
        {groups.map((g) => (
          <div key={g.label} className={`${group} ${g.important ? "flex" : "hidden min-[900px]:flex"}`}>
            <span className="micro">{g.label}</span>
            <Segmented
              options={g.options.map((o) => ({ value: String(o.v), label: o.k }))}
              value={String(g.value)}
              onChange={(v) => g.onChange(Number(v))}
            />
          </div>
        ))}
        <div className={`${group} flex`}>
          <span className="micro">{t("rotate.speed")}</span>
          <Segmented
            options={[0.5, 1, 1.5, 2].map((v) => ({ value: String(v), label: `${v}×` }))}
            value={String(speed)}
            onChange={(v) => onSpeed(Number(v))}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={max}
          step={0.01}
          value={Math.min(max, Math.max(0, pos))}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="h-1 flex-1 accent-[var(--accent)]"
          aria-label={t("rotate.position")}
          aria-valuetext={`${Math.round(pos) + 1} / ${n}`}
        />
        <span className="mono shrink-0 text-[10.5px] text-[var(--faint)]">
          {Math.round(pos) + 1} / {n}
        </span>
        <span className="sr-only" aria-live="polite">
          {date ?? ""}
        </span>
      </div>
    </div>
  );
}
