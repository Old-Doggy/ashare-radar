import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { ECharts, EChartsOption } from "echarts";
import EChart, { type EChartHandle } from "./EChart";

export interface ZoomChartHandle {
  /** 当前图面的 PNG data URL，用于换范围时的交叉淡入。 */
  snapshot: () => string | null;
  /** 当前缩放窗口（x 轴百分比）。 */
  getWindow: () => [number, number] | null;
  /** 立即把窗口设到指定位置（用于“镜头拉远”动画的起始帧）。 */
  setWindow: (start: number, end: number) => void;
  /** 带动画把窗口移到指定位置。 */
  animateWindow: (start: number, end: number, duration?: number) => void;
}

interface Props {
  option: EChartsOption;
  ariaLabel?: string;
  /** 换范围 / 复位时淡出的旧图快照（data URL）。 */
  ghostSrc?: string | null;
  /** 每次换图自增，让同一张图连续换范围时动画能重新播放。 */
  ghostKey?: number;
  onGhostEnd?: () => void;
  className?: string;
}

/** 从 dataZoom 事件里取当前窗口百分比（事件只带批量操作里的首个）。 */
const windowFromEvent = (e: unknown): [number, number] | null => {
  const batch = (e as { batch?: { start?: number; end?: number }[] })?.batch;
  const first = batch?.[0];
  if (!first || typeof first.start !== "number" || typeof first.end !== "number") return null;
  return [first.start, first.end];
};

/**
 * 市场结构页的时间序列图容器。
 *
 * - 缩放状态完全活在 ECharts 实例里（非受控），父组件重渲染不会写回；
 * - 双击 / 键盘 0 复位到整段全览（带缓动）；
 * - 键盘：← → 平移，+ / − 缩放，0 / Home 复位；
 * - 换范围时把上一次图面的快照作为 ghost 播一次淡出，避免整图硬切。
 */
const ZoomChart = forwardRef<ZoomChartHandle, Props>(function ZoomChart(
  { option, ariaLabel, ghostSrc, ghostKey, onGhostEnd, className = "" },
  ref,
) {
  const chartRef = useRef<EChartHandle>(null);
  const instRef = useRef<ECharts | null>(null);
  const winRef = useRef<[number, number] | null>(null);
  const tweenRaf = useRef<number | null>(null);
  const lastDown = useRef(0);
  const lastPos = useRef<[number, number]>([0, 0]);

  const cancelTween = useCallback(() => {
    if (tweenRaf.current !== null) {
      cancelAnimationFrame(tweenRaf.current);
      tweenRaf.current = null;
    }
  }, []);

  useEffect(() => cancelTween, [cancelTween]);

  const onReady = useCallback((inst: ECharts) => {
    instRef.current = inst;
    const onZoom = (e: unknown) => {
      const win = windowFromEvent(e);
      if (win) winRef.current = win;
    };
    inst.on("dataZoom", onZoom);
    // 双击复位：浏览器原生 dblclick 会被 ECharts 的 DOM 处理器吞掉（实测外层容器收到 0 次），
    // zrender 的 dblclick 事件也不可靠，所以在 mousedown 上自己判双击（320ms 内、位移 < 6px）。
    const onDown = (e: unknown) => {
      cancelTween();
      const ev = e as { offsetX?: number; offsetY?: number };
      const x = ev.offsetX ?? 0;
      const y = ev.offsetY ?? 0;
      const now = Date.now();
      const double =
        now - lastDown.current < 320 && Math.hypot(x - lastPos.current[0], y - lastPos.current[1]) < 6;
      if (double) {
        lastDown.current = 0;
        const cur = instRef.current;
        if (cur && !cur.isDisposed()) applyWindow(cur, 0, 100, 320);
      } else {
        lastDown.current = now;
        lastPos.current = [x, y];
      }
    };
    const zr = inst.getZr();
    zr.on("mousedown", onDown);
    zr.on("mousewheel", cancelTween);
    return () => {
      if (!inst.isDisposed()) {
        inst.off("dataZoom", onZoom);
        zr.off("mousedown", onDown);
        zr.off("mousewheel", cancelTween);
      }
      if (instRef.current === inst) instRef.current = null;
      winRef.current = null;
      cancelTween();
    };
  }, [cancelTween]);

  // 每次整份 option 重建（换范围 / 主题 / 语言）缩放都会复位，窗口缓存同步失效
  useEffect(() => {
    winRef.current = null;
    cancelTween();
  }, [option, cancelTween]);

  useImperativeHandle(
    ref,
    () => ({
      snapshot: () => {
        // 换范围时 option 刚被 notMerge 替换，EChart 的 lazyUpdate 可能还没落帧；
        // 先 flush zrender，避免交叉淡出拿到上一帧（W6-09）。
        const inst = instRef.current;
        if (inst && !inst.isDisposed()) inst.getZr().flush();
        return chartRef.current?.getDataURL() ?? null;
      },
      getWindow: () => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return null;
        return currentWindow(inst);
      },
      setWindow: (start: number, end: number) => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return;
        applyWindow(inst, start, end, null);
      },
      animateWindow: (start: number, end: number, duration = 420) => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return;
        applyWindow(inst, start, end, duration);
      },
    }),
    [],
  );

  const currentWindow = (inst: ECharts): [number, number] => {
    const cached = winRef.current;
    if (cached) return cached;
    const dz = inst.getOption().dataZoom as { start?: number; end?: number; minSpan?: number }[] | undefined;
    const first = dz?.[0];
    return [
      typeof first?.start === "number" ? first.start : 0,
      typeof first?.end === "number" ? first.end : 100,
    ];
  };

  const minSpanOf = (inst: ECharts): number => {
    const dz = inst.getOption().dataZoom as { minSpan?: number }[] | undefined;
    const v = dz?.[0]?.minSpan;
    return typeof v === "number" ? v : 0;
  };

  const applyWindow = (inst: ECharts, start: number, end: number, duration: number | null = 260) => {
    cancelTween();
    if (duration === null || duration <= 0) {
      inst.dispatchAction({ type: "dataZoom", start, end } as never);
      winRef.current = [start, end];
      return;
    }
    // ECharts 的 dataZoom action 不会对窗口做补间，这里用 rAF 自己插值，
    // 才有“镜头拉远 / 推近”的效果。
    const [fromStart, fromEnd] = currentWindow(inst);
    const t0 = performance.now();
    const ease = (k: number) => 1 - Math.pow(1 - k, 3);
    const step = (now: number) => {
      if (inst.isDisposed()) {
        tweenRaf.current = null;
        return;
      }
      const k = Math.min(1, (now - t0) / duration);
      const e = ease(k);
      const nextStart = fromStart + (start - fromStart) * e;
      const nextEnd = fromEnd + (end - fromEnd) * e;
      inst.dispatchAction({ type: "dataZoom", start: nextStart, end: nextEnd } as never);
      winRef.current = [nextStart, nextEnd];
      tweenRaf.current = k < 1 ? requestAnimationFrame(step) : null;
    };
    tweenRaf.current = requestAnimationFrame(step);
  };

  const resetZoom = () => {
    const inst = instRef.current;
    if (!inst || inst.isDisposed()) return;
    applyWindow(inst, 0, 100, 320);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const inst = instRef.current;
    if (!inst || inst.isDisposed()) return;
    const key = e.key;
    const handled =
      key === "ArrowLeft" || key === "ArrowRight" || key === "+" || key === "=" || key === "-" || key === "_" || key === "0" || key === "Home";
    if (!handled) return;
    e.preventDefault();
    if (key === "0" || key === "Home") {
      resetZoom();
      return;
    }
    const [start, end] = currentWindow(inst);
    const span = Math.max(0.5, end - start);
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const dir = key === "ArrowLeft" ? -1 : 1;
      const step = span * (e.shiftKey ? 0.5 : 0.18) * dir;
      const nextStart = Math.min(Math.max(0, start + step), Math.max(0, 100 - span));
      applyWindow(inst, nextStart, Math.min(100, nextStart + span), 160);
      return;
    }
    const factor = key === "+" || key === "=" ? 0.72 : 1.38;
    const minSpan = Math.max(minSpanOf(inst), 0.8);
    const nextSpan = Math.min(100, Math.max(minSpan, span * factor));
    const center = (start + end) / 2;
    const nextStart = Math.min(Math.max(0, center - nextSpan / 2), Math.max(0, 100 - nextSpan));
    applyWindow(inst, nextStart, nextStart + nextSpan, 160);
  };

  return (
    <div
      className={`focus-ring relative h-full w-full ${className}`}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      onDoubleClick={resetZoom}
      onKeyDown={onKeyDown}
    >
      <EChart ref={chartRef} option={option} ariaLabel={ariaLabel} onReady={onReady} />
      {ghostSrc ? (
        <img
          key={ghostKey}
          src={ghostSrc}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="chart-ghost"
          onAnimationEnd={onGhostEnd}
        />
      ) : null}
    </div>
  );
});

export default ZoomChart;
