"""API 性能实测：Flask test client（进程内），输出 p50/p95/max 与响应体积。

用法（仓库根目录）：
    python scripts/perf_api.py                      # 自动取 mart_market_day 最新交易日
    python scripts/perf_api.py --date 2026-11-26    # 指定交易日
    python scripts/perf_api.py --repeat 30 --out _fix_20261127/evidence/E/perf_api.json

数据目录遵循 `ASHARE_RADAR_DATA_DIR`；对生产库只读（API 每请求开只读连接）。
注意：结果是本机、冷/热缓存下的进程内测量，不是网络端到端指标；报告时需同时记录测量时间、
Python/DuckDB 版本与产物大小（见 docs/performance.md）。
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import duckdb  # noqa: E402

from backend.main import LAKE, app  # noqa: E402

ENDPOINT_TEMPLATES = [
    "/api/meta",
    "/api/market/series",
    "/api/market/day/{date}",
    "/api/sectors?date={date}",
    "/api/stocks?date={date}&limit=400",
    "/api/stocks?date={date}&limit=6000",
    "/api/sectors/series",
    "/api/sectors/series?start=2026-01-01&end={date}",
    "/api/sectors/roll?end={date}",
    "/api/sector-ranks?date={date}",
    "/api/rotation?date={date}",
    "/api/limit-quality?date={date}",
    "/api/stock/600519.SH",
    "/api/quality",
]


def latest_trade_date(lake: Path) -> str:
    con = duckdb.connect(str(lake), read_only=True)
    try:
        row = con.execute("SELECT max(trade_date) FROM mart_market_day").fetchone()
    finally:
        con.close()
    if not row or row[0] is None:
        raise SystemExit("mart_market_day 为空：请先构建 marts")
    return str(row[0])


def main() -> dict:
    ap = argparse.ArgumentParser(description="API p50/p95 性能实测（Flask test client）")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD；缺省取 mart_market_day 最新交易日")
    ap.add_argument("--repeat", type=int, default=20, help="每个端点重复次数（默认 20）")
    ap.add_argument("--out", default=None, help="结果 JSON 输出路径（默认不写文件，仅打印）")
    args = ap.parse_args()

    day = args.date or latest_trade_date(Path(LAKE))
    endpoints = [tpl.format(date=day) for tpl in ENDPOINT_TEMPLATES]
    app.config.update(TESTING=True)
    out: dict = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "trade_date": day,
        "repeat": args.repeat,
        "lake": str(LAKE),
        "python": sys.version.split()[0],
        "duckdb": duckdb.__version__,
        "endpoints": {},
    }
    with app.test_client() as c:
        for ep in endpoints:
            # warmup
            r = c.get(ep)
            ts: list[float] = []
            size = 0
            for _ in range(args.repeat):
                t0 = time.perf_counter()
                r = c.get(ep)
                ts.append((time.perf_counter() - t0) * 1000)
                size = max(size, len(r.data))
            out["endpoints"][ep] = {
                "status": r.status_code,
                "p50_ms": round(statistics.median(ts), 1),
                "p95_ms": round(sorted(ts)[max(0, int(len(ts) * 0.95) - 1)], 1),
                "max_ms": round(max(ts), 1),
                "kb": round(size / 1024, 1),
            }
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[perf_api] wrote {out_path}")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return out


if __name__ == "__main__":
    main()
