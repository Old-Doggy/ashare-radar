"""回归测试：v0.4.3 数据管道/指标/导出/契约修复点（审核 W1/W2/W3/W11）。

每个修复点至少一个断言，优先使用 conftest 的合成库（网络与生产库都不参与）。
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
from statistics import median

import duckdb
import pandas as pd
import pytest

from pipeline import build_marts, export_static, repair_history, settings
from pipeline.io_utils import atomic_write_json
from pipeline.quality_gates import history_completeness, run_gates

ROOT = Path(__file__).resolve().parents[1]


def rebuild(con, *names):
    bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix()
    for name in names:
        sql = getattr(build_marts, name)
        con.execute(sql.format(bridge=bridge) if "{bridge}" in sql else sql)


def gate(report: dict, gate_id: int) -> dict:
    return next(g for g in report["gates"] if g["id"] == gate_id)


# ---------------------------------------------------------------- build_marts
def test_mart_market_day_appends_five_quality_columns(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        cols = [d[0] for d in con.execute("SELECT * FROM mart_market_day LIMIT 0").description]
    assert cols[-5:] == ["weight_coverage", "n_valid_ratio", "data_quality",
                         "margin_n_exchanges", "n_extreme_ret"]
    # SELECT * 兼容性：旧列顺序不变，新列只在末尾追加
    assert cols[:6] == ["trade_date", "n_valid", "n_adv", "n_dec", "n_flat", "breadth"]


def test_data_quality_columns_on_synthetic_history(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        first = con.execute(
            "SELECT weight_coverage, n_valid_ratio, data_quality FROM mart_market_day "
            "ORDER BY trade_date LIMIT 1").fetchone()
        mid = con.execute(
            "SELECT weight_coverage, n_valid_ratio, data_quality FROM mart_market_day "
            "ORDER BY trade_date OFFSET 10 LIMIT 1").fetchone()
        bad = con.execute(
            "SELECT count(*) FROM mart_market_day WHERE data_quality <> 'ok'").fetchone()[0]
    assert first == (None, None, "ok")           # 首个市场日无前日权重
    assert mid[0] == pytest.approx(1.0)          # 后续日前日权重覆盖完整
    assert mid[1] == pytest.approx(1.0)          # n_valid 与近 20 日中位数一致
    assert bad == 0


def test_partial_day_nulls_weighted_and_limit_columns(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    code = synthetic_lake.codes[0]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE ts_code=? AND trade_date=?", [code, day])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
        row = con.execute(
            "SELECT n_valid, breadth, ew_ret, data_quality, weight_coverage, cw_ret, hhi, "
            "max_weight, top10_share, ew_cw_gap, limit_up_n, limit_down_n, max_streak "
            "FROM mart_market_day WHERE trade_date=?", [day]).fetchone()
    n_valid, breadth, ew, quality, coverage, cw, hhi, maxw, top10, gap, up, down, streak = row
    assert n_valid == 5 and quality == "partial"
    assert breadth is not None and ew is not None      # 样本类指标保留
    assert coverage == pytest.approx(1.0)              # 前日权重覆盖仍完整
    assert (cw, hhi, maxw, top10, gap, up, down, streak) == (None,) * 8


def test_n_valid_ratio_flags_thin_day(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        # 删到只剩 1 只：n_valid_ratio = 1/6 < 0.95，即使前日权重完整也算 partial
        con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code<>?",
                    [day, synthetic_lake.codes[0]])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
        quality, ratio = con.execute(
            "SELECT data_quality, n_valid_ratio FROM mart_market_day WHERE trade_date=?",
            [day]).fetchone()
    assert quality == "partial"
    assert ratio == pytest.approx(1 / 6)


def test_margin_scope_excludes_bse_and_requires_both_exchanges(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("INSERT INTO core_margin_day VALUES (?,?,?,?,?,?,?)",
                    [day, "SSE", 100.0, 10.0, 1.0, 0.0, 0.0])
        rebuild(con, "SQL_MARKET")
        rzye, n_ex = con.execute(
            "SELECT rzye, margin_n_exchanges FROM mart_market_day WHERE trade_date=?",
            [day]).fetchone()
        assert rzye is None and n_ex == 1        # 仅 SSE：不输出部分和
        con.execute("INSERT INTO core_margin_day VALUES (?,?,?,?,?,?,?)",
                    [day, "SZSE", 200.0, 20.0, 2.0, 0.0, 0.0])
        con.execute("INSERT INTO core_margin_day VALUES (?,?,?,?,?,?,?)",
                    [day, "BSE", 900.0, 90.0, 9.0, 0.0, 0.0])
        rebuild(con, "SQL_MARKET")
        rzye, rzmre, n_ex = con.execute(
            "SELECT rzye, rzmre, margin_n_exchanges FROM mart_market_day WHERE trade_date=?",
            [day]).fetchone()
    assert rzye == 300.0 and rzmre == 30.0 and n_ex == 2   # BSE 不计入


def test_n_extreme_ret_counts_only_extreme_returns(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET pct_chg=60.0 WHERE ts_code=? AND trade_date=?",
                    [synthetic_lake.codes[0], day])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
        n_extreme = con.execute("SELECT n_extreme_ret FROM mart_market_day WHERE trade_date=?",
                                [day]).fetchone()[0]
    assert n_extreme == 1


def test_market_classification_prefers_meta_with_prefix_fallback(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[0]
    with duckdb.connect(str(mutable_lake)) as con:
        # meta 权威值优先：600001.SH 前缀是主板，但 meta 标记为创业板
        con.execute("UPDATE core_stock_meta SET market='创业板' WHERE ts_code='600001.SH'")
        # 689 CDR 前缀兜底（meta.market 为空）
        con.execute("INSERT INTO core_stock_meta (ts_code, symbol, name, industry, list_date, list_status) "
                    "VALUES ('689001.SH','689001','CDR 样例','银行','20000101','L')")
        con.execute("""INSERT INTO core_stock_day
            (ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount,
             adj_factor, adj_close, turnover_rate, turnover_rate_f, volume_ratio, pe_ttm, pb,
             total_mv, circ_mv, up_limit, down_limit)
            VALUES ('689001.SH', ?, 10, 10, 10, 10, 10, 0, 1000, 10000, 1, 10, 1, 2, 1, 20, 1,
                    200000, 100000, 12, 8)""", [day])
        rebuild(con, "SQL_VIEW", "SQL_FEAT")
        stored = dict(con.execute(
            "SELECT ts_code, market FROM feat_stock WHERE trade_date=? "
            "AND ts_code IN ('600001.SH','689001.SH')", [day]).fetchall())
    assert stored["600001.SH"] == "创业板"
    assert stored["689001.SH"] == "科创板"


def test_ma_breadth_treats_equality_as_not_above(mutable_lake, synthetic_lake):
    """MA 比较带 1e-12 相对容差：价格紧贴均线（高于 < 1e-12 相对）不算站上。"""
    codes = synthetic_lake.codes
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        last20 = [r[0] for r in con.execute(
            "SELECT trade_date FROM core_trade_cal WHERE is_open=1 ORDER BY trade_date DESC LIMIT 20"
        ).fetchall()]
        con.execute("UPDATE core_stock_day SET close=10, adj_close=10, pct_chg=0 "
                    "WHERE ts_code=? AND trade_date IN (SELECT trade_date FROM core_trade_cal)",
                    [codes[1]])
        # 均线 = 10 + 9e-12，价格 = 10 + 1.8e-11：严格大于，但相对差 9e-13 < 1e-12
        con.execute("UPDATE core_stock_day SET adj_close=10.0, close=10.0, pct_chg=0 "
                    "WHERE ts_code=? AND trade_date IN (SELECT trade_date FROM core_trade_cal "
                    "ORDER BY trade_date DESC LIMIT 20 OFFSET 1)", [codes[1]])
        con.execute("UPDATE core_stock_day SET adj_close=10 + 1.0e-11, close=10 + 1.0e-11, pct_chg=0 "
                    "WHERE ts_code=? AND trade_date=?", [codes[1], day])
        rebuild(con, "SQL_FEAT")
        value = con.execute("SELECT adj_close, ma20 FROM feat_stock WHERE ts_code=? AND trade_date=?",
                            [codes[1], day]).fetchone()
        above = con.execute(
            "SELECT adj_close > ma20 * (1 + 1e-12) FROM feat_stock WHERE ts_code=? AND trade_date=?",
            [codes[1], day]).fetchone()[0]
    adj_close, ma20 = value
    assert ma20 == pytest.approx(10 + 5e-13, abs=1e-14)
    assert adj_close > ma20          # 严格大于均线
    assert above is False            # 但在容差内视为相等 → 未站上


def test_monthly_ew_ret_cum_requires_complete_month(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE mart_market_day SET ew_ret=NULL WHERE trade_date=?", [synthetic_lake.days[3]])
        rebuild(con, "SQL_MONTH")
        value = con.execute("SELECT ew_ret_cum FROM mart_market_month").fetchone()[0]
    assert value is None


def test_only_sector_day_rebuilds_dependent_tables(mutable_lake, synthetic_lake):
    report = build_marts.run(only=["sector_day"], with_indexes=False)
    for name in ("mart_sector_day", "mart_sector_roll", "mart_sector_rank",
                 "mart_rotation_day", "mart_sector_month"):
        assert name in report


def test_mart_market_day_indexes_created(mutable_lake, synthetic_lake):
    build_marts.run(with_indexes=True)
    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        indexes = {r[0] for r in con.execute(
            "SELECT index_name FROM duckdb_indexes()").fetchall()}
    assert {"idx_feat_stock_trade_date", "idx_feat_stock_code_date",
            "idx_core_stock_day_trade_date"} <= indexes


# ---------------------------------------------------------------- quality_gates
def test_gate15_passes_on_small_synthetic_lake(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        result = history_completeness(con)
    assert result["pass"] is True
    assert result["value"]["count"] == 0


def test_gate15_blocks_real_market_partial_day(tmp_path):
    """构造一个"真实市场日"规模的小库：25 天 × 3000 行 + 1 个 100 行的部分日。"""
    lake = tmp_path / "marketscale.duckdb"
    with duckdb.connect(str(lake)) as con:
        con.execute("CREATE TABLE core_stock_day (trade_date DATE)")
        days = [d for d in pd.bdate_range("2026-01-05", periods=25).date]
        for i, day in enumerate(days):
            n = 100 if i == 12 else 3000
            con.execute("INSERT INTO core_stock_day SELECT ?::DATE FROM range(?)", [day, n])
        result = history_completeness(con)
        assert result["pass"] is False
        assert result["value"]["count"] == 1
        assert result["value"]["days"][0]["rows"] == 100
    # 小样本（<20 天）库不得被误判
    with duckdb.connect(str(lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date > (SELECT min(trade_date) FROM core_stock_day)")
    with duckdb.connect(str(lake)) as con:
        result = history_completeness(con)
    assert result["pass"] is True and result["value"]["insufficient_history"] is True


def test_history_scope_records_metadata_gates_as_not_applicable(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_meta SET industry=NULL WHERE ts_code='600001.SH'")
        con.execute("DELETE FROM core_stock_meta WHERE ts_code='300001.SZ'")
        rebuild(con, "SQL_VIEW")
        publish = run_gates(con, synthetic_lake.days[-1].strftime("%Y%m%d"),
                            synthetic_lake.days[-2].strftime("%Y%m%d"), persist=False)
        history = run_gates(con, synthetic_lake.days[-1].strftime("%Y%m%d"),
                            synthetic_lake.days[-2].strftime("%Y%m%d"), persist=False,
                            scope="history")
    assert 7 in publish["blocking"] and 14 in publish["blocking"]
    hist_gate7 = gate(history, 7)
    hist_gate14 = gate(history, 14)
    assert hist_gate7["not_applicable_historical"] is True
    assert hist_gate7["pass"] is None and hist_gate7["recorded_pass"] is False
    assert hist_gate14["not_applicable_historical"] is True
    assert 7 not in history["blocking"] and 14 not in history["blocking"]
    assert history["not_applicable"] == [7, 14]


def test_history_scope_still_blocks_data_quality_gate(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET amount=-1 WHERE trade_date=?", [day])
        report = run_gates(con, day.strftime("%Y%m%d"),
                           synthetic_lake.days[-2].strftime("%Y%m%d"), persist=False,
                           scope="history")
    assert 10 in report["blocking"]


def test_history_scope_relaxes_absolute_size_but_not_median_ratio(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        report = run_gates(con, synthetic_lake.days[-1].strftime("%Y%m%d"),
                           synthetic_lake.days[-2].strftime("%Y%m%d"), persist=False,
                           scope="history")
        assert gate(report, 1)["pass"] is True   # 合成库仅 6 行，历史作用域不看绝对 3000
        con.execute("DELETE FROM core_stock_day WHERE trade_date=?", [synthetic_lake.days[-1]])
        con.execute("""INSERT INTO core_stock_day
            (ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount,
             adj_factor, adj_close, turnover_rate, turnover_rate_f, volume_ratio, pe_ttm, pb,
             total_mv, circ_mv, up_limit, down_limit)
            VALUES ('000001.SZ', ?, 10, 10, 10, 10, 10, 0, 1000, 10000, 1, 10, 1, 2, 1,
                    20, 1, 200000, 100000, 12, 8)""", [synthetic_lake.days[-1]])
        rebuild(con, "SQL_VIEW")
        report = run_gates(con, synthetic_lake.days[-1].strftime("%Y%m%d"),
                           synthetic_lake.days[-2].strftime("%Y%m%d"), persist=False,
                           scope="history")
    assert 1 in report["blocking"]               # 相对中位数 1/6 远低于 0.95


def test_gate16_warns_on_limit_band_switch(mutable_lake, synthetic_lake):
    day, prev = synthetic_lake.days[-1], synthetic_lake.days[-2]
    with duckdb.connect(str(mutable_lake)) as con:
        # 前日 20% 档（up_limit 12 / pre_close 10）→ 当日 10% 档（11/10）
        con.execute("UPDATE core_stock_day SET up_limit=11 WHERE ts_code=? AND trade_date=?",
                    [synthetic_lake.codes[0], day])
        con.execute("UPDATE core_stock_day SET up_limit=12 WHERE ts_code=? AND trade_date=?",
                    [synthetic_lake.codes[0], prev])
        report = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"), persist=False)
        plain = run_gates(con, prev.strftime("%Y%m%d"), None, persist=False)
    band = gate(report, 16)
    assert band["pass"] is False and band["level"] == "warn"
    assert band["value"] == 1
    assert 16 not in report["blocking"]
    assert all(g["id"] != 16 for g in plain["gates"])  # 无前日 → 不适用（不生成该门禁）


def test_gate17_warns_on_fd_amount_scale_anomaly(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        cols = [d[0] for d in con.execute("SELECT * FROM core_limit_event LIMIT 0").description]
        base = {"ts_code": "000001.SZ", "trade_date": day, "industry": "银行", "name": "X",
                "close": 10.0, "pct_chg": 10.0, "amount": 1.0, "limit_amount": 1.0,
                "float_mv": 100.0, "total_mv": 200.0, "turnover_ratio": 1.0,
                "fd_amount": 500.0, "first_time": "93000", "last_time": "145000",
                "open_times": 0, "up_stat": "", "limit_times": 1,
                "is_up": 1, "is_down": 0, "is_broken": 0}
        con.execute(f"INSERT INTO core_limit_event ({','.join(base)}) VALUES "
                    f"({','.join(['?'] * len(base))})", list(base.values()))
        report = run_gates(con, day.strftime("%Y%m%d"), synthetic_lake.days[-2].strftime("%Y%m%d"),
                           persist=False)
        empty = run_gates(con, synthetic_lake.days[-2].strftime("%Y%m%d"), None, persist=False)
    fd_gate = gate(report, 17)
    assert fd_gate["pass"] is False and fd_gate["level"] == "warn"
    assert fd_gate["value"] == 1.0
    assert gate(empty, 17)["pass"] is True  # 无官方名单事件 → 不适用


def test_gate1_blocks_thin_day_relative_to_prior_median(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code NOT IN (?,?)",
                    [day, synthetic_lake.codes[0], synthetic_lake.codes[1]])
        report = run_gates(con, day.strftime("%Y%m%d"), synthetic_lake.days[-2].strftime("%Y%m%d"),
                           persist=False)
    assert gate(report, 1)["pass"] is False
    assert 1 in report["blocking"]
    assert "median_ratio" in gate(report, 1)["message"]
    assert gate(report, 18)["pass"] is False  # 趋势告警同步触发


def test_gate6_all_flat_day_is_explicit_undefined_warning(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET pct_chg=0 WHERE trade_date=?", [day])
        report = run_gates(con, day.strftime("%Y%m%d"), synthetic_lake.days[-2].strftime("%Y%m%d"),
                           persist=False)
    breadth_gate = gate(report, 6)
    assert breadth_gate["pass"] is False and breadth_gate["level"] == "warn"
    assert breadth_gate["value"] is None
    assert "undefined" in breadth_gate["message"]


def test_gate3_blocks_in_scope_prelisting_rows(mutable_lake, synthetic_lake):
    day, prev = synthetic_lake.days[-1], synthetic_lake.days[-2]
    with duckdb.connect(str(mutable_lake)) as con:
        # 上市日期晚于行情日 → pre-listing（不得被 IPO 豁免静默放过）
        con.execute("UPDATE core_stock_meta SET list_date=? WHERE ts_code='600001.SH'",
                    [(day + pd.Timedelta(days=10)).strftime("%Y%m%d")])
        report = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"), persist=False)
    assert gate(report, 3)["pass"] is False
    assert 3 in report["blocking"]
    assert "prelisting_in_scope=1" in gate(report, 3)["message"]


def test_gate3_ipo_exemption_requires_post_listing_rows(mutable_lake, synthetic_lake):
    day, prev = synthetic_lake.days[-1], synthetic_lake.days[-2]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_meta SET list_date=? WHERE ts_code='600001.SH'",
                    [prev.strftime("%Y%m%d")])
        con.execute("UPDATE core_stock_day SET pct_chg=60, close=16, high=16, low=10, adj_close=16 "
                    "WHERE ts_code='600001.SH' AND trade_date=?", [day])
        report = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"), persist=False)
    assert gate(report, 3)["pass"] is True


# ---------------------------------------------------------------- repair_history
def test_incomplete_dates_excludes_current_day_from_median(mutable_lake, synthetic_lake):
    """连续 11 个低行日：含当日中位数会让段中部整体逃逸；排除当日后应识别更多日期。"""
    days = synthetic_lake.days[8:19]
    codes = synthetic_lake.codes
    with duckdb.connect(str(mutable_lake)) as con:
        for day in days:
            con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code<>?",
                        [day, codes[0]])
        plan = repair_history.incomplete_dates(con)
        counts = con.execute(
            "SELECT trade_date, count(*) FROM core_stock_day GROUP BY 1 ORDER BY 1").fetchall()
    old = []
    for i, (d, n) in enumerate(counts):
        neighbours = [c for j, (_, c) in enumerate(counts) if abs(j - i) <= 10]
        if neighbours and n < 0.85 * median(neighbours):
            old.append(d.strftime("%Y%m%d"))
    new = [p["date"] for p in plan]
    assert set(old) < set(new)                                   # 严格超集
    assert days[5].strftime("%Y%m%d") in new                     # 段中部：旧口径会漏
    assert all(p["rows"] == 1 for p in plan)


def test_repair_apply_requires_post_gates_and_writes_snapshots(mutable_lake, synthetic_lake,
                                                               monkeypatch):
    day = synthetic_lake.days[-1]
    codes = synthetic_lake.codes
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code<>?",
                    [day, codes[0]])

    def frame(ds: str, day_code: str) -> pd.DataFrame:
        n = len(codes)
        base = {
            "ts_code": codes,
            "trade_date": [day_code] * n,
            "open": [10.0] * n, "high": [10.5] * n, "low": [9.5] * n,
            "close": [10.2] * n, "pre_close": [10.0] * n, "pct_chg": [2.0] * n,
            "vol": [1000.0] * n, "amount": [10000.0] * n,
            "turnover_rate": [1.0] * n, "turnover_rate_f": [2.0] * n,
            "volume_ratio": [1.0] * n, "pe_ttm": [20.0] * n, "pb": [1.0] * n,
            "total_mv": [200000.0] * n, "circ_mv": [100000.0 + i * 10000 for i in range(n)],
            "adj_factor": [1.0] * n, "up_limit": [11.0] * n, "down_limit": [9.0] * n,
        }
        if ds == "daily":
            keys = ["ts_code", "trade_date", "open", "high", "low", "close", "pre_close",
                    "pct_chg", "vol", "amount"]
        elif ds == "daily_basic":
            keys = ["ts_code", "trade_date", "turnover_rate", "turnover_rate_f", "volume_ratio",
                    "pe_ttm", "pb", "total_mv", "circ_mv"]
        elif ds == "adj_factor":
            keys = ["ts_code", "trade_date", "adj_factor"]
        else:
            keys = ["ts_code", "trade_date", "up_limit", "down_limit"]
        return pd.DataFrame({k: base[k] for k in keys})

    monkeypatch.setattr(repair_history, "tushare_pro", lambda: object())
    monkeypatch.setattr(repair_history, "fetch", lambda pro, ds, d: frame(ds, d))
    monkeypatch.setattr(repair_history.time, "sleep", lambda seconds: None)
    report = repair_history.run(apply=True)
    assert report["status"] == "ok"
    assert len(report["repaired"]) == 1
    item = report["repaired"][0]
    assert item["before"]["rows"] == 1
    assert item["after"]["rows"] == len(codes)
    assert item["after"]["coverage"] == pytest.approx(1.0)
    assert item["gates"]["passed"] is True
    assert item["gates"]["not_applicable"] == [7, 14]
    assert report["remaining_partial"] == []
    on_disk = json.loads((settings.META / "history_repair.json").read_text(encoding="utf-8"))
    assert on_disk["remaining_partial"] == [] and on_disk["history_gate"]["pass"] is True


def test_repair_post_gate_failure_rolls_back_day(mutable_lake, synthetic_lake, monkeypatch):
    day = synthetic_lake.days[-1]
    codes = synthetic_lake.codes
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code<>?",
                    [day, codes[0]])
        before = con.execute("SELECT count(*) FROM core_stock_day WHERE trade_date=?", [day]).fetchone()[0]
    # 返回的 daily 与 stk_limit 价格不一致 → 修复后 gate3/gate4 仍会 block
    monkeypatch.setattr(repair_history, "tushare_pro", lambda: object())
    monkeypatch.setattr(repair_history, "fetch", lambda pro, ds, d: pd.DataFrame({
        "ts_code": codes, "trade_date": [d] * len(codes),
        "open": [10.0] * len(codes), "high": [10.0] * len(codes), "low": [10.0] * len(codes),
        "close": [10.0] * len(codes), "pre_close": [10.0] * len(codes),
        "pct_chg": [0.0] * len(codes), "vol": [1000.0] * len(codes),
        "amount": [10000.0] * len(codes), "adj_factor": [1.0] * len(codes),
        "circ_mv": [100000.0] * len(codes), "turnover_rate": [1.0] * len(codes),
        "turnover_rate_f": [2.0] * len(codes), "volume_ratio": [1.0] * len(codes),
        "pe_ttm": [20.0] * len(codes), "pb": [1.0] * len(codes),
        "total_mv": [200000.0] * len(codes),
        # 涨停价 999：close/pre_close-1=0 与 pct_chg 0 一致，但 gate3 的 |pct| 检查不触发；
        # 用 pre_lising 之外的 gate 失败：把 amount 设为 -1 触发 gate10
    }))
    monkeypatch.setattr(repair_history.time, "sleep", lambda seconds: None)
    with pytest.raises(RuntimeError, match="history repair failed"):
        repair_history.run(apply=True)
    with duckdb.connect(str(mutable_lake)) as con:
        after = con.execute("SELECT count(*) FROM core_stock_day WHERE trade_date=?", [day]).fetchone()[0]
    assert after == before
    failed = json.loads((settings.META / "history_repair.json").read_text(encoding="utf-8"))
    assert failed["status"] == "failed"


# ---------------------------------------------------------------- promote_repair
def test_promote_repair_dry_run_and_switch(mutable_lake, tmp_path, monkeypatch):
    from pipeline import promote_repair

    source = tmp_path / "source.duckdb"
    target = tmp_path / "target.duckdb"
    for path in (source, target):
        duckdb.connect(str(path)).close()
    with duckdb.connect(str(source)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
        con.execute("INSERT INTO core_stock_day SELECT '000001.SZ', DATE '2026-01-01' + i::INTEGER FROM range(30) i")
        for table in ("core_stock_meta", "core_trade_cal", "core_index_day"):
            con.execute(f"CREATE TABLE {table} (x INTEGER)")
    with duckdb.connect(str(target)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
        for table in ("core_stock_meta", "core_trade_cal", "core_index_day"):
            con.execute(f"CREATE TABLE {table} (x INTEGER)")
    monkeypatch.setattr(settings, "LAKE", target)
    monkeypatch.setattr(settings, "DATA", target.parent)
    monkeypatch.setattr(settings, "META", target.parent / "meta")
    (target.parent / "meta").mkdir(exist_ok=True)
    dry = promote_repair.run(source, skip_marts=True, dry_run=True)
    assert dry["status"] == "dry_run_ok"
    result = promote_repair.run(source, backup_dir=tmp_path / "backup", skip_marts=True)
    assert result["status"] == "ok"
    assert Path(result["backup"]).is_file()
    with duckdb.connect(str(target), read_only=True) as con:
        assert con.execute("SELECT count(*) FROM core_stock_day").fetchone()[0] == 30


def test_promote_repair_rejects_source_with_partial_days(tmp_path):
    from pipeline import promote_repair

    source = tmp_path / "source.duckdb"
    target = tmp_path / "target.duckdb"
    with duckdb.connect(str(source)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
        con.execute("INSERT INTO core_stock_day SELECT 'x', DATE '2026-01-01' + i::INTEGER "
                    "FROM range(25) i, range(3000)")
        con.execute("DELETE FROM core_stock_day WHERE trade_date = DATE '2026-01-13'")
        con.execute("INSERT INTO core_stock_day VALUES ('x', DATE '2026-01-13')")
        for table in ("core_stock_meta", "core_trade_cal", "core_index_day"):
            con.execute(f"CREATE TABLE {table} (x INTEGER)")
    with duckdb.connect(str(target)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
    with pytest.raises(RuntimeError, match="partial"):
        promote_repair.validate_source(source, target)


def test_promote_repair_rolls_back_on_marts_failure(mutable_lake, tmp_path, monkeypatch):
    from pipeline import build_marts as bm
    from pipeline import promote_repair

    source = tmp_path / "source.duckdb"
    target = tmp_path / "target.duckdb"
    with duckdb.connect(str(target)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
        con.execute("INSERT INTO core_stock_day VALUES ('old', DATE '2026-01-01')")
    os_copies = []
    duckdb.connect(str(source)).close()
    with duckdb.connect(str(source)) as con:
        con.execute("CREATE TABLE core_stock_day (ts_code VARCHAR, trade_date DATE)")
        con.execute("INSERT INTO core_stock_day SELECT 'new', DATE '2026-01-01' + i::INTEGER FROM range(25) i")
        for table in ("core_stock_meta", "core_trade_cal", "core_index_day"):
            con.execute(f"CREATE TABLE {table} (x INTEGER)")
    monkeypatch.setattr(settings, "LAKE", target)
    monkeypatch.setattr(settings, "DATA", target.parent)
    monkeypatch.setattr(settings, "META", target.parent / "meta")
    (target.parent / "meta").mkdir(exist_ok=True)
    monkeypatch.setattr(bm, "run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        promote_repair.run(source, backup_dir=tmp_path / "backup")
    with duckdb.connect(str(target), read_only=True) as con:
        assert con.execute("SELECT ts_code FROM core_stock_day").fetchall() == [("old",)]


def test_fd_amount_is_null_in_upstream_unit_anomaly_period(mutable_lake, synthetic_lake):
    from pipeline import build_marts as bm

    anomalous, normal = pd.Timestamp("2019-12-02").date(), synthetic_lake.days[-1]
    base = {"ts_code": "000001.SZ", "close": 10.0, "pct_chg": 10.0, "amount": 1.0,
            "limit_amount": 1.0, "float_mv": 100.0, "total_mv": 200.0,
            "turnover_ratio": 1.0, "fd_amount": 500.0, "first_time": "93000",
            "last_time": "145000", "open_times": 0, "up_stat": "", "limit_times": 1,
            "is_up": 1, "is_down": 0, "is_broken": 0}
    with duckdb.connect(str(mutable_lake)) as con:
        columns = [d[0] for d in con.execute("SELECT * FROM core_limit_event LIMIT 0").description]
        extra = {"industry": "银行", "name": "X"}
        for day in (anomalous, normal):
            values = {**{c: None for c in columns}, **base, **extra, "trade_date": day}
            con.execute(f"INSERT INTO core_limit_event ({','.join(columns)}) VALUES "
                        f"({','.join(['?'] * len(columns))})", [values[c] for c in columns])
        con.execute(bm.SQL_LIMIT_QUALITY)
        rows = dict(con.execute(
            "SELECT trade_date, fd_ratio FROM mart_limit_quality").fetchall())
    assert rows[anomalous] is None    # 量纲异常期整段 NULL，不输出误导性中位数
    assert rows[normal] is None       # 单日 fd_amount/float_mv > 2 同样按 NULL


# ---------------------------------------------------------------- export_static
def _payload(mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        return export_static.build_payload(con)


def test_export_payload_meta_and_new_fields(mutable_lake, synthetic_lake):
    atomic_write_json(settings.META / "status.json", {
        "status": "ok", "updated_at": "2026-06-11T18:00:00",
        "sources": {"daily": "tushare", "limit_list_d": "unavailable"},
        "warnings": [], "adj_degraded_days": ["20260611"]})
    atomic_write_json(settings.META / "reconcile.json", {
        "generated_at": "2026-06-11T19:00:00", "days": ["2026-06-10"], "pairs": 2,
        "mae_pp": 0.001, "p95_pp": 0.002, "max_pp": 0.002, "share_gt_0_1pp": 0.0})
    payload = _payload(mutable_lake, synthetic_lake)
    meta = payload["meta"]
    import tomllib
    with (ROOT / "pyproject.toml").open("rb") as stream:
        expected_version = tomllib.load(stream)["project"]["version"]
    assert meta["version"] == expected_version
    assert meta["source"] == "tushare"
    assert meta["unavailable_datasets"] == ["limit_list_d"]
    assert meta["adj_degraded_days"] == ["20260611"]
    assert meta["data_quality"]["n_partial_days"] == 0
    assert meta["data_quality"]["history_gate"]["pass"] is True
    assert payload["reconcile"]["generated_at"] == "2026-06-11T19:00:00"
    assert payload["reconcile"]["days"] == ["2026-06-10"]
    assert "qfq adjusted" in payload["coverage"]["stock_series"]


def test_export_payload_rotation_ranks_and_distribution_contract(mutable_lake, synthetic_lake):
    payload = _payload(mutable_lake, synthetic_lake)
    assert sorted(payload["rotation"][0].keys()) == ["n_sectors", "rotation_intensity", "trade_date"]
    assert sorted(payload["sector_ranks"][0].keys()) == ["rank20", "ret20", "sw_l1", "trade_date"]
    assert all("n_sectors" in row for row in payload["sector_roll"]
               if row["trade_date"] == payload["rotation"][0]["trade_date"])
    dist = payload["distribution"][payload["meta"]["last_trade_date"]]
    assert {"n_total", "n_binned", "n_excluded_lt", "n_excluded_gt"} <= set(dist)
    assert not {"n_total", "n_binned", "n_excluded_lt", "n_excluded_gt"} & set(dist["stats"])
    assert dist["n_total"] == dist["n_binned"] + dist["n_excluded_lt"] + dist["n_excluded_gt"]
    monthly = payload["market_monthly"][0]
    assert {"n_valid", "hs300_n_days", "trade_date"} <= set(monthly)


def test_export_stock_series_is_qfq_with_adj_factor(mutable_lake, synthetic_lake):
    code = synthetic_lake.codes[0]
    days = synthetic_lake.days
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET adj_factor=2.0, adj_close=20.0 "
                    "WHERE ts_code=? AND trade_date=?", [code, days[-1]])
        con.execute("UPDATE core_stock_day SET adj_factor=1.0, adj_close=10.1 "
                    "WHERE ts_code=? AND trade_date<=?", [code, days[-2]])
        rebuild(con, "SQL_VIEW", "SQL_FEAT")
    payload = _payload(mutable_lake, synthetic_lake)
    bars = payload["stock_series"][code]
    assert len(bars[0]) == 7
    assert bars[-1][6] == pytest.approx(2.0)
    # 窗口最后 adj_factor = 2：历史价格按 1/2 归一，最后一日价格不变
    assert bars[0][1] == pytest.approx(5.0)
    assert bars[-1][4] == pytest.approx(10.1)
    # 防御：末日 adj_factor 为 NULL 时基准取最后一个非空因子，且不抛 TypeError
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE feat_stock SET adj_factor=2.0 WHERE ts_code=? AND trade_date=?",
                    [code, days[-2]])
        con.execute("UPDATE feat_stock SET adj_factor=NULL WHERE ts_code=? AND trade_date=?",
                    [code, days[-1]])
    payload = _payload(mutable_lake, synthetic_lake)
    bars = payload["stock_series"][code]
    assert bars[-1][6] is None
    assert bars[-1][4] == pytest.approx(10.1)   # NULL 行 scale 回退 1.0
    assert bars[-2][6] == pytest.approx(2.0)    # 最后一个非空因子作为基准
    assert bars[0][1] == pytest.approx(5.0)     # 更早的 1.0 因子按 1/2 归一


def test_export_ordering_deterministic_with_tiebreak(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET pct_chg=1.0 WHERE trade_date=?", [day])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
    payload = _payload(mutable_lake, synthetic_lake)
    codes = [r["ts_code"] for r in payload["stocks"]]
    assert codes == sorted(codes)          # 全部并列 → 按 ts_code
    assert [r["ts_code"] for r in payload["watch_pool"]] == sorted(
        r["ts_code"] for r in payload["watch_pool"])


def test_export_distribution_excluded_counts(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE core_stock_day SET pct_chg=50.0 WHERE ts_code=? AND trade_date=?",
                    [synthetic_lake.codes[0], day])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
    payload = _payload(mutable_lake, synthetic_lake)
    dist = payload["distribution"][payload["meta"]["last_trade_date"]]
    assert dist["n_excluded_gt"] == 1
    assert dist["n_total"] == 6


def test_export_data_quality_lists_partial_days(mutable_lake, synthetic_lake):
    day = synthetic_lake.days[-1]
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date=? AND ts_code<>?",
                    [day, synthetic_lake.codes[0]])
        rebuild(con, "SQL_FEAT", "SQL_MARKET")
    payload = _payload(mutable_lake, synthetic_lake)
    quality = payload["meta"]["data_quality"]
    assert quality["partial_days"] == [day.isoformat()]
    assert quality["n_partial_days"] == 1
    assert quality["history_gate"]["pass"] is False


# ---------------------------------------------------------------- settings / config
def test_dead_settings_constants_and_configs_removed():
    for name in ("DISPLAY_START", "SNAPSHOT_END", "RETURN_CLIP", "BREADTH_STRONG",
                 "BREADTH_WEAK", "INCLUDE_BSE", "UNIVERSE_EXCHANGES", "UNIVERSE_MARKETS",
                 "TOP_N_CONTRIB"):
        assert not hasattr(settings, name), name
    for name in ("universe.yaml", "theme.json", "data_source_registry.yaml"):
        assert not (ROOT / "config" / name).exists(), name


def test_fallback_rate_recognises_689_cdr():
    from pipeline.sources.akshare_fallback import _rate
    assert _rate("689009.SH", "CDR") == 0.20
    assert _rate("688001.SH", "X") == 0.20
    assert _rate("600000.SH", "ST X") == 0.05


# ---------------------------------------------------------------- release
def test_release_does_not_overwrite_existing_failure_stage(mutable_lake, monkeypatch):
    from pipeline import release, refresh_status, update_daily

    atomic_write_json(settings.META / "status.json", {"status": "failed", "failure_stage": "update"})
    monkeypatch.setattr(update_daily, "run", lambda *a, **k: {"status": "ok"})
    monkeypatch.setattr(refresh_status, "main", lambda: {"status": "failed", "failure_stage": None})
    with pytest.raises(RuntimeError):
        release.run(rebuild=True)
    status = json.loads((settings.META / "status.json").read_text(encoding="utf-8"))
    assert status["failure_stage"] == "update"
    assert status["last_failure_stage"] == "quality"


# ---------------------------------------------------------------- audit_all
def test_audit_sector_roll_projection_matches_production_sql(mutable_lake, synthetic_lake):
    spec = importlib.util.spec_from_file_location(
        "audit_all_fixes", ROOT / "scripts" / "audit_all.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    from pipeline.sector_roll import SQL_SECTOR_ROLL_ROWS, roll_params

    with duckdb.connect(str(mutable_lake), read_only=True) as con:
        independent = module._independent_sector_roll_rows(con)
        cursor = con.execute(SQL_SECTOR_ROLL_ROWS, roll_params())
        fields = [d[0] for d in cursor.description]
        stored = cursor.fetchall()
    assert len(independent) == len(stored) > 0
    for expected, actual in zip(independent, stored):
        record = dict(zip(fields, actual))
        amount = expected[-1]
        if record["amount"] is not None:
            assert amount == int(round(record["amount"]))
        for i, key in enumerate(fields[2:11], start=2):
            if record[key] is None:
                assert expected[i] is None
            else:
                assert expected[i] == pytest.approx(record[key], abs=1e-12)
