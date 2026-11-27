"""在临时库上验证 akshare 备用源能正确写入 core 表（不碰主库、不写 data/）。

用法（仓库根目录）：
    python scripts/test_fallback_insert.py                # 默认取上海时区“今天”
    python scripts/test_fallback_insert.py --date 20261127
    python scripts/test_fallback_insert.py --lake <只读源库>

限制：akshare 快照只对“当天 15:10 后”的有效交易日有效（`akshare_fallback._guard`），
因此该脚本只能在当天收盘后运行；日期不满足时退出码 2 并给出原因。
退出码：0 成功；1 写入/校验失败；2 参数或日期守卫不满足；3 依赖/环境错误。
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import duckdb  # noqa: E402

from pipeline import settings  # noqa: E402
from pipeline.sources import akshare_fallback as fb  # noqa: E402
from pipeline.update_daily import insert  # noqa: E402

SHANGHAI = timezone(timedelta(hours=8))


def main() -> int:
    ap = argparse.ArgumentParser(description="akshare 备用源写入演练（临时库）")
    ap.add_argument("--date", default=None, help="YYYYMMDD；缺省为上海时区今天（必须 ≥15:10 且为交易日）")
    ap.add_argument("--lake", default=None, help="只读源库（默认 settings.LAKE）；用于借用一天的表结构")
    args = ap.parse_args()

    day = args.date or datetime.now(SHANGHAI).strftime("%Y%m%d")
    source_lake = Path(args.lake) if args.lake else Path(settings.LAKE)
    if not source_lake.exists():
        print(f"[fallback] 源库不存在：{source_lake}", file=sys.stderr)
        return 3

    tmp_dir = Path(tempfile.mkdtemp(prefix="ashare_fallback_"))
    tmp_path = tmp_dir / "fallback.duckdb"
    try:
        tmp = duckdb.connect(str(tmp_path))
        tmp.execute(f"ATTACH '{source_lake}' AS l (READ_ONLY)")
        # 只借表结构，不带任何生产行；临时库完全自包含。
        tmp.execute("CREATE TABLE core_stock_day AS SELECT * FROM l.core_stock_day LIMIT 0")
        tmp.execute("DETACH l")

        try:
            daily = fb.daily(day)
        except ValueError as exc:  # _guard 拒绝（非当天 / 未到 15:10 / 非交易日）
            print(f"[fallback] 日期守卫拒绝：{exc}", file=sys.stderr)
            return 2
        n1 = insert(tmp, "daily", daily, day)
        try:
            n2 = insert(tmp, "daily_basic", fb.daily_basic(day), day)
            n3 = insert(tmp, "stk_limit", fb.stk_limit(day), day)
            n4 = insert(tmp, "adj_factor", fb.adj_factor(tmp, day), day)
        except Exception as exc:  # 可选数据集失败不掩盖主流程错误
            print(f"[fallback] 可选数据集写入失败：{exc}", file=sys.stderr)
            return 1

        row = tmp.execute(
            """
            SELECT count(*) n,
                   count(*) FILTER (WHERE circ_mv IS NOT NULL) n_mv,
                   count(*) FILTER (WHERE adj_factor IS NOT NULL) n_adj,
                   count(*) FILTER (WHERE up_limit IS NOT NULL) n_lim,
                   round(avg(pct_chg), 2) avg_ret,
                   round(min(close), 2) min_close
            FROM core_stock_day WHERE trade_date = CAST(? AS DATE)
            """,
            [f"{day[:4]}-{day[4:6]}-{day[6:]}"],
        ).fetchone()
        print({"day": day, "inserted": {"daily": n1, "basic": n2, "limit": n3, "adj": n4}})
        print({"rows": row[0], "circ_mv": row[1], "adj": row[2], "up_limit": row[3],
               "avg_ret": row[4], "min_close": row[5]})
        if row[0] == 0:
            print("[fallback] 未写入任何行", file=sys.stderr)
            return 1
        print("[fallback] OK")
        return 0
    finally:
        try:
            tmp.close()
        except Exception:
            pass
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
