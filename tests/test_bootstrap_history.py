"""历史建库门禁、指数预拉取与并发入口的单元测试（无网络）。"""

import shutil
import threading

import duckdb
import pandas as pd
import pytest

from pipeline import bootstrap_api
from pipeline.quality_gates import run_gates


# ---------------------------------------------------------------- 门禁作用域
def test_resolve_gate_scope_auto_recent_tail_uses_publish():
    today = "20261127"
    assert bootstrap_api.resolve_gate_scope("auto", "20261126", 100, 100, today=today) == "publish"
    assert bootstrap_api.resolve_gate_scope("auto", "20261125", 81, 100, today=today) == "publish"
    assert bootstrap_api.resolve_gate_scope("auto", "20261125", 80, 100, today=today) == "history"
    # 老区间即使位于末尾也用历史门禁，否则回补 2016 年会被发布门禁误拦
    assert bootstrap_api.resolve_gate_scope("auto", "20160104", 100, 100, today=today) == "history"


def test_resolve_gate_scope_explicit_modes_win():
    assert bootstrap_api.resolve_gate_scope("publish", "20160104", 1, 100) == "publish"
    assert bootstrap_api.resolve_gate_scope("history", "20261126", 100, 100) == "history"


# ---------------------------------------------------------------- 历史门禁
def _copy_scaled(tmp_path, scaled_lake):
    target = tmp_path / "scaled.duckdb"
    shutil.copyfile(scaled_lake.path, target)
    return target


def test_history_scope_coverage_floor_is_95pct(tmp_path, scaled_lake):
    lake = _copy_scaled(tmp_path, scaled_lake)
    day, prev = scaled_lake.days[-1], scaled_lake.days[-2]
    with duckdb.connect(str(lake)) as con:
        total = con.execute("SELECT count(*) FROM core_stock_day WHERE trade_date=?", [day]).fetchone()[0]
        con.execute(
            """UPDATE core_stock_day SET circ_mv=NULL WHERE trade_date=? AND ts_code IN (
                   SELECT ts_code FROM core_stock_day WHERE trade_date=? ORDER BY ts_code LIMIT 45)""",
            [day, day])
        publish = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                            persist=False, scope="publish")
        history = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                            persist=False, scope="history")
    publish_gate5 = next(g for g in publish["gates"] if g["id"] == 5)
    history_gate5 = next(g for g in history["gates"] if g["id"] == 5)
    assert 5 in publish["blocking"]
    assert history_gate5["pass"] is True
    assert abs(history_gate5["value"] - (total - 45) / total) < 1e-9
    assert "historical upstream coverage" in (history_gate5.get("message") or "")


def test_history_scope_still_blocks_truly_bad_coverage(tmp_path, scaled_lake):
    lake = _copy_scaled(tmp_path, scaled_lake)
    day, prev = scaled_lake.days[-1], scaled_lake.days[-2]
    with duckdb.connect(str(lake)) as con:
        con.execute(
            """UPDATE core_stock_day SET circ_mv=NULL WHERE trade_date=? AND ts_code IN (
                   SELECT ts_code FROM core_stock_day WHERE trade_date=? ORDER BY ts_code LIMIT 300)""",
            [day, day])
        gate = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                         persist=False, scope="history")
    gate5 = next(g for g in gate["gates"] if g["id"] == 5)
    assert gate5["pass"] is False
    assert 5 in gate["blocking"]


def test_history_scope_skips_publish_only_gates(tmp_path, scaled_lake):
    lake = _copy_scaled(tmp_path, scaled_lake)
    day, prev = scaled_lake.days[-1], scaled_lake.days[-2]
    with duckdb.connect(str(lake)) as con:
        gate = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                         persist=False, scope="history")
    assert set(gate["skipped"]) >= {6, 7, 9, 14, 15, 16, 17, 18}
    assert gate["not_applicable"] == [7, 14]
    for gid in (6, 7, 9, 14):
        entry = next(g for g in gate["gates"] if g["id"] == gid)
        assert entry["pass"] is None and entry["level"] == "info"
    assert 7 not in gate["blocking"] and 14 not in gate["blocking"]


def test_history_scope_price_gate_ignores_bse_rows(tmp_path, scaled_lake):
    """北交所 NEEQ 期数据可能缺 pct_chg/限价，但不在分析池内，不应阻断历史建库。"""
    lake = _copy_scaled(tmp_path, scaled_lake)
    day, prev = scaled_lake.days[-1], scaled_lake.days[-2]
    with duckdb.connect(str(lake)) as con:
        con.execute(
            """INSERT INTO core_stock_meta (ts_code, symbol, name, industry, market, exchange,
                   list_status, list_date) VALUES ('830001.BJ','830001','北证样例','银行','北交所','BSE','L','20200101')""")
        con.execute(
            """INSERT INTO core_stock_day (ts_code, trade_date, close, high, low)
               VALUES ('830001.BJ', ?, 2.0, 2.0, 2.0)""", [day])
        gate = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                         persist=False, scope="history")
        # 同一张表里放一个沪市结构异常行，历史门禁必须仍然阻断
        con.execute("UPDATE core_stock_day SET close=high*2 WHERE trade_date=? AND ts_code IN "
                    "(SELECT ts_code FROM core_stock_day WHERE trade_date=? LIMIT 1)", [day, day])
        bad = run_gates(con, day.strftime("%Y%m%d"), prev.strftime("%Y%m%d"),
                        persist=False, scope="history")
    gate3 = next(g for g in gate["gates"] if g["id"] == 3)
    assert gate3["pass"] is True
    bad3 = next(g for g in bad["gates"] if g["id"] == 3)
    assert bad3["pass"] is False
    assert 3 in bad["blocking"]


# ---------------------------------------------------------------- 并行取数入口
def test_fetch_day_returns_exceptions_and_does_not_mutate_disabled(monkeypatch):
    class _Boom:
        pass

    def fake_fetch(pro, ds, day):
        raise RuntimeError("抱歉，您没有接口(limit_list_d)访问权限")

    monkeypatch.setattr(bootstrap_api, "_thread_pro", lambda: object())
    monkeypatch.setattr(bootstrap_api, "fetch", fake_fetch)
    disabled: set[str] = set()
    result = bootstrap_api._fetch_day("20160104", disabled, threading.Lock())
    assert len(result) == len(bootstrap_api.DATASETS)
    assert all(isinstance(v, BaseException) for v in result.values())
    # 分类由主线程完成，工作线程不能擅自改 disabled（避免竞态语义）
    assert disabled == set()


# ---------------------------------------------------------------- 指数预拉取
class _FakeIndexPro:
    def __init__(self, days):
        self.days = days
        self.calls = []

    def index_daily(self, ts_code, start_date, end_date):
        self.calls.append((ts_code, start_date, end_date))
        return pd.DataFrame({
            "ts_code": [ts_code] * len(self.days),
            "trade_date": [d.strftime("%Y%m%d") for d in self.days],
            "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5,
            "pre_close": 100.0, "pct_chg": 0.5, "vol": 1000.0, "amount": 10000.0,
        })


def test_prefetch_indices_uses_one_call_per_code(tmp_path, scaled_lake):
    lake = _copy_scaled(tmp_path, scaled_lake)
    with duckdb.connect(str(lake)) as con:
        con.execute("DELETE FROM core_index_day")
        fake = _FakeIndexPro(scaled_lake.days)
        total = bootstrap_api._prefetch_indices(
            fake, con, scaled_lake.days[0].strftime("%Y%m%d"),
            scaled_lake.days[-1].strftime("%Y%m%d"))
        rows = con.execute("SELECT count(*) FROM core_index_day").fetchone()[0]
        codes = con.execute("SELECT count(DISTINCT ts_code) FROM core_index_day").fetchone()[0]
    assert total == len(scaled_lake.days) * len(bootstrap_api.INDEX_CODES) == rows
    assert codes == len(bootstrap_api.INDEX_CODES)
    assert len(fake.calls) == len(bootstrap_api.INDEX_CODES)


def test_prefetch_indices_tolerates_one_failed_code(tmp_path, scaled_lake):
    lake = _copy_scaled(tmp_path, scaled_lake)

    class _PartialPro(_FakeIndexPro):
        def index_daily(self, ts_code, start_date, end_date):
            if ts_code == "000905.SH":
                raise RuntimeError("boom")
            return super().index_daily(ts_code, start_date, end_date)

    with duckdb.connect(str(lake)) as con:
        con.execute("DELETE FROM core_index_day")
        total = bootstrap_api._prefetch_indices(
            _PartialPro(scaled_lake.days), con,
            scaled_lake.days[0].strftime("%Y%m%d"), scaled_lake.days[-1].strftime("%Y%m%d"))
        codes = con.execute("SELECT count(DISTINCT ts_code) FROM core_index_day").fetchone()[0]
    assert codes == len(bootstrap_api.INDEX_CODES) - 1
    assert total == len(scaled_lake.days) * (len(bootstrap_api.INDEX_CODES) - 1)
