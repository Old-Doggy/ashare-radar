import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
  /** 重播：回到首帧并开始播放（不能复用 onSeek(0)+onToggle，播放中会卡在首帧） */
  onReplay: () => void;
  onSeek: (pos: number) => void;
  onStep: (d: number) => void;
  speed: number;
  onSpeed: (v: number) => void;
  groups?: PlaybackGroup[];
  /** 当前帧日期，供 aria-live 朗读 */
  date?: string;
}

/** 分组容器：左侧小标签 + 右侧一整块分段控件。
 *  目的是把「窗口 / 滚动 / 平滑 / 轨迹 / 标签」这些并列参数在视觉上分开，
 *  而不是让二十多个按钮连成一片。 */
function Cluster({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`items-center gap-1.5 ${className}`}>
      <span className="shrink-0 whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.06em] text-[var(--faint)]">
        {label}
      </span>
      <div className="flex items-center gap-[2px] rounded-[7px] border border-[var(--border-strong)] bg-[var(--surface)] p-px">
        {children}
      </div>
    </div>
  );
}

const optClass = (active: boolean) =>
  [
    "rounded-[5px] px-[6px] py-[4px] text-[11.5px] leading-none transition-colors",
    active
      ? "bg-[var(--surface-3)] font-medium text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border-strong)]"
      : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-2)]",
  ].join(" ");

const ctrlClass =
  "grid h-[26px] min-w-[26px] place-items-center rounded-[5px] px-[7px] text-[11.5px] leading-none " +
  "text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]";

/** 播放控制条。
 *  第一行：播放 / 步进 / 重播 / 倍速 / 进度
 *  第二行：窗口 / 滚动 / 平滑 / 轨迹 / 标签（可换行，组与组之间留白）
 */
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
    <div className="@container border-t border-[var(--border)] bg-[var(--panel-2)]" role="group" aria-label={t("rotate.playbackControls")}>
      {/* ---------- 第一行：传输控制 ---------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 md:px-4">
        <button
          onClick={onToggle}
          aria-pressed={playing}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-[6px] bg-[var(--text)] px-3 text-[12px] font-semibold text-[var(--panel)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--panel)]"
        >
          <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
          {playing ? t("rotate.pause") : t("rotate.play")}
        </button>

        <div className="flex items-center gap-[2px] rounded-[7px] border border-[var(--border-strong)] bg-[var(--surface)] p-[3px]">
          <button onClick={() => onStep(-1)} className={ctrlClass} aria-label={t("rotate.prevDay")} title={`${t("rotate.prevDay")} (←)`}>
            ◀
          </button>
          <button onClick={() => onStep(1)} className={ctrlClass} aria-label={t("rotate.nextDay")} title={`${t("rotate.nextDay")} (→)`}>
            ▶|
          </button>
          <span className="h-[14px] w-px shrink-0 bg-[var(--border-strong)]" aria-hidden />
          <button
            onClick={onReplay}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[5px] px-2 text-[11.5px] leading-none text-[var(--muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            aria-label={t("rotate.replay")}
          >
            <span aria-hidden>⏮</span>
            <span className="whitespace-nowrap">{t("rotate.replay")}</span>
          </button>
        </div>

        <Cluster label={t("rotate.speed")} className="flex">
          {[0.5, 1, 1.5, 2].map((v) => (
            <button key={v} onClick={() => onSpeed(v)} className={optClass(v === speed)} aria-pressed={v === speed}>
              {v}×
            </button>
          ))}
        </Cluster>

        <div className="flex min-w-[180px] flex-1 items-center gap-3 border-l border-[var(--border)] pl-3">
          <input
            type="range"
            min={0}
            max={max}
            step={0.01}
            value={Math.min(max, Math.max(0, pos))}
            onChange={(e) => onSeek(Number(e.target.value))}
            className="h-1 min-w-0 flex-1 accent-[var(--accent)]"
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

      {/* ---------- 第二行：视图参数 ---------- */}
      {groups.length > 0 && (
        /* flex-wrap + 强制换行点：五组并排约 870px，卡片在 xl 下只有 777–924px，
           直接 wrap 会掉出孤零零的「4+1」。放一个 basis-full 的隐形断点在第 4 组前，
           排不下时固定 3+2，容得下时（容器 ≥840px）全部并成一行。 */
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-[var(--border)] px-3 py-2 md:px-4">
          {groups.map((g, i) => (
            <Fragment key={g.label}>
              {i === 3 && <span aria-hidden className="h-0 basis-full @min-[840px]:hidden" />}
              <Cluster
                label={g.label}
                className={g.important ? "flex" : "hidden min-[900px]:flex"}
              >
                {g.options.map((o) => (
                  <button
                    key={o.v}
                    onClick={() => g.onChange(o.v)}
                    className={optClass(o.v === g.value)}
                    aria-pressed={o.v === g.value}
                  >
                    {o.k}
                  </button>
                ))}
              </Cluster>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
