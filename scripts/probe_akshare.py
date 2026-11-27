"""备用源探测：验证 akshare 快照与 Tushare 上一交易日收盘价是否一致。

用法（仓库根目录，联网 + 收盘后）：
    python scripts/probe_akshare.py                 # 全市场快照 vs 本地最后交易日收盘
    python scripts/probe_akshare.py --limit 20      # 只打印最差的 20 只
    python scripts/probe_akshare.py --lake <库> --last 20261126 --min-match 0.98
退出码：0 一致率达标；1 一致率低于 --min-match；2 环境/数据错误（不联网、缺库、快照为空）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import duckdb  # noqa: E402
import pandas as pd  # noqa: E402

from pipeline import settings  # noqa: E402
from pipeline.sources import akshare_fallback as fb  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="akshare 备用源与本地收盘价一致性探测")
    ap.add_argument("--lake", default=None, help="本地库路径（默认 settings.LAKE）")
    ap.add_argument("--last", default=None, help="参考交易日 YYYYMMDD（默认库内 max(trade_date)）")
    ap.add_argument("--limit", type=int, default=10, help="打印差异最大的股票只数（默认 10）")
    ap.add_argument("--min-match", type=float, default=0.995, help="一致率下限（默认 0.995）")
    ap.add_argument("--tolerance", type=float, default=0.011, help="昨收与本地收盘的绝对容差（默认 0.011 元）")
    args = ap.parse_args()

    lake = Path(args.lake) if args.lake else Path(settings.LAKE)
    if not lake.exists():
        print(f"[probe] 本地库不存在：{lake}", file=sys.stderr)
        return 2
    con = duckdb.connect(str(lake), read_only=True)
    try:
        last = args.last or con.execute("SELECT max(trade_date) FROM core_stock_day").fetchone()[0]
        if last is None:
            print("[probe] core_stock_day 为空", file=sys.stderr)
            return 2
        print(f"[probe] lake={lake} last={last}")
        try:
            s = fb.snapshot()
        except Exception as exc:
            print(f"[probe] 快照失败（需要联网且收盘后）：{exc}", file=sys.stderr)
            return 2
        if s is None or len(s) == 0:
            print("[probe] 快照为空", file=sys.stderr)
            return 2
        print(f"[probe] snapshot rows: {len(s)}")

        snap = pd.DataFrame({"ts_code": s["ts_code"], "pre_close": pd.to_numeric(s["昨收"], errors="coerce")})
        ref = con.execute("SELECT ts_code, close FROM core_stock_day WHERE trade_date = ?", [last]).fetchdf()
        m = snap.merge(ref, on="ts_code", how="inner")
        m["diff"] = (m.pre_close - m.close).abs()
        if len(m) == 0:
            print("[probe] 快照与本地无重合代码", file=sys.stderr)
            return 2
        ok = (m["diff"] < args.tolerance).mean()
        print(f"[probe] matched {len(m)} codes; within {args.tolerance}: {ok:.2%}; MAE: {m['diff'].mean():.4f}")
        bad = m[m["diff"] >= args.tolerance].sort_values("diff", ascending=False).head(max(1, args.limit))
        if len(bad):
            print(f"[probe] top {len(bad)} mismatches (usually ex-dividend adjustments):")
            print(bad.to_string(index=False))
        else:
            print("[probe] no mismatch above tolerance")
        if ok < args.min_match:
            print(f"[probe] FAIL: match {ok:.2%} < min-match {args.min_match:.2%}", file=sys.stderr)
            return 1
        print("[probe] OK")
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    raise SystemExit(main())
