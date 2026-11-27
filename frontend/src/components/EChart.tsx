import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { prefersReducedMotion } from "../lib/theme";

interface Props {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
  ariaLabel?: string;
  /**
   * 实例就绪回调（可选，默认不用）。给确实需要 dispatchAction 的页面用，
   * 不改变 setOption 的既有行为；返回值会在 dispose 前调用，用于解绑监听。
   */
  onReady?: (inst: echarts.ECharts) => void | (() => void);
}

export interface EChartHandle {
  getDataURL: (backgroundColor?: string) => string | null;
}

const EChart = forwardRef<EChartHandle, Props>(function EChart(
  { option, height = "100%", className, onEvents, ariaLabel, onReady },
  ref,
) {
  const { i18n } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const instRef = useRef<echarts.ECharts | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!hostRef.current) return;
    const inst = echarts.init(hostRef.current, undefined, {
      renderer: "canvas",
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });
    instRef.current = inst;
    const teardown = onReadyRef.current?.(inst);
    const ro = new ResizeObserver(() => {
      if (!inst.isDisposed()) inst.resize({ animation: { duration: prefersReducedMotion() ? 0 : 180 } });
    });
    ro.observe(hostRef.current);
    return () => {
      ro.disconnect();
      if (typeof teardown === "function") teardown();
      if (!inst.isDisposed()) inst.dispose();
      if (instRef.current === inst) instRef.current = null;
    };
  }, []);

  useEffect(() => {
    const inst = instRef.current;
    if (!inst || inst.isDisposed()) return;
    inst.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

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
      getDataURL: (backgroundColor = "transparent") => {
        const inst = instRef.current;
        if (!inst || inst.isDisposed()) return null;
        // 先 flush：否则拿到的是上一帧（W6-09，与 LiveChart 行为一致）。
        inst.getZr().flush();
        return inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor });
      },
    }),
    [],
  );

  // W14-08：11 个图表容器曾只有 role="img" 没有名字；页面应传具体 ariaLabel，
  // 未传时也至少给一个可读名称，屏幕阅读器不会只读出「图像」。
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

export default EChart;
