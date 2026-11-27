"""回填两融（交易所级）缺口。

运维约束（W3-14）：手工回填脚本，执行时持有 publish_lock；每个交易日单独事务；
入库后检查 SSE/SZSE 是否齐全（两融合计只汇总这两个交易所，缺一即整日 NULL，
见 docs/metric_contracts.md §两融），不齐全时写 alert 提示上游缺口。
"""
from __future__ import annotations

import time
from datetime import date

import pandas as pd

from . import alerts
from .db import session
from .locking import publish_lock
from .update_daily import open_days, tushare_pro

REQUIRED_EXCHANGES = ("SSE", "SZSE")


def _check_margin_day(con, day) -> list[str]:
    present = {r[0] for r in con.execute(
        "SELECT exchange_id FROM core_margin_day WHERE trade_date=?", [day]).fetchall()}
    missing = [ex for ex in REQUIRED_EXCHANGES if ex not in present]
    return [f"missing exchange {ex}" for ex in missing]


def main() -> None:
    pro = tushare_pro()
    with publish_lock():
        try:
            with session(wait=True) as con:
                last = con.execute("SELECT max(trade_date) FROM core_margin_day").fetchall()[0][0]
                start = last.strftime("%Y%m%d")
                end = date.today().strftime("%Y%m%d")
                maxcal = con.execute("SELECT max(cal_date) FROM core_trade_cal").fetchall()[0][0]
                days = open_days(con, start, min(end, maxcal))
                print(f"[margin] last={last} pending={len(days)}")
                total = 0
                warnings: list[str] = []
                for day in days:
                    try:
                        df = pro.margin(trade_date=day)
                    except Exception as e:
                        print(f"[margin] {day} fetch failed: {type(e).__name__}")
                        warnings.append(f"{day} fetch failed")
                        continue
                    if df is None or df.empty:
                        warnings.append(f"{day} empty response")
                        continue
                    df = df.copy()
                    df["trade_date"] = pd.to_datetime(df["trade_date"].astype(str), format="%Y%m%d").dt.date
                    con.execute("BEGIN TRANSACTION")
                    try:
                        con.register("tmp_m", df[["trade_date", "exchange_id", "rzye", "rzmre", "rzche", "rqye", "rzrqye"]])
                        inserted = con.execute(
                            """INSERT INTO core_margin_day
                            SELECT trade_date, exchange_id, rzye, rzmre, rzche, rqye, rzrqye
                            FROM tmp_m t
                            WHERE NOT EXISTS (
                                SELECT 1 FROM core_margin_day c
                                WHERE c.trade_date = t.trade_date AND c.exchange_id = t.exchange_id)"""
                        ).fetchall()
                        con.unregister("tmp_m")
                        problems = _check_margin_day(con, df["trade_date"].iloc[0])
                        if problems:
                            # Incomplete exchange coverage is an upstream gap: commit what
                            # exists (contract outputs NULL for the day) and surface it.
                            print(f"[margin] {day}: WARNING " + "; ".join(problems) + " - day will be NULL")
                            warnings.append(f"{day}: " + "; ".join(problems))
                        con.execute("COMMIT")
                    except BaseException:
                        con.execute("ROLLBACK")
                        raise
                    total += inserted[0][0] if inserted else 0
                    time.sleep(0.3)
                con.execute("CHECKPOINT")
                print(f"[margin] inserted {total}")
                if warnings:
                    alerts.write("backfill_margin", "两融回填存在缺口：" + "; ".join(warnings[:3]))
        except Exception:
            alerts.write("backfill_margin", "两融回填未完成；请检查本机日志")
            raise


if __name__ == "__main__":
    main()
