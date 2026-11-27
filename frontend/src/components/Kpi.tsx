import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sparkline } from "./Sparkline";

interface KpiProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: ReactNode;
  tone?: "up" | "down" | "accent" | "neutral";
  spark?: number[];
  sparkDates?: string[];
  sparkTone?: "up" | "down" | "accent" | "neutral";
  accent?: boolean;
  hint?: string;
  main?: boolean;
}

export function Kpi({
  label,
  value,
  sub,
  delta,
  tone = "neutral",
  spark,
  sparkDates,
  sparkTone,
  accent = false,
  hint,
  main = false,
}: KpiProps) {
  const { t, i18n } = useTranslation();
  const valueColor =
    tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : tone === "accent" ? "var(--accent)" : "var(--text)";
  return (
    <div className={`card relative flex min-w-0 flex-col justify-between overflow-hidden px-3.5 py-3 md:px-4 ${main ? "md:py-3.5" : ""}`}>
      <div className="flex items-center gap-1.5">
        <div className="micro micro-lg truncate">{label}</div>
        {hint && (
          <span className="prov ml-auto" title={hint} aria-label={hint} role="img">
            ?
          </span>
        )}
        {!hint && delta && <span className="mono ml-auto text-[11px] text-[var(--muted)]">{delta}</span>}
      </div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <div
          className={`mono whitespace-nowrap font-medium leading-none tracking-[-0.03em] ${main ? "text-[27px] md:text-[30px]" : "text-[21px] md:text-[23px]"}`}
          style={{ color: accent ? "var(--accent)" : valueColor }}
        >
          {value}
        </div>
        {spark && spark.length > 1 && (
          <div className="hidden shrink-0 flex-col items-end gap-0.5 pb-0.5 sm:flex" title={t("kpi.sparkHint")}>
            <span className="font-mono text-[11px] leading-none text-[var(--faint)]">{t("kpi.sparkLabel")}</span>
            <Sparkline values={spark} tone={sparkTone || tone} width={104} height={23} lang={i18n.language} />
            {sparkDates && sparkDates.length > 1 && (
              <div className="mono flex w-[104px] justify-between text-[11px] leading-none text-[var(--faint)]">
                <span>{sparkDates[0].slice(5).replace("-", "/")}</span>
                <span>{sparkDates[sparkDates.length - 1].slice(5).replace("-", "/")}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {sub && <div className="mt-1 truncate text-[11px] leading-tight text-[var(--faint)]">{sub}</div>}
    </div>
  );
}
