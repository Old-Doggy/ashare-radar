import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { prefersReducedMotion } from "../lib/theme";

interface Props {
  className?: string;
  height?: number | string;
  ariaLabel?: string;
  onEvents?: Record<string, (params: unknown) => void>;
}

/** 旁路 EChart 的实时图表句柄：基座用 notMerge:true 整份设置，之后每帧只 patch series。 */
export interface LiveChartHandle {
  setBase: (option: EChartsOption) => void;
  patchSeries: (series: EChartsOption["series"]) => void;
  getDataURL: (bg: string) => string | null;
  resize: () => void;
}

/** 轮动图的宿主：不在 render 里 setOption，全部通过 ref 的 imperative 方法驱动。
 * - ResizeObserver → resize()（X12，保留播放位置由父组件 state 负责）；
 * - 卸载时 dispose（X14）；
 * - rAF 只存在于父组件，StrictMode 双挂载不会留下第二条动画（X13）；
 * - prefers-reduced-motion 时 resize 不做过渡动画（W14-16）。 */
const LiveChart = forwardRef<LiveChartHandle, Props>(function LiveChart(
  { className, height = "100%", ariaLabel, onEvents },
  ref,
) {
  const { i18n } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const inst = echarts.init(hostRef.current, undefined, {
      renderer: "canvas",
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    instRef.current = inst;
    const ro = new ResizeObserver(() => {
      if (!inst.isDisposed()) inst.resize({ animation: { duration: prefersReducedMotion() ? 0 : 180 } });
    });
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      if (!inst.isDisposed()) inst.dispose();
      if (instRef.current === inst) instRef.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst || inst.isDisposed() || !onEvents) return;
    const entries = Object.entries(onEvents);
    entries.forEach(([name, handler]) => inst.on(name, handler));
    return () => {
      if (!inst.isDisposed()) entries.forEach(([name, handler]) => inst.off(name, handler));
    };
  }, [onEvents]);

  useImperativeHandle(
    ref,
    () => ({
      setBase: (option) => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return;
        // C1：option 里已 animation:false；基座一次性设置，避免每帧 diff 整份 option。
        inst.setOption(option, { notMerge: true, lazyUpdate: true });
      },
      patchSeries: (series) => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return;
        // C2：每帧只回传 series。
        inst.setOption({ series }, { notMerge: false, lazyUpdate: false });
      },
      getDataURL: (bg) => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return null;
        inst.getZr().flush(); // 先 flush，否则拿到的是上一帧
        return inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
      },
      resize: () => {
        const inst = instRef.current;
        if (inst && !inst.isDisposed()) inst.resize({ animation: { duration: prefersReducedMotion() ? 0 : 180 } });
      },
    }),
    [],
  );

  const fallbackLabel = i18n.language === "en" ? "Chart" : "图表";
  return (
    <div
      ref={hostRef}
      className={className}
      style={{ height, width: "100%" }}
      role="img"
      aria-label={ariaLabel || fallbackLabel}
    />
  );
});

export default LiveChart;
