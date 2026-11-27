"""Repair statistically incomplete dates in an explicitly isolated database copy.

Never chooses the production database implicitly, never reads/prints credentials.
Each dataset/day is retried up to three times; each date commits atomically.

Correctness rules (v0.4.3):
- the neighbourhood median used to detect partial days excludes the current day
  (W3-05), so a day cannot be hidden by its own low row count;
- after rewriting a day, the historical-applicability gate subset must not block
  (gates 1,2,3,4,5,6(warn),8,9,10,11,12,13; gates 7/14 recorded as
  not_applicable_historical, gates 15-18 batch-checked once at the end);
- before/after row counts and valid-row coverage are written to the report;
- the batch must finish with `remaining_partial == []` and a passing gate 15.
"""
from __future__ import annotations

import argparse
from datetime import datetime
from statistics import median
import time

from . import settings
from .build_marts import SQL_VIEW
from .db import session
from .io_utils import atomic_write_json
from .locking import publish_lock
from .quality_gates import history_completeness, run_gates
from .update_daily import fetch, insert, tushare_pro, _checkpoint_schema, _checkpoint

NEIGHBOUR_WINDOW = 10
TYPICAL_RATIO = 0.85


def incomplete_dates(con, ratio: float = TYPICAL_RATIO) -> list[dict]:
    """A local median detects partial days even when a row exists for the date.

    The current day is excluded from its own neighbourhood median (±10 rows).
    """
    counts = con.execute(
        "SELECT trade_date, count(*) FROM core_stock_day GROUP BY 1 ORDER BY 1"
    ).fetchall()
    out: list[dict] = []
    for i, (trade_date, n) in enumerate(counts):
        neighbours = [c for j, (_, c) in enumerate(counts) if j != i and abs(j - i) <= NEIGHBOUR_WINDOW]
        if not neighbours:
            continue
        typical = float(median(neighbours))
        if typical > 0 and n < ratio * typical:
            out.append({"date": trade_date.strftime("%Y%m%d"), "rows": int(n),
                        "typical_rows": typical})
    return out


def require_copy() -> None:
    production = (settings.ROOT / "data").resolve()
    if settings.DATA.resolve() == production or not settings.LAKE.is_file():
        raise RuntimeError("set ASHARE_RADAR_DATA_DIR to an existing isolated database copy")


def _coverage(con, day: str) -> tuple[int, float | None]:
    n, valid = con.execute(
        """SELECT count(*), count(*) FILTER (
               WHERE close>0 AND isfinite(close) AND pct_chg IS NOT NULL AND isfinite(pct_chg)
                 AND adj_factor>0 AND isfinite(adj_factor)
                 AND circ_mv>0 AND isfinite(circ_mv))
           FROM core_stock_day WHERE trade_date=?::DATE""",
        [datetime.strptime(day, "%Y%m%d").date()],
    ).fetchone()
    return int(n), (valid / n if n else None)


def _ensure_view(con) -> None:
    """Gates need v_stock; a freshly bootstrapped copy may not have built marts yet."""
    bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix().replace("'", "''")
    con.execute(SQL_VIEW.format(bridge=bridge))


def run(apply: bool = False) -> dict:
    require_copy()
    with publish_lock(), session(wait=True) as con:
        plan = incomplete_dates(con)
        report = {"status": "planned", "planned_dates": plan, "repaired": [], "failed": [],
                  "remaining_partial": None, "history_gate": None,
                  "generated_at": datetime.now().astimezone().isoformat(timespec="seconds")}
        if not apply:
            atomic_write_json(settings.META / "history_repair.json", report)
            return report
        pro = tushare_pro()
        _checkpoint_schema(con)
        _ensure_view(con)
        for item in plan:
            day = item["date"]
            prev = con.execute(
                "SELECT max(cal_date) FROM core_trade_cal WHERE is_open=1 AND cal_date < ?",
                [day]).fetchone()[0]
            before_rows, before_coverage = _coverage(con, day)
            frames = {}
            try:
                # Network happens before the transaction; an unavailable core
                # dataset must not erase any old date or leave half a correction.
                for ds in ("daily", "daily_basic", "adj_factor", "stk_limit"):
                    for attempt in range(3):
                        try:
                            frame = fetch(pro, ds, day)
                            break
                        except Exception:
                            if attempt == 2:
                                raise
                            time.sleep(1 + attempt)
                    if frame is None or frame.empty:
                        raise RuntimeError(f"empty required {ds}")
                    frames[ds] = frame
                    time.sleep(.15)
                if len(frames["daily"]) < TYPICAL_RATIO * item["typical_rows"]:
                    raise RuntimeError("source daily response is still incomplete")
                con.execute("BEGIN TRANSACTION")
                try:
                    con.execute("DELETE FROM core_stock_day WHERE trade_date=?::DATE",
                                [datetime.strptime(day, "%Y%m%d").date()])
                    for ds, frame in frames.items():
                        insert(con, ds, frame, day)
                        _checkpoint(con, day, ds, "tushare")
                    after_rows, after_coverage = _coverage(con, day)
                    if not after_rows or after_coverage is None or after_coverage < .95:
                        raise RuntimeError("repaired historical core coverage below 95%")
                    # W3-04: the repaired day must pass the historical gate subset
                    # before COMMIT; a blocking gate rolls the day back.
                    gate = run_gates(con, day, prev, persist=False, scope="history")
                    if gate["blocking"]:
                        raise RuntimeError(
                            "post-repair gate blocking: " + ",".join(str(g) for g in gate["blocking"]))
                    con.execute("COMMIT")
                except BaseException:
                    con.execute("ROLLBACK")
                    raise
                report["repaired"].append({
                    **item,
                    "new_rows": after_rows,
                    "coverage": after_coverage,
                    "before": {"rows": before_rows, "coverage": before_coverage},
                    "after": {"rows": after_rows, "coverage": after_coverage},
                    "gates": {
                        "passed": gate["passed"],
                        "blocking": gate["blocking"],
                        "not_applicable": gate["not_applicable"],
                        "warn_failed": [g["id"] for g in gate["gates"]
                                        if g["pass"] is False and g.get("level") == "warn"],
                        "message": {str(g["id"]): g.get("message") for g in gate["gates"]
                                    if g["id"] in (1, 3, 4, 5, 6, 11)},
                    },
                })
            except Exception as exc:
                # No upstream error strings: they can contain request credentials.
                report["failed"].append({
                    "date": day, "error_type": type(exc).__name__,
                    "gate_blocking": _gate_blocking_from_message(exc),
                })
                report["status"] = "failed"
                atomic_write_json(settings.META / "history_repair.json", report)
                raise RuntimeError(f"history repair failed for {day}; see sanitized report") from None
            report["status"] = "running"
            atomic_write_json(settings.META / "history_repair.json", report)
            print(f"[repair] {day}: {before_rows} -> {after_rows}; "
                  f"{len(report['repaired'])}/{len(plan)}", flush=True)

        # Batch-level evidence: no partial day may remain and gate 15 must pass.
        remaining = incomplete_dates(con)
        gate15 = history_completeness(con)
        report["remaining_partial"] = remaining
        report["history_gate"] = {
            "pass": gate15["pass"], "value": gate15["value"],
            "threshold": gate15["threshold"],
        }
        if remaining or not gate15["pass"]:
            report["status"] = "failed"
            atomic_write_json(settings.META / "history_repair.json", report)
            raise RuntimeError("history repair incomplete: remaining partial days or gate 15 failed")
        report["status"] = "ok"
        report["finished_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
        atomic_write_json(settings.META / "history_repair.json", report)
        return report


def _gate_blocking_from_message(exc: Exception) -> list[int]:
    text = str(exc)
    marker = "post-repair gate blocking: "
    if marker not in text:
        return []
    tail = text.split(marker, 1)[1]
    return [int(part) for part in tail.split(",") if part.strip().isdigit()]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="otherwise only write a plan")
    args = parser.parse_args()
    result = run(args.apply)
    print(__import__("json").dumps(
        {"status": result["status"], "planned": len(result["planned_dates"]),
         "repaired": len(result["repaired"]),
         "remaining_partial": result.get("remaining_partial")}, ensure_ascii=False))
