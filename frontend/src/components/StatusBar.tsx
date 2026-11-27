import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { versionLabel } from "../lib/format";
import { displaySource, statusKind } from "../lib/viewMetrics";

export function StatusBar() {
  const { i18n } = useTranslation();
  const en = i18n.language === "en";
  const { data: meta, isError: metaError, isPending: metaPending } = useQuery({ queryKey: ["meta"], queryFn: api.meta, staleTime: 60_000 });
  const { data: quality, isError: qualityError, isPending: qualityPending } = useQuery({ queryKey: ["quality"], queryFn: api.quality, staleTime: 60_000 });
  const gates = quality?.gates ?? [];
  const passed = gates.filter((g) => g.pass).length;
  const kind = statusKind({ meta, quality, gates, metaError, qualityError, pending: metaPending || qualityPending });
  const time = meta?.updated_at
    ? new Date(meta.updated_at).toLocaleTimeString(en ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const label =
    kind === "error"
      ? en ? "Data unavailable" : "数据不可用"
      : kind === "stale"
        ? en ? "Update incomplete" : "更新未完成"
        : kind === "ok"
          ? en ? "Data checked" : "数据已校验"
          : kind === "warn"
            ? en ? "Data warnings" : "数据有告警"
            : en ? "Loading" : "加载中";
  const tone = kind === "error" ? "text-[var(--up)]" : kind === "ok" ? "text-[var(--down)]" : kind === "loading" ? "text-[var(--faint)]" : "text-[var(--warn)]";

  return (
    <footer className="no-print hidden h-[30px] shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] bg-[var(--bg-2)] px-3 font-mono text-[11px] tracking-[0.04em] text-[var(--faint)] md:flex md:gap-4 md:px-5">
      <span className={tone} role="status">
        ● {label}
      </span>
      <span className="hidden sm:inline">{displaySource(meta?.source)}</span>
      <span className="text-[var(--muted)]">{meta?.last_trade_date || "—"}</span>
      <span className="hidden md:inline">{meta?.n_stocks ? `${meta.n_stocks.toLocaleString("en-US")} ${en ? "stocks" : "只"}` : "—"}</span>
      <span className="hidden lg:inline">{en ? "Gates" : "门禁"} {gates.length ? `${passed}/${gates.length}` : "—"}</span>
      <span className="hidden lg:inline">{en ? "Updated" : "更新"} {time}</span>
      <span className="ml-auto hidden xl:inline">daily → core → mart</span>
      <span className="hidden md:inline text-[var(--border-strong)]">|</span>
      <span className="hidden md:inline">⌘K {en ? "Commands" : "命令"}</span>
      {/* 版本与 Briefing/About 同源（meta.version → format.VERSION_FALLBACK，W7-SUG1/W9-06） */}
      <span className="hidden md:inline">{versionLabel(meta?.version)}</span>
    </footer>
  );
}
