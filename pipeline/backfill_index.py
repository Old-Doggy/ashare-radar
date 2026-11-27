"""用 akshare 补齐指数日线缺口（本地快照 index_daily 只到 2026-05-08）。

只补缺口，不覆盖已有行；写入 core_index_day 后需重跑 mart 与导出。

运维约束（W3-14）：属手工回填脚本，执行时持有 publish_lock；每个交易日单独事务，
落库后立即校验 gate12/gate13 对应条件（4 大指数齐全、收益一致），失败写 alert
并保留已提交的日期（已提交的日期是完整且有效的）。
"""
from __future__ import annotations

import time
from datetime import date

import akshare as ak
import pandas as pd

from . import alerts
from .db import session
from .locking import publish_lock

INDICES = {
    "000300": "000300.SH",
    "000905": "000905.SH",
    "000852": "000852.SH",
    "000001": "000001.SH",
}


def fetch(symbol: str, start: str, end: str) -> pd.DataFrame:
    df = ak.index_zh_a_hist(symbol=symbol, period="daily", start_date=start, end_date=end)
    if df is None or df.empty:
        return pd.DataFrame()
    out = pd.DataFrame(
        {
            "trade_date": pd.to_datetime(df["日期"]).dt.date,
            "open": df["开盘"].astype(float),
            "high": df["最高"].astype(float),
            "low": df["最低"].astype(float),
            "close": df["收盘"].astype(float),
            "pre_close": df["收盘"].astype(float) - df["涨跌额"].astype(float),
            "pct_chg": df["涨跌幅"].astype(float),
            "vol": df["成交量"].astype(float),
            "amount": df["成交额"].astype(float) / 1000.0,  # 元 -> 千元（与 Tushare 一致）
        }
    )
    return out


def _check_index_day(con, day) -> list[str]:
    """gate12 + gate13 的同口径检查（脚本回填后立即执行）。"""
    problems = []
    n = con.execute("""SELECT count(DISTINCT ts_code) FROM core_index_day WHERE trade_date=?
        AND ts_code IN ('000300.SH','000905.SH','000852.SH','000001.SH')
        AND pct_chg IS NOT NULL AND isfinite(pct_chg) AND close>0""", [day]).fetchone()[0]
    if n != 4:
        problems.append(f"index completeness {n}/4")
    bad = con.execute("""SELECT count(*) FROM core_index_day WHERE trade_date=?
        AND pre_close>0 AND pct_chg IS NOT NULL
        AND abs(pct_chg-(close/pre_close-1)*100)>0.1""", [day]).fetchone()[0]
    if bad:
        problems.append(f"{bad} index return conflicts >0.1pp")
    return problems


def main() -> None:
    with publish_lock():
        try:
            with session(wait=True) as con:
                last = con.execute("SELECT max(trade_date) FROM core_index_day").fetchall()[0][0]
                print(f"[index] local last = {last}")
                start = last.strftime("%Y%m%d")
                end = date.today().strftime("%Y%m%d")
                frames = []
                for symbol, ts_code in INDICES.items():
                    df = fetch(symbol, start, end)
                    if df.empty:
                        print(f"[index] {ts_code}: no data")
                        continue
                    df["ts_code"] = ts_code
                    frames.append(df)
                    time.sleep(0.3)
                if not frames:
                    return
                combined = pd.concat(frames, ignore_index=True)
                total = 0
                for day, part in combined.groupby("trade_date", sort=True):
                    con.execute("BEGIN TRANSACTION")
                    try:
                        con.register("tmp_idx", part)
                        inserted = con.execute(
                            """INSERT INTO core_index_day
                            SELECT ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount
                            FROM tmp_idx t
                            WHERE NOT EXISTS (
                                SELECT 1 FROM core_index_day c
                                WHERE c.ts_code = t.ts_code AND c.trade_date = t.trade_date)"""
                        ).fetchall()
                        con.unregister("tmp_idx")
                        problems = _check_index_day(con, day)
                        if problems:
                            raise RuntimeError(f"{day}: " + "; ".join(problems))
                        con.execute("COMMIT")
                    except BaseException:
                        con.execute("ROLLBACK")
                        raise
                    added = inserted[0][0] if inserted else 0
                    total += added
                    print(f"[index] {day}: +{added} rows, gates ok")
                con.execute("CHECKPOINT")
                print(f"[index] inserted {total} rows")
        except Exception:
            alerts.write("backfill_index", "指数缺口回填未完成；已提交的日期保留，请检查日志")
            raise


if __name__ == "__main__":
    main()
