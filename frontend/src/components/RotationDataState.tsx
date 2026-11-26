import { useTranslation } from "react-i18next";
import { SectorRollUnavailable } from "../lib/api";
import { DataState } from "./DataState";

export function RotationDataState({ error, pending }: { error: Error | null; pending: boolean }) {
  const { t } = useTranslation();
  if (error instanceof SectorRollUnavailable) {
    return <div role="status" className="flex min-h-[180px] items-center justify-center px-6 text-center text-sm text-[var(--muted)]">
      {t(error.reason === "offline" ? "rotate.noRoll" : "rotate.rebuildRoll")}
    </div>;
  }
  return <DataState error={!!error} loading={pending} />;
}
