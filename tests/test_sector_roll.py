"""mart_sector_roll 数据层口径测试（合成库：30 交易日 × 3 行业 = 90 行）。

对应方案 T2 的 6 项：行数、5/10 日预热期、rank 与 ret 的 null 对齐、
手工复利对账、以及 ew_ret=-1 不污染 ln()。
"""
from __future__ import annotations

import math

import duckdb
import pytest

from pipeline import build_marts

INDUSTRIES = 3
DAYS = 30


def _days(con) -> list:
    return [r[0] for r in con.execute(
        "SELECT DISTINCT trade_date FROM mart_sector_roll ORDER BY trade_date"
    ).fetchall()]


def test_table_has_same_row_count_as_sector_day(mutable_lake):
    """T2-1：表存在且行数 == mart_sector_day 行数（合成库 90 行）。"""
    with duckdb.connect(str(mutable_lake)) as con:
        n_roll = con.execute("SELECT count(*) FROM mart_sector_roll").fetchone()[0]
        n_day = con.execute("SELECT count(*) FROM mart_sector_day").fetchone()[0]
    assert n_roll == n_day == DAYS * INDUSTRIES


def test_ret_r5_is_null_for_first_four_days_only(mutable_lake):
    """T2-2：前 4 天 ret_r5 为 null；第 5 天起非 null。"""
    with duckdb.connect(str(mutable_lake)) as con:
        days = _days(con)
        assert len(days) == DAYS
        for day in days[:4]:
            n = con.execute(
                "SELECT count(*) FROM mart_sector_roll WHERE trade_date = ? AND ret_r5 IS NOT NULL", [day]
            ).fetchone()[0]
            assert n == 0, f"{day} 不应有 ret_r5（窗口不满 5 个交易日）"
        for day in days[4:]:
            n = con.execute(
                "SELECT count(*) FROM mart_sector_roll WHERE trade_date = ? AND ret_r5 IS NULL", [day]
            ).fetchone()[0]
            assert n == 0, f"{day} 起 ret_r5 应全为非空"
        nulls = con.execute("SELECT count(*) FROM mart_sector_roll WHERE ret_r5 IS NULL").fetchone()[0]
    assert nulls == INDUSTRIES * 4


def test_ret_r10_is_null_for_first_nine_days_only(mutable_lake):
    """T2-3：前 9 天 ret_r10 为 null；第 10 天起非 null。"""
    with duckdb.connect(str(mutable_lake)) as con:
        days = _days(con)
        for day in days[:9]:
            n = con.execute(
                "SELECT count(*) FROM mart_sector_roll WHERE trade_date = ? AND ret_r10 IS NOT NULL", [day]
            ).fetchone()[0]
            assert n == 0
        for day in days[9:]:
            n = con.execute(
                "SELECT count(*) FROM mart_sector_roll WHERE trade_date = ? AND ret_r10 IS NULL", [day]
            ).fetchone()[0]
            assert n == 0
        nulls = con.execute("SELECT count(*) FROM mart_sector_roll WHERE ret_r10 IS NULL").fetchone()[0]
    assert nulls == INDUSTRIES * 9


def test_rank_is_null_exactly_when_ret_is_null(mutable_lake):
    """T2-4：每日 rank_r10 非空数 == 行业数；rank_rN 的 null 数 == ret_rN 的 null 数。

    预热期若直接对 NULL 取 rank()，所有行业会并列第 1；这条测试防的就是那个 bug。
    """
    with duckdb.connect(str(mutable_lake)) as con:
        days = _days(con)
        for day in days[9:]:
            n = con.execute(
                "SELECT count(rank_r10) FROM mart_sector_roll WHERE trade_date = ?", [day]
            ).fetchone()[0]
            assert n == INDUSTRIES
        for w in (5, 10, 20):
            null_ret = con.execute(
                f"SELECT count(*) FROM mart_sector_roll WHERE ret_r{w} IS NULL"
            ).fetchone()[0]
            null_rank = con.execute(
                f"SELECT count(*) FROM mart_sector_roll WHERE rank_r{w} IS NULL"
            ).fetchone()[0]
            assert null_ret == null_rank == INDUSTRIES * (w - 1)


def test_manual_compounding_matches_ret_r5(mutable_lake):
    """T2-5：取合成库某行业连续 5 天，Python 重算复利，与库值一致。"""
    with duckdb.connect(str(mutable_lake)) as con:
        # 合成库里行业按 tushare_industry → SW L1 桥接（如 种植业 → 农林牧渔），
        # 这里不硬编码名称，直接取日收益最高（每日 +1%）的那一档。
        sector = con.execute(
            "SELECT sw_l1 FROM mart_sector_day GROUP BY 1 ORDER BY avg(ew_ret) DESC LIMIT 1"
        ).fetchone()[0]
        rows = con.execute(
            """
            SELECT d.trade_date, d.ew_ret, r.ret_r5
            FROM mart_sector_day d
            JOIN mart_sector_roll r USING (trade_date, sw_l1)
            WHERE r.sw_l1 = ?
            ORDER BY d.trade_date
            """,
            [sector],
        ).fetchall()
        index = 9
        window = rows[index - 4: index + 1]
        expected = math.exp(sum(math.log(1 + r[1]) for r in window)) - 1
        actual = rows[index][2]
    assert actual == pytest.approx(expected, rel=0, abs=1e-12)
    # 合成数据里该行业每日 ew_ret = +1%，5 日复利应为 1.01^5 - 1。
    assert window[-1][1] == pytest.approx(0.01, rel=0, abs=1e-15)
    assert expected == pytest.approx(1.01 ** 5 - 1, rel=0, abs=1e-12)


def test_minus_one_ew_ret_does_not_poison_log(mutable_lake):
    """T2-6：构造 ew_ret = -1 的行业日，复利结果必须是有限值而不是 -inf。"""
    with duckdb.connect(str(mutable_lake)) as con:
        day = con.execute("SELECT max(trade_date) FROM mart_sector_day").fetchone()[0]
        con.execute("UPDATE mart_sector_day SET ew_ret = -1 WHERE sw_l1 = '银行' AND trade_date = ?", [day])
        con.execute(build_marts.SQL_SECTOR_ROLL)
        value = con.execute(
            "SELECT ret_r5 FROM mart_sector_roll WHERE sw_l1 = '银行' AND trade_date = ?", [day]
        ).fetchone()[0]
    assert value is not None
    assert math.isfinite(value)
    assert -1 < value < 0


def test_rolling_uses_sector_observations_and_preserves_null_fields(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[23]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM mart_sector_day WHERE sw_l1='银行' AND trade_date=?", [synthetic_lake.days[22]])
        con.execute("UPDATE mart_sector_day SET ew_ret=.08, breadth=.75 WHERE sw_l1='银行' AND trade_date=?",
                    [synthetic_lake.days[18]])
        con.execute(build_marts.SQL_SECTOR_ROLL)
        rows = con.execute("""SELECT trade_date, ew_ret, breadth FROM mart_sector_day
            WHERE sw_l1='银行' AND trade_date<=? ORDER BY trade_date DESC LIMIT 5""", [day]).fetchall()
        assert rows[-1][0] == synthetic_lake.days[18]
        ret, br, rank = con.execute("""SELECT ret_r5, br_r5, rank_r5 FROM mart_sector_roll
            WHERE sw_l1='银行' AND trade_date=?""", [day]).fetchone()
        assert ret == pytest.approx(math.prod(1 + row[1] for row in rows) - 1)
        assert br == pytest.approx(sum(row[2] for row in rows) / 5)
        assert rank is not None
        con.execute(build_marts.SQL_SECTOR_RANK)
        paired = con.execute("""SELECT r.ret_r20, k.ret20 FROM mart_sector_roll r
            JOIN mart_sector_rank k USING (trade_date, sw_l1)
            WHERE sw_l1='银行' AND trade_date=?""", [day]).fetchone()
        assert paired[0] == pytest.approx(paired[1], rel=0, abs=1e-12)
        con.execute("UPDATE mart_sector_day SET ew_ret=NULL WHERE sw_l1='银行' AND trade_date=?",
                    [synthetic_lake.days[18]])
        con.execute(build_marts.SQL_SECTOR_ROLL)
        assert con.execute("""SELECT ret_r5, br_r5, rank_r5 FROM mart_sector_roll
            WHERE sw_l1='银行' AND trade_date=?""", [day]).fetchone() == (None, br, None)


def test_sector_roll_audit_catches_single_missing_return_and_matching_rank(mutable_lake, synthetic_lake, tmp_path):
    from scripts import audit_all

    audit_all.RESULTS.clear()
    try:
        with duckdb.connect(str(mutable_lake)) as con:
            con.execute("""UPDATE mart_sector_roll SET ret_r5=NULL, rank_r5=NULL
                WHERE sw_l1='银行' AND trade_date=?""", [synthetic_lake.days[-1]])
            audit_all.check_sector_roll(con, tmp_path)
        failures = [row for row in audit_all.RESULTS if row["ok"] is False]
        assert any(row["item"].startswith("rolling return mismatches") and row["actual"] == 1 for row in failures)
    finally:
        audit_all.RESULTS.clear()
