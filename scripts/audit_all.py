"""数据审计：派生表重算 + 全历史完整性 + 与 mart / 静态 payload / akshare 交叉验证。

独立性说明（W11-09/W12-09，务必如实理解）：
- 市场/行业指标是从 `feat_stock`（同一条管线的派生层）重算的**派生表重算**，
  不是从 `core_*` 原始表另写一套独立实现；它能发现聚合/投影错误，但不能
  独立证明 build_marts 的派生逻辑本身正确。
- 跨源对账（akshare）只覆盖抽样股票与**指定单日**；网络不可用时记为 skip，
  skip 不是 pass——报告 verdict 会写明 `pass_with_skips`。
- 全历史完整性（gate15 同口径）是独立 SQL 实现，历史部分日会被计入 FAIL。
- 输出写到 `<lake 所在目录>/meta/`，在数据库副本上运行不会污染生产 meta。

用法：python scripts/audit_all.py [--date 2026-11-26] [--samples 20] [--lake data/lake.duckdb] [--offline]
输出：<lake 所在目录>/meta/audit_report.md、sector_roll.json，控制台 PASS/FAIL 表。
退出码：0 = 无 FAIL；1 = 有 FAIL。skip 不改变退出码，但 verdict 不是完整通过。
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from collections import defaultdict
from pathlib import Path

import duckdb
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

RESULTS: list[dict] = []


def check(item: str, expected, actual, tol=0.0, note: str = "", kind="num") -> None:
    expected = None if pd.isna(expected) else expected
    actual = None if pd.isna(actual) else actual
    if kind == "num":
        if expected is None or actual is None:
            ok = bool(expected == actual)
            diff = None
        else:
            diff = float(actual) - float(expected)
            ok = bool(abs(diff) <= tol)
        RESULTS.append(
            {"item": item, "expected": expected, "actual": actual, "diff": diff, "ok": ok, "note": note}
        )
    else:
        ok = bool(expected == actual)
        RESULTS.append(
            {"item": item, "expected": expected, "actual": actual, "diff": None, "ok": ok, "note": note}
        )


def skip(item: str, reason: str) -> None:
    RESULTS.append({"item": item, "expected": None, "actual": None, "diff": None, "ok": None, "note": reason})


def audit_market(con, day: str) -> None:
    """从 feat_stock 派生层重算单日市场指标（非 core_* 独立实现，见模块说明）。"""
    m = con.execute(
        "SELECT * FROM mart_market_day WHERE trade_date = ?", [day]
    ).fetchdf().iloc[0]

    raw = con.execute(
        """
        SELECT count(*) n,
               count(*) FILTER (WHERE ret > 0) adv,
               count(*) FILTER (WHERE ret < 0) dec,
               avg(ret) ew,
               median(ret) med,
               stddev_samp(ret) csd,
               quantile_cont(ret, 0.25) q25,
               quantile_cont(ret, 0.75) q75,
               sum(amount) * 1000 amt,
               CASE WHEN count(is_limit_up)>0 THEN count(*) FILTER (WHERE is_limit_up) END lim_up,
               CASE WHEN count(is_limit_down)>0 THEN count(*) FILTER (WHERE is_limit_down) END lim_dn
        FROM feat_stock WHERE trade_date = ? AND NOT is_new_stock
        """,
        [day],
    ).fetchdf().iloc[0]

    check("样本数 n_valid", raw.n, m.n_valid, 0)
    check("上涨家数", raw.adv, m.n_adv, 0)
    check("下跌家数", raw.dec, m.n_dec, 0)
    check("广度 = 涨/(涨+跌)", raw.adv / (raw.adv + raw.dec) if raw.adv+raw.dec else None, m.breadth, 1e-12)
    check("等权收益", raw.ew, m.ew_ret, 1e-12)
    check("中位数收益", raw.med, m.med_ret, 1e-12)
    check("横截面标准差", raw.csd, m.csd, 1e-9)
    check("IQR = q75-q25", raw.q75 - raw.q25, m.iqr, 1e-12)
    check("成交额（元）", raw.amt, m.amount, max(1.0, raw.amt * 1e-9))
    check("涨停家数（价格口径）", raw.lim_up, m.limit_up_n, 0)
    check("跌停家数（价格口径）", raw.lim_dn, m.limit_down_n, 0)

    # 市值加权：前一日流通市值
    cap = con.execute(
        """
        WITH previous AS (
            SELECT max(trade_date) AS d FROM core_trade_cal WHERE is_open=1 AND trade_date<?
        ), f AS (
            SELECT f.ts_code, f.trade_date, f.ret, c.circ_mv AS prev_cap
            FROM feat_stock f CROSS JOIN previous p
            LEFT JOIN core_stock_day c ON c.ts_code=f.ts_code AND c.trade_date=p.d
            WHERE f.trade_date = ? AND NOT f.is_new_stock
        ),
        w AS (SELECT *, prev_cap / sum(prev_cap) OVER () AS wt FROM f WHERE prev_cap > 0 AND isfinite(prev_cap)),
        r AS (SELECT *, row_number() OVER (ORDER BY prev_cap DESC, ts_code) rn FROM w)
        SELECT sum(wt * ret) cw,
               sum(wt * wt) * 10000 hhi,
               sum(wt * ret) FILTER (WHERE rn <= 10) top10_pp,
               sum(abs(wt * ret)) FILTER (WHERE rn <= 10) / nullif(sum(abs(wt * ret)),0) top10_share
        FROM r
        """,
        [day, day],
    ).fetchdf().iloc[0]
    check("市值加权收益 cw_ret", cap.cw, m.cw_ret, 1e-6)
    check("HHI", cap.hhi, m.hhi, 0.01)
    check("Top10 贡献（pp）", cap.top10_pp * 100, m.top10_contrib_pct, 1e-5)
    check("Top10 波动占比", cap.top10_share, m.top10_share, 1e-5)

    # 指数收益
    idx = con.execute(
        "SELECT pct_chg / 100.0 FROM core_index_day WHERE trade_date = ? AND ts_code = '000300.SH'",
        [day],
    ).fetchdf()
    check("沪深300 收益", None if idx.empty else float(idx.iloc[0, 0]), m.hs300_ret, 1e-12)

    # 派生 UI 指标
    last250 = con.execute(
        "SELECT breadth FROM mart_market_day WHERE trade_date <= ? ORDER BY trade_date DESC LIMIT 250",
        [day],
    ).fetchdf()["breadth"]
    pctile = (last250 <= m.breadth).sum() / len(last250)

    avg20 = con.execute(
        "SELECT avg(breadth) FROM (SELECT breadth FROM mart_market_day WHERE trade_date <= ? ORDER BY trade_date DESC LIMIT 20)",
        [day],
    ).fetchall()[0][0]
    print(f"  [info] 广度较前20日均值 = {(m.breadth - avg20) * 100:.1f}pp")
    print(f"  [info] 广度分位 = {pctile:.1%}")


def audit_sectors(con, day: str) -> None:
    sec = con.execute(
        """
        SELECT sw_l1, count(*) n, avg(ret) ew,
               count(*) FILTER (WHERE ret > 0)::DOUBLE / nullif(count(*) FILTER (WHERE ret > 0) + count(*) FILTER (WHERE ret < 0), 0) breadth,
               quantile_cont(ret, 0.75) - quantile_cont(ret, 0.25) iqr
        FROM feat_stock WHERE trade_date = ? AND NOT is_new_stock
        GROUP BY sw_l1
        """,
        [day],
    ).fetchdf()
    mart = con.execute("SELECT sw_l1, n, ew_ret, breadth, iqr FROM mart_sector_day WHERE trade_date = ?", [day]).fetchdf()
    mm = mart.set_index("sw_l1")
    for name in ["电子", "银行", "医药生物"]:
        if name not in mm.index:
            continue
        row = sec[sec.sw_l1 == name].iloc[0]
        m = mm.loc[name]
        check(f"{name} n", row.n, m.n, 0)
        check(f"{name} 等权收益", row.ew, m.ew_ret, 1e-12)
        check(f"{name} 广度", row.breadth, m.breadth, 1e-12)
        check(f"{name} IQR", row.iqr, m.iqr, 1e-12)
    total = con.execute(
        "SELECT count(*) FROM feat_stock WHERE trade_date = ? AND NOT is_new_stock AND sw_l1 = '未分类'", [day]
    ).fetchall()[0][0]
    print(f"  [info] 未分类个股 = {total} / {int(sec.n.sum())}")

    m_amt = con.execute("SELECT amount FROM mart_market_day WHERE trade_date = ?", [day]).fetchall()[0][0]
    s_amt = con.execute(
        "SELECT sum(amount) FROM mart_sector_day WHERE trade_date = ?", [day]
    ).fetchall()[0][0]
    unmapped_amount = con.execute("""SELECT coalesce(sum(amount),0)*1000 FROM feat_stock
        WHERE trade_date=? AND NOT is_new_stock AND sw_l1='未分类'""", [day]).fetchone()[0]
    check("行业成交额合计 + 未分类 = 全市场", m_amt, (s_amt or 0) + unmapped_amount, m_amt * 0.001)


def audit_stocks_vs_akshare(con, day: str, n_samples: int) -> None:
    import akshare as ak

    codes = [
        r[0]
        for r in con.execute(
            "SELECT ts_code FROM feat_stock WHERE trade_date = ? AND NOT is_new_stock ORDER BY ts_code",
            [day],
        ).fetchall()
    ]
    random.seed(7)
    sample = sorted(random.sample(codes, min(n_samples, len(codes))))
    ref = con.execute(
        "SELECT ts_code, close, ret, amount, circ_mv FROM feat_stock WHERE trade_date = ?",
        [day],
    ).fetchdf().set_index("ts_code")
    d = pd.to_datetime(day).strftime("%Y%m%d")
    ok_price = ok_ret = ok_amt = 0
    checked = checked_ret = checked_em = checked_sina = 0
    for code in sample:
        r = ref.loc[code]
        em = None
        try:
            df = ak.stock_zh_a_hist(symbol=code.split(".")[0], period="daily", start_date=d, end_date=d, adjust="")
            if df is not None and not df.empty:
                row = df.iloc[0]
                em = (float(row["收盘"]), float(row["涨跌幅"]), float(row["成交额"]))
                checked_em += 1
        except Exception:
            pass

        if em is not None:
            close, pct, amt = em
            checked += 1
            checked_ret += 1
            ok_price += abs(close - r.close) < 0.011
            ok_ret += abs(pct - r.ret * 100) < 0.05
            ok_amt += abs(amt - r.amount * 1000) / max(1.0, r.amount * 1000) < 0.01
        else:
            # 东方财富限流时改用新浪日线：取前一日与当日收盘，自行计算涨跌幅
            try:
                sym = ("sh" if code.endswith(".SH") else "sz") + code.split(".")[0]
                prev = con.execute(
                    "SELECT max(cal_date) FROM core_trade_cal WHERE cal_date < ?", [day]
                ).fetchall()[0][0]
                df = ak.stock_zh_a_daily(symbol=sym, start_date=prev, end_date=d, adjust="")
                if df is not None and len(df) >= 2:
                    df = df.sort_values("date").reset_index(drop=True)
                    close = float(df.iloc[-1]["close"])
                    pct = (close / float(df.iloc[-2]["close"]) - 1) * 100
                    amt = float(df.iloc[-1]["amount"])
                    checked += 1
                    checked_ret += 1
                    checked_sina += 1
                    ok_price += abs(close - r.close) < 0.011
                    ok_ret += abs(pct - r.ret * 100) < 0.05
                    ok_amt += abs(amt - r.amount * 1000) / max(1.0, r.amount * 1000) < 0.01
            except Exception:
                pass
        time.sleep(0.1)

    src = f"东财 {checked_em} / 新浪 {checked_sina}"
    if checked == 0:
        skip("akshare 抽样收盘价一致", "东财与新浪均不可用（限流/网络）")
        skip("akshare 抽样成交额一致", "东财与新浪均不可用（限流/网络）")
    else:
        check("akshare 抽样收盘价一致", checked, ok_price, 0, note=f"{checked} 只，容差 0.01（{src}）")
        check("akshare 抽样成交额一致", checked, ok_amt, 0, note=f"{checked} 只，容差 1%（{src}）")
    if checked_ret == 0:
        skip("akshare 抽样涨跌幅一致", "仅新浪可用，未覆盖涨跌幅字段")
    else:
        check("akshare 抽样涨跌幅一致", checked_ret, ok_ret, 0, note=f"{checked_ret} 只，容差 0.05pp")


def audit_index_vs_akshare(con, day: str) -> None:
    import akshare as ak

    local = con.execute(
        "SELECT pct_chg / 100.0 FROM core_index_day WHERE trade_date = ? AND ts_code = '000300.SH'", [day]
    ).fetchall()
    if not local:
        skip("沪深300 与 akshare 一致", "本地无指数数据")
        return
    local_ret = local[0][0]

    try:
        df = ak.index_zh_a_hist(
            symbol="000300", period="daily",
            start_date=pd.to_datetime(day).strftime("%Y%m%d"),
            end_date=pd.to_datetime(day).strftime("%Y%m%d"),
        )
        if df is not None and not df.empty:
            ak_ret = float(df.iloc[0]["涨跌幅"]) / 100
            diff = abs(ak_ret - local_ret)
            check("沪深300 与 akshare 一致", 0.0, round(diff, 6), 0.0002, note=f"东财 {ak_ret:.4%} vs local {local_ret:.4%}")
            return
    except Exception as e:
        print(f"  [warn] 东财指数不可用: {type(e).__name__}")

    try:
        idx = ak.stock_zh_index_daily(symbol="sh000300")
        idx["date"] = pd.to_datetime(idx["date"]).dt.date
        idx = idx.sort_values("date").reset_index(drop=True)
        target = pd.to_datetime(day).date()
        pos = idx.index[idx["date"] == target]
        if len(pos) == 0 or pos[0] == 0:
            skip("沪深300 与 akshare 一致", "新浪指数无当日数据")
            return
        i = int(pos[0])
        ak_ret = float(idx.loc[i, "close"]) / float(idx.loc[i - 1, "close"]) - 1
        diff = abs(ak_ret - local_ret)
        check("沪深300 与 akshare 一致", 0.0, round(diff, 6), 0.0002, note=f"新浪 {ak_ret:.4%} vs local {local_ret:.4%}")
    except Exception as e:
        skip("沪深300 与 akshare 一致", f"akshare 不可用: {type(e).__name__}")


def audit_limit_method(con, day: str = "2026-05-22") -> None:
    official = con.execute(
        "SELECT count(*) FROM core_limit_event WHERE trade_date = ? AND is_up", [day]
    ).fetchall()[0][0]
    price = con.execute(
        "SELECT count(*) FROM feat_stock WHERE trade_date = ? AND is_limit_up", [day]
    ).fetchall()[0][0]
    both = con.execute(
        """
        SELECT count(*) FROM core_limit_event e
        JOIN feat_stock f USING (ts_code, trade_date)
        WHERE e.trade_date = ? AND e.is_up AND f.is_limit_up
        """,
        [day],
    ).fetchall()[0][0]
    price_ex_st = con.execute(
        """
        SELECT count(*) FROM feat_stock
        WHERE trade_date = ? AND is_limit_up AND (up_limit / pre_close - 1) >= 0.06
        """,
        [day],
    ).fetchall()[0][0]
    st_n = price - price_ex_st
    union = official + price - both
    jac = both / union if union else 0
    # Tushare limit_list_d 不含 ST/风险警示股；价格口径含 5% 涨停，剔除后再对比。
    check(
        "涨停口径 vs 官方（剔除5%）",
        official,
        price_ex_st,
        max(2, round(official * 0.03)),
        note=f"{day} 官方 {official} / 非5% {price_ex_st} / 含ST {st_n}",
    )

    print(f"  [info] {day}: official={official} price={price} ex_st={price_ex_st} st={st_n} overlap={both} jaccard={jac:.3f}")

    # 连板口径
    off_streak = con.execute(
        "SELECT max(limit_times) FROM core_limit_event WHERE trade_date = ? AND is_up", [day]
    ).fetchall()[0][0]
    our_streak = con.execute(
        "SELECT max(limit_streak) FROM feat_stock WHERE trade_date = ?", [day]
    ).fetchall()[0][0]
    print(f"  [info] {day}: 官方最高连板={off_streak} 价格口径={our_streak}")

    mrow = con.execute(
        "SELECT limit_up_non5pct_n, limit_up_5pct_n, broken_rate FROM mart_market_day WHERE trade_date = ?", [day]
    ).fetchdf()
    if len(mrow):
        r = mrow.iloc[0]
        # 一致性检查（不是独立性检查）：st_n 与 limit_up_5pct_n 同由 up_limit 价格档派生，
        # 只能验证 mart 聚合与明细自洽，不能作为 5% 档正确性的外部证据。
        check("5%档与明细自洽（同一 up_limit 来源，非独立证据）", st_n, r.limit_up_5pct_n, 0, note=f"{day}")
        check("非5%涨停与官方差异", official, r.limit_up_non5pct_n, max(2, round(official * 0.03)))
        broken = con.execute(
            "SELECT count(*) FROM core_limit_event WHERE trade_date = ? AND is_broken", [day]
        ).fetchall()[0][0]
        if r.broken_rate == r.broken_rate:
            check("炸板率（官方分母）", broken / (official + broken), r.broken_rate, 1e-12)


def audit_limit_caliber(con) -> None:
    """口径纯净性：核心涨跌停指标不依赖外部名单接口（与具体某一天无关，永远跑）。"""
    cov = con.execute(
        """
        SELECT count(*)                                   AS days,
               count(limit_up_n)                          AS up_n,
               count(limit_down_n)                        AS down_n,
               count(*) FILTER (WHERE broken_rate IS NOT NULL)      AS broken_days,
               count(*) FILTER (WHERE limit_up_list_n IS NOT NULL)  AS official_days,
               max(trade_date) FILTER (WHERE limit_up_list_n IS NOT NULL) AS last_official
        FROM mart_market_day
        """
    ).fetchall()[0]
    check("价格口径涨停覆盖全部交易日", cov[0], cov[1], 0,
          note=f"{cov[1]}/{cov[0]} 天，含 ST，不依赖 limit_list_d")
    check("价格口径跌停覆盖全部交易日", cov[0], cov[2], 0, note=f"{cov[2]}/{cov[0]} 天")
    check("炸板率与官方名单同源为空（不用近似值填充）", cov[4], cov[3], 0,
          note=f"官方名单可用 {cov[4]} 天、最近 {cov[5]}；炸板率非空 {cov[3]} 天")
    # 连板为价格口径：只校验派生表与明细自洽，不与官方 limit_times 对齐（口径不同，差异已写进契约）
    self_diff = con.execute(
        """
        WITH f AS (
            -- 与 build_marts 完全相同的 coalesce 约定：有样本但无涨停时 max 记 0 而不是 NULL
            SELECT trade_date,
                   CASE WHEN count(is_limit_up) > 0
                        THEN count(*) FILTER (WHERE limit_streak >= 2) END AS s,
                   CASE WHEN count(is_limit_up) > 0
                        THEN coalesce(max(CASE WHEN is_limit_up THEN limit_streak END), 0) END AS m
            FROM feat_stock GROUP BY trade_date
        )
        SELECT count(*) FROM mart_market_day mm JOIN f USING (trade_date)
        WHERE coalesce(mm.streak_n, -1) <> coalesce(f.s, -1)
           OR coalesce(mm.max_streak, -1) <> coalesce(f.m, -1)
        """
    ).fetchall()[0][0]
    check("连板/最高板与明细自洽", 0, self_diff, 0, note="mart_market_day vs feat_stock 逐日对齐")
    off_div = con.execute(
        """
        WITH off AS (
            SELECT trade_date, count(*) FILTER (WHERE is_up AND limit_times >= 2) AS os,
                   max(CASE WHEN is_up THEN limit_times END) AS om
            FROM core_limit_event GROUP BY trade_date
        )
        SELECT round(avg(abs(mm.streak_n - off.os)), 2),
               round(avg(abs(mm.max_streak - off.om)), 2),
               count(*)
        FROM mart_market_day mm JOIN off USING (trade_date)
        WHERE mm.limit_up_list_n IS NOT NULL AND mm.streak_n IS NOT NULL
        """
    ).fetchall()[0]
    print(f"  [info] 连板为价格口径，与官方 limit_times 日均差 {off_div[0]} 家 / 最高板 {off_div[1]} 板"
          f"（{off_div[2]} 天可比）——口径不同，不与官方对齐，已写入 metric_contracts")
    print(f"  [info] 官方涨停名单覆盖 {cov[4]}/{cov[0]} 天，最近有值 {cov[5]}；"
          f"其余日期炸板率/封单额为空，不填充近似值")


def audit_integrity(con, day: str) -> None:
    """批量一致性：派生表 vs 原始表 / 聚合 vs 明细。"""
    # 1) feat_stock vs core_stock_day（价格、收益、成交额、复权）
    fv = con.execute(
        """
        SELECT count(*) n,
               count(*) FILTER (WHERE abs(f.close - c.close) > 0.001) bad_close,
               count(*) FILTER (WHERE abs(f.ret - c.pct_chg / 100.0) > 1e-9) bad_ret,
               count(*) FILTER (WHERE abs(f.amount - c.amount) > 0.001) bad_amt,
               count(*) FILTER (WHERE abs(f.adj_close - c.close * c.adj_factor) > 0.01) bad_adj
        FROM feat_stock f JOIN core_stock_day c USING (ts_code, trade_date)
        WHERE f.trade_date = ? AND NOT f.is_new_stock
        """,
        [day],
    ).fetchdf().iloc[0]
    missing = con.execute("""WITH expected AS (
        SELECT ts_code, trade_date FROM core_stock_day
        WHERE trade_date=? AND (ts_code LIKE '%.SH' OR ts_code LIKE '%.SZ')
          AND close>0 AND adj_factor>0 AND pct_chg>-100 AND adj_close>0
          AND isfinite(close) AND isfinite(adj_factor) AND isfinite(pct_chg) AND isfinite(adj_close)
    ), actual AS (SELECT ts_code,trade_date FROM feat_stock WHERE trade_date=?)
    SELECT count(*) FROM expected e FULL OUTER JOIN actual a USING(ts_code,trade_date)
    WHERE e.ts_code IS NULL OR a.ts_code IS NULL""", [day, day]).fetchone()[0]
    check("feat/core 有效键集合一致", 0, int(missing), 0)
    check("feat 收盘价 = core", 0, int(fv.bad_close), 0)
    check("feat 收益 = pct_chg/100", 0, int(fv.bad_ret), 0)
    check("feat 成交额 = core（千元）", 0, int(fv.bad_amt), 0)
    check("adj_close = close × adj_factor", 0, int(fv.bad_adj), 0)

    # 2) 行业聚合全量对比
    sec = con.execute(
        """
        WITH s AS (
            SELECT sw_l1,
                   count(*) n,
                   avg(ret) ew,
                   count(*) FILTER (WHERE ret > 0)::DOUBLE /
                       nullif(count(*) FILTER (WHERE ret > 0) + count(*) FILTER (WHERE ret < 0), 0) breadth,
                   quantile_cont(ret, 0.75) - quantile_cont(ret, 0.25) iqr
            FROM feat_stock
            WHERE trade_date = ? AND NOT is_new_stock AND sw_l1 <> '未分类'
            GROUP BY sw_l1
        )
        SELECT count(*) bad
        FROM s FULL OUTER JOIN (SELECT * FROM mart_sector_day WHERE trade_date=?) m USING (sw_l1)
        WHERE s.sw_l1 IS NULL OR m.sw_l1 IS NULL OR s.n <> m.n
          OR abs(s.ew - m.ew_ret) > 1e-9
          OR s.breadth IS DISTINCT FROM m.breadth AND
             (s.breadth IS NULL OR m.breadth IS NULL OR abs(s.breadth - m.breadth) > 1e-12)
          OR abs(s.iqr - m.iqr) > 1e-9
        """,
        [day, day],
    ).fetchall()[0][0]
    check("31 行业聚合全部一致", 0, int(sec), 0)

    # 3) 最新个股快照
    snap = con.execute(
        """
        WITH expected AS (
            SELECT * FROM feat_stock WHERE trade_date <= ?
            QUALIFY row_number() OVER (PARTITION BY ts_code ORDER BY trade_date DESC)=1
        )
        SELECT count(*) bad
        FROM mart_stock_latest l FULL OUTER JOIN expected f USING (ts_code)
        WHERE l.ts_code IS NULL OR f.ts_code IS NULL
           OR l.quote_date IS DISTINCT FROM f.trade_date
           OR l.trade_date IS DISTINCT FROM ?::DATE
           OR l.is_stale IS DISTINCT FROM (f.trade_date < ?::DATE)
           OR l.close IS DISTINCT FROM f.close OR l.circ_mv IS DISTINCT FROM f.circ_mv
           OR l.ret IS DISTINCT FROM (CASE WHEN f.trade_date = ?::DATE THEN f.ret ELSE 0 END)
           OR l.sw_l1 IS DISTINCT FROM f.sw_l1
        """,
        [day, day, day, day],
    ).fetchall()[0][0]
    check("个股最新快照全部一致", 0, int(snap), 0)

    # 4) 月度复利
    mon = con.execute(
        """
        WITH d AS (
            SELECT sw_l1, date_trunc('month', trade_date)::DATE m,
                   exp(sum(ln(1 + ew_ret))) - 1 cum
            FROM mart_sector_day
            WHERE trade_date >= (SELECT date_trunc('month', max(trade_date) - INTERVAL 400 DAY) FROM mart_sector_day)
            GROUP BY 1, 2
        )
        SELECT count(*) bad FROM d FULL OUTER JOIN (
            SELECT * FROM mart_sector_month WHERE month >=
            (SELECT date_trunc('month', max(trade_date) - INTERVAL 400 DAY) FROM mart_sector_day)
        ) sm
          ON d.sw_l1 = sm.sw_l1 AND d.m = sm.month
        WHERE d.sw_l1 IS NULL OR sm.sw_l1 IS NULL
           OR (d.cum IS DISTINCT FROM sm.ew_ret_cum AND
               (d.cum IS NULL OR sm.ew_ret_cum IS NULL OR abs(d.cum - sm.ew_ret_cum) > 1e-9))
        """,
    ).fetchall()[0][0]
    check("行业月度累计 = 日度复利", 0, int(mon), 0)


def check_sector_roll(con, meta_dir: Path) -> None:
    """Recompute all rolling values from each industry's ordered observations."""
    first_result = len(RESULTS)
    if not con.execute("""SELECT count(*) FROM information_schema.tables
                           WHERE table_name = 'mart_sector_roll'""").fetchone()[0]:
        check("mart_sector_roll available", True, False, kind="bool")
        _write_sector_roll_audit(meta_dir, {"status": "failed", "checks": RESULTS[first_result:]})
        return

    dates = {row[0] for row in con.execute(
        "SELECT DISTINCT trade_date FROM core_trade_cal WHERE is_open=1 ORDER BY trade_date"
    ).fetchall()}
    daily = con.execute("SELECT trade_date, sw_l1, ew_ret, breadth FROM mart_sector_day").fetchall()
    source = {(day, sector): (ret, br) for day, sector, ret, br in daily}
    stored_rows = con.execute("""SELECT trade_date, sw_l1, ret_r5, ret_r10, ret_r20,
        br_r5, br_r10, br_r20, rank_r5, rank_r10, rank_r20 FROM mart_sector_roll""").fetchall()
    stored = {(day, sector): values for day, sector, *values in stored_rows}
    check("mart_sector_roll has rows", True, bool(stored_rows), kind="bool")
    check("mart_sector_roll unique keys", len(stored), len(stored_rows))
    check("mart_sector_day unique keys", len(source), len(daily))
    check("mart_sector_roll keys match mart_sector_day", 0, len(source.keys() ^ stored.keys()))
    check("mart_sector_day dates are trading sessions", 0, sum(day not in dates for day, _ in source))
    by_sector = defaultdict(list)
    for (day, sector), values in sorted(source.items()):
        by_sector[sector].append((day, values))
    mismatches = [0] * 3
    max_diffs = [0.0, 0.0]
    for sector, observations in by_sector.items():
        for i, (day, _) in enumerate(observations):
            values = stored.get((day, sector))
            if values is None:  # The complete key comparison above reports the missing row.
                continue
            for j, width in enumerate((5, 10, 20)):
                recent = observations[max(0, i + 1 - width):i + 1]
                for col in (0, 1):
                    samples = [row[col] for _, row in recent]
                    expected = None
                    if len(samples) == width and all(v is not None for v in samples):
                        expected = (math.prod(max(1 + v, 1e-6) for v in samples) - 1
                                    if col == 0 else math.fsum(samples) / width)
                    actual = values[j + col * 3]
                    if expected is None or actual is None:
                        mismatches[col] += expected is not actual
                    elif not math.isfinite(actual):
                        mismatches[col] += 1
                    else:
                        diff = abs(actual - expected)
                        max_diffs[col] = max(max_diffs[col], diff)
                        mismatches[col] += diff > 1e-12

    by_day = {}
    for (day, _), values in stored.items():
        by_day.setdefault(day, []).append(values)
    for rows in by_day.values():
        for j in range(3):
            ordered = sorted((row[j] for row in rows if row[j] is not None), reverse=True)
            ranks = {}
            for rank, ret in enumerate(ordered, 1):
                ranks.setdefault(ret, rank)
            mismatches[2] += sum(row[6 + j] != ranks.get(row[j]) for row in rows)

    check("rolling return mismatches, including NULL", 0, mismatches[0], note=f"max abs diff={max_diffs[0]:.3g}")
    check("rolling breadth mismatches, including NULL", 0, mismatches[1], note=f"max abs diff={max_diffs[1]:.3g}")
    check("rolling rank mismatches, including ties and NULL", 0, mismatches[2])
    own = RESULTS[first_result:]
    _write_sector_roll_audit(meta_dir, {"status": "ok" if all(r["ok"] for r in own) else "failed",
                                        "rows": len(stored_rows), "checks": own})


def _write_sector_roll_audit(meta_dir: Path, report: dict) -> None:
    meta_dir.mkdir(parents=True, exist_ok=True)
    path = meta_dir / "sector_roll.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"[written] {path}")


def _independent_sector_roll_rows(con):
    """独立重算 payload.sector_roll 的投影（不复用 pipeline.sector_roll 的生产 SQL）。

    窗口：mart_sector_roll 中最近 250 个交易日；字段：滚动列 + mart_sector_day.amount
    （非负有限值四舍五入到元后转 BIGINT，否则 NULL）。这正是 payload 的字段与过滤语义。
    """
    roll = con.execute(
        """SELECT trade_date, sw_l1, ret_r5, ret_r10, ret_r20, br_r5, br_r10, br_r20,
                  rank_r5, rank_r10, rank_r20
           FROM mart_sector_roll"""
    ).fetchall()
    amount = {(d, s): a for d, s, a in con.execute(
        "SELECT trade_date, sw_l1, amount FROM mart_sector_day").fetchall()}
    keep = set(sorted({r[0] for r in roll}, reverse=True)[:250])
    out = []
    for row in sorted((r for r in roll if r[0] in keep), key=lambda r: (r[0], r[1])):
        value = amount.get((row[0], row[1]))
        if value is None or not math.isfinite(value) or value < 0:
            rounded = None
        else:
            # 与 DuckDB round() 一致：非负数四舍五入（Python round 是银行家舍入）
            rounded = int(math.floor(value + 0.5))
        out.append((*row, rounded))
    return out


def audit_payload(con, day: str, p: Path | None = None) -> None:
    if p is None:
        p = ROOT / "data" / "static-data.json"
    if not p.exists():
        check("静态 payload 存在", True, False, 0, kind="bool")
        return
    d = json.loads(p.read_text(encoding="utf-8"))
    last = d["market"][-1]
    m = con.execute("SELECT * FROM mart_market_day WHERE trade_date = ?", [day]).fetchdf().iloc[0]
    check("payload 最新日期", m.trade_date.strftime("%Y-%m-%d"), str(last["trade_date"])[:10], 0, kind="str")
    for k in ["breadth", "ew_ret", "cw_ret", "top10_share", "amount", "limit_up_n"]:
        tol = 0.01 if k == "amount" else 1e-3
        check(f"payload {k}", m[k], last[k], tol)
    check("payload 个股数", int(m.n_valid), len(d["stocks"]), 0)
    print(f"  [info] payload stocks={len(d['stocks'])}, sectors={len(d['sectors'])}, rotation={len(d.get('rotation', []))}")
    from pipeline.db import table_exists

    exported = d.get("sector_roll")
    if exported is None:
        check("payload sector_roll available", True, False, kind="bool")
        return
    if not table_exists(con, "mart_sector_roll"):
        check("payload matches an existing mart_sector_roll", True, False, kind="bool")
        return
    expected = _independent_sector_roll_rows(con)
    check("payload sector_roll row count", len(expected), len(exported))
    fields = ["trade_date", "sw_l1", "ret_r5", "ret_r10", "ret_r20", "br_r5", "br_r10",
              "br_r20", "rank_r5", "rank_r10", "rank_r20", "amount"]
    mismatches = 0
    for actual, values in zip(exported, expected):
        for key, value in zip(fields, values):
            if key == "trade_date":
                value = str(value)[:10]
            elif isinstance(value, float):
                value = round(value, 6)
            mismatches += key not in actual or actual[key] != value
    check("payload sector_roll field mismatches（独立 Python 重算投影）", 0, mismatches)


def audit_history_completeness(con) -> None:
    """独立实现（不复用 quality_gates）的历史部分日检查，原始审核口径：含当日的 ±10 中位数。

    任何非零值都意味着交付库仍含部分交易日，必须先用 repair_history 修复再发布。
    """
    rows = con.execute(
        """
        WITH counts AS (SELECT trade_date, count(*) n FROM core_stock_day GROUP BY 1),
        nearby AS (SELECT *, median(n) OVER (ORDER BY trade_date
            ROWS BETWEEN 10 PRECEDING AND 10 FOLLOWING) typical FROM counts)
        SELECT strftime(trade_date, '%Y-%m-%d'), n, typical FROM nearby
        WHERE n < 0.85 * typical ORDER BY trade_date
        """
    ).fetchall()
    worst = "; ".join(f"{d}:{n}/{int(t)}" for d, n, t in rows[:3]) or "none"
    check("全历史不完整交易日数（±10 中位数 n<0.85*median）", 0, len(rows), 0,
          note=f"worst 3: {worst}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="audit date YYYY-MM-DD (default: latest mart date)")
    ap.add_argument("--samples", type=int, default=20)
    ap.add_argument(
        "--lake",
        default=str(ROOT / "data" / "lake.duckdb"),
        help="DuckDB 路径（默认 data/lake.duckdb；可在副本库上验证）",
    )
    ap.add_argument("--offline", action="store_true", help="skip independent network data sources")
    args = ap.parse_args()
    RESULTS.clear()
    lake = Path(args.lake).resolve()
    con = duckdb.connect(str(lake), read_only=True)
    day = args.date or str(con.execute("SELECT max(trade_date) FROM mart_market_day").fetchall()[0][0])

    print(f"== 审计交易日 {day} ==")
    print("[1] 市场指标")
    audit_market(con, day)
    print("[2] 行业指标")
    audit_sectors(con, day)
    print("[3] 个股抽样 vs akshare")
    if args.offline:
        skip("个股跨源对账", "--offline")
    else:
        audit_stocks_vs_akshare(con, day, args.samples)
    print("[4] 指数 vs akshare")
    if args.offline:
        skip("指数跨源对账", "--offline")
    else:
        audit_index_vs_akshare(con, day)
    print("[5] 涨停口径校验（历史官方数据）")
    if con.execute("SELECT count(*) FROM core_limit_event WHERE trade_date=?", [day]).fetchall()[0][0]:
        audit_limit_method(con, day)
    else:
        skip("涨跌停事件口径", "指定日期无事件记录，不能用历史另一天冒充验证")
    # 与具体日期无关的口径纯净性检查：始终执行
    audit_limit_caliber(con)
    print("[6] 批量一致性")
    audit_integrity(con, day)
    print("[7] 静态 payload 一致性")
    latest_day = str(con.execute("SELECT max(trade_date) FROM mart_market_day").fetchone()[0])
    audit_payload(con, latest_day, lake.parent / "static-data.json")
    print("[8] 行业滚动指标（mart_sector_roll）")
    check_sector_roll(con, lake.parent / "meta")
    print("[9] 全历史完整性（部分交易日）")
    audit_history_completeness(con)
    con.close()

    passed = [r for r in RESULTS if r["ok"] is True]
    fails = [r for r in RESULTS if r["ok"] is False]
    skips = [r for r in RESULTS if r["ok"] is None]
    verdict = "fail" if fails else ("pass_with_skips" if skips else "pass")
    print(f"\n== 结果：{len(passed)} 通过 / {len(fails)} 失败 / {len(skips)} 跳过（共 {len(RESULTS)}）==")
    print(f"== verdict：{verdict}"
          + ("（跳过项不计入通过，外部对账缺失时不能宣称完整通过）" if skips else "") + " ==")
    for r in fails:
        print("  FAIL", r["item"], "expected", r["expected"], "actual", r["actual"], "diff", r["diff"], r["note"])
    for r in skips:
        print("  SKIP", r["item"], r["note"])

    lines = [
        f"# 数据审计报告 · {day}",
        "",
        f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 审计库：{lake}（只读连接）",
        f"- 范围：单日指标重算 = {day}；全历史完整性 = 全部交易日；跨源对账 = 抽样单日（akshare，可缺失）",
        f"- 样本：{len(RESULTS)} 项检查 · {len(passed)} 通过 · {len(fails)} 失败 · {len(skips)} 跳过",
        f"- verdict：**{verdict}**"
        + ("（skip 不计入通过，跨源对账缺失时不构成完整通过）" if skips else ""),
        "- 独立性：市场/行业指标为 `feat_stock` 派生层重算（同管线一层），非 core_* 独立实现。",
        "",
        "| 检查项 | 期望/原始 | 实际/mart | 差异 | 结果 | 备注 |",
        "|---|---:|---:|---:|:--:|---|",
    ]
    for r in RESULTS:
        exp = f"{r['expected']:.6g}" if isinstance(r["expected"], (int, float)) else str(r["expected"])
        act = f"{r['actual']:.6g}" if isinstance(r["actual"], (int, float)) else str(r["actual"])
        diff = "" if r["diff"] is None else f"{r['diff']:.6g}"
        mark = "✅" if r["ok"] is True else "❌" if r["ok"] is False else "⏭️"
        lines.append(f"| {r['item']} | {exp} | {act} | {diff} | {mark} | {r['note']} |")
    report = lake.parent / "meta" / "audit_report.md"
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[written] {report}")
    if fails:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
