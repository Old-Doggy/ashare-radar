"""Controlled switch from a repaired lake copy to the production database.

This script never runs automatically and never deletes the production database;
it is the only supported way to adopt `data/repair/lake.duckdb` (see
`_fix_20261127/修复计划与接口约定.md` §2.1).

Flow:
1. validate the source copy (required tables, row counts, no remaining partial days);
2. take the OS publication lock;
3. verify the production database is quiescent (checkpoint it read-write first);
4. copy the source to a temp file next to the target, fold any WAL, verify counts;
5. back up the production database to `data/backup/lake.duckdb.<timestamp>`;
6. atomically replace the target, rebuild marts and validate row counts;
7. on any failure after the swap, restore the backup and tell the operator what to do.

Usage:
    python -m pipeline.promote_repair --source data/repair/lake.duckdb --dry-run
    python -m pipeline.promote_repair --source data/repair/lake.duckdb
    python -m pipeline.promote_repair --source data/repair/lake.duckdb --skip-marts
"""
from __future__ import annotations

import argparse
import os
import shutil
import time
from datetime import datetime
from pathlib import Path

import duckdb

from . import settings
from .io_utils import atomic_write_json
from .locking import publish_lock
from .repair_history import incomplete_dates

REQUIRED_TABLES = ("core_stock_day", "core_stock_meta", "core_trade_cal", "core_index_day")


def _connect_read_only(path: Path):
    con = duckdb.connect(str(path), read_only=True)
    con.execute("SET threads=4")
    return con


def _table_stats(con) -> dict:
    tables = {r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables").fetchall()}
    missing = [t for t in REQUIRED_TABLES if t not in tables]
    if missing:
        raise RuntimeError(f"source database is missing required tables: {missing}")
    core_rows = con.execute("SELECT count(*) FROM core_stock_day").fetchone()[0]
    n_days = con.execute("SELECT count(DISTINCT trade_date) FROM core_stock_day").fetchone()[0]
    first, last = con.execute("SELECT min(trade_date), max(trade_date) FROM core_stock_day").fetchone()
    partial = incomplete_dates(con)
    return {"core_rows": core_rows, "n_days": n_days,
            "first_date": str(first), "last_date": str(last),
            "remaining_partial": partial, "tables": len(tables)}


def validate_source(source: Path, target: Path) -> dict:
    if not source.is_file():
        raise RuntimeError(f"source database not found: {source}")
    if source.resolve() == target.resolve():
        raise RuntimeError("source and target must differ; refusing to overwrite the source")
    con = _connect_read_only(source)
    try:
        stats = _table_stats(con)
    finally:
        con.close()
    if stats["remaining_partial"]:
        raise RuntimeError(
            f"source still has {len(stats['remaining_partial'])} partial trading day(s); "
            "finish pipeline.repair_history --apply first")
    return stats


def _checkpoint_quiet(path: Path) -> None:
    """Fail early if another process holds the production database or its WAL is dirty."""
    con = duckdb.connect(str(path))
    try:
        con.execute("CHECKPOINT")
    finally:
        con.close()


def _copy_with_wal(source: Path, destination: Path) -> None:
    shutil.copyfile(source, destination)
    wal = source.with_name(source.name + ".wal")
    if wal.exists():
        shutil.copyfile(wal, destination.with_name(destination.name + ".wal"))


def _retarget(target: Path) -> None:
    """Point the pipeline settings at the switched database (needed for --target)."""
    settings.DATA = target.parent.resolve()
    settings.LAKE = target.resolve()
    settings.META = settings.DATA / "meta"
    settings.MARTS = settings.DATA / "marts"
    settings.CACHE = settings.DATA / "cache"
    settings.RAW = settings.DATA / "raw"
    settings.SNAPSHOTS = settings.DATA / "snapshots"
    for path in (settings.META, settings.MARTS, settings.CACHE):
        path.mkdir(parents=True, exist_ok=True)


def run(source: str | Path, target: str | Path | None = None,
        backup_dir: str | Path | None = None, *, dry_run: bool = False,
        skip_marts: bool = False) -> dict:
    source_path = Path(source).resolve()
    target_path = Path(target).resolve() if target else settings.LAKE.resolve()
    backup_root = Path(backup_dir).resolve() if backup_dir else (target_path.parent / "backup")
    started = time.time()
    report: dict = {"status": "planned", "source": str(source_path), "target": str(target_path),
                    "backup_dir": str(backup_root),
                    "generated_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    source_stats = validate_source(source_path, target_path)
    report["source_validation"] = source_stats
    if not target_path.is_file():
        raise RuntimeError(f"target database not found: {target_path}")
    if dry_run:
        target_con = _connect_read_only(target_path)
        try:
            target_stats = _table_stats(target_con)
        finally:
            target_con.close()
        report["target_before"] = {k: target_stats[k] for k in ("core_rows", "n_days", "last_date")}
        report["status"] = "dry_run_ok"
        report["duration_sec"] = round(time.time() - started, 1)
        print(f"[promote] dry run OK: {source_stats['core_rows']:,} source rows, "
              f"target {target_stats['core_rows']:,} rows")
        return report

    free = shutil.disk_usage(target_path.parent).free
    needed = source_path.stat().st_size * 2 + target_path.stat().st_size
    if free < needed:
        raise RuntimeError(f"not enough free disk space: need {needed/1e9:.1f} GB, have {free/1e9:.1f} GB")

    with publish_lock():
        _checkpoint_quiet(target_path)
        target_con = _connect_read_only(target_path)
        try:
            before = _table_stats(target_con)
        finally:
            target_con.close()
        report["target_before"] = {"core_rows": before["core_rows"], "n_days": before["n_days"],
                                   "last_date": before["last_date"]}

        backup_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = backup_root / f"lake.duckdb.{stamp}"
        shutil.copyfile(target_path, backup)
        report["backup"] = str(backup)

        temporary = target_path.with_name(f".{target_path.name}.promote.tmp")
        swapped = False
        try:
            _copy_with_wal(source_path, temporary)
            temporary_con = duckdb.connect(str(temporary))
            try:
                temporary_con.execute("CHECKPOINT")
                copied = _table_stats(temporary_con)
            finally:
                temporary_con.close()
            if copied["core_rows"] != source_stats["core_rows"] or copied["n_days"] != source_stats["n_days"]:
                raise RuntimeError(
                    f"copied database mismatch: rows {copied['core_rows']} vs {source_stats['core_rows']}, "
                    f"days {copied['n_days']} vs {source_stats['n_days']}")
            os.replace(temporary, target_path)
            swapped = True
            for leftover in temporary.parent.glob(f".{temporary.name}*"):
                leftover.unlink(missing_ok=True)
            _retarget(target_path)
            after_con = _connect_read_only(target_path)
            try:
                after = _table_stats(after_con)
            finally:
                after_con.close()
            report["target_after"] = {k: after[k] for k in ("core_rows", "n_days",
                                                            "first_date", "last_date",
                                                            "remaining_partial")}
            marts: dict = {}
            if not skip_marts:
                from . import build_marts
                marts = build_marts.run()
            report["marts"] = marts
            # Row-count validation: one market row per trading day; feat is non-empty.
            if not skip_marts:
                expected = report["target_after"]["n_days"]
                got = (marts.get("mart_market_day") or {}).get("rows")
                if got != expected:
                    raise RuntimeError(
                        f"mart_market_day has {got} rows but core has {expected} trading days")
                if not (marts.get("feat_stock") or {}).get("rows"):
                    raise RuntimeError("feat_stock is empty after rebuild")
            report["status"] = "ok"
            report["duration_sec"] = round(time.time() - started, 1)
            atomic_write_json(settings.META / "promote_repair.json", report)
            print(f"[promote] switched to repaired copy: core {source_stats['core_rows']:,} rows, "
                  f"{source_stats['n_days']} days; backup={backup}")
            return report
        except BaseException as exc:
            report["error_type"] = type(exc).__name__
            report["status"] = "failed"
            if swapped:
                shutil.copyfile(backup, target_path)
                report["rollback"] = (f"restored {backup} -> {target_path}; "
                                      "re-run pipeline.build_marts afterwards")
                print(f"[promote] FAILED after swap; restored backup {backup}")
            else:
                report["rollback"] = "no swap happened; production database untouched"
            temporary.unlink(missing_ok=True)
            report["duration_sec"] = round(time.time() - started, 1)
            atomic_write_json(settings.META / "promote_repair.json", report)
            raise


def main() -> None:
    ap = argparse.ArgumentParser(description="Adopt a repaired lake copy into production")
    ap.add_argument("--source", required=True, help="repaired database copy (e.g. data/repair/lake.duckdb)")
    ap.add_argument("--target", default=None, help="production database (default: settings.LAKE)")
    ap.add_argument("--backup-dir", default=None, help="default: <target dir>/backup")
    ap.add_argument("--dry-run", action="store_true", help="validate only; do not touch production")
    ap.add_argument("--skip-marts", action="store_true", help="switch only, rebuild marts later")
    args = ap.parse_args()
    print(run(args.source, args.target, args.backup_dir,
              dry_run=args.dry_run, skip_marts=args.skip_marts))


if __name__ == "__main__":
    main()
