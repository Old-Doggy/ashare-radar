"""Synthetic, network-free test data; never import production settings first."""
from __future__ import annotations

import atexit
from dataclasses import dataclass
from datetime import date, timedelta
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

import pytest


_TEST_ROOT = TemporaryDirectory(prefix="ashare-radar-tests-")
atexit.register(_TEST_ROOT.cleanup)
os.environ["ASHARE_RADAR_DATA_DIR"] = _TEST_ROOT.name
os.environ["ASHARE_RADAR_LOAD_ENV"] = "0"
os.environ["TUSHARE_TOKEN"] = ""


def pytest_configure(config):
    if not config.option.basetemp:
        config.option.basetemp = str(Path(_TEST_ROOT.name) / "pytest")


@dataclass(frozen=True)
class SyntheticLake:
    path: Path
    days: tuple[date, ...]
    codes: tuple[str, ...]

    @property
    def latest(self) -> str:
        return self.days[-1].isoformat()


@pytest.fixture(scope="session")
def synthetic_lake(tmp_path_factory):
    """Six established stocks, three sectors and thirty synthetic trading days."""
    import duckdb

    from pipeline import build_marts
    from pipeline.bootstrap_api import _init
    from pipeline import settings

    root = tmp_path_factory.mktemp("synthetic-source")
    lake = root / "source.duckdb"
    days = []
    d = date(2026, 5, 1)
    while len(days) < 30:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    codes = ("000001.SZ", "600000.SH", "300001.SZ", "301001.SZ", "688001.SH", "600001.SH")
    industries = ("银行", "银行", "种植业", "种植业", "化工原料", "化工原料")
    returns = (1.0, -1.0, 0.0, 2.0, -2.0, 0.5)
    with duckdb.connect(str(lake)) as con:
        _init(con)
        con.executemany(
            "INSERT INTO core_trade_cal (cal_date, trade_date, pretrade_date, is_open) VALUES (?, ?, ?, 1)",
            [(d.strftime("%Y%m%d"), d, (days[i - 1] if i else d - timedelta(days=1)).strftime("%Y%m%d"))
             for i, d in enumerate(days)],
        )
        for i, code in enumerate(codes):
            con.execute(
                "INSERT INTO core_stock_meta (ts_code, symbol, name, industry, list_date, list_status) "
                "VALUES (?, ?, ?, ?, '20000101', 'L')",
                [code, code[:6], f"Synthetic {i}", industries[i]],
            )
            for d in days:
                close = 10 * (1 + returns[i] / 100)
                con.execute(
                    """INSERT INTO core_stock_day
                    (ts_code, trade_date, open, high, low, close, pre_close, pct_chg,
                     vol, amount, adj_factor, adj_close, turnover_rate, turnover_rate_f,
                     volume_ratio, pe_ttm, pb, total_mv, circ_mv, up_limit, down_limit)
                    VALUES (?, ?, 10, ?, ?, ?, 10, ?, 1000, 10000, 1, ?, 1, 2, 1, 20, 1,
                            200000, ?, 12, 8)""",
                    [code, d, max(10, close), min(10, close), close, returns[i], close, 100000 + i * 10000],
                )
        for d in days:
            for code in ("000300.SH", "000905.SH", "000852.SH", "000001.SH"):
                con.execute(
                    "INSERT INTO core_index_day "
                    "(ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount) "
                    "VALUES (?, ?, 100, 101, 100, 101, 100, 1, 1000, 10000)",
                    [code, d],
                )
        bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix()
        for _, sql in build_marts.STEPS:
            con.execute(sql.format(bridge=bridge) if "{bridge}" in sql else sql)
    return SyntheticLake(lake, tuple(days), codes)


@pytest.fixture()
def mutable_lake(synthetic_lake, tmp_path, monkeypatch):
    """A fresh copy per test, so SQL changes cannot leak into another test."""
    from pipeline import settings

    lake = tmp_path / "lake.duckdb"
    shutil.copyfile(synthetic_lake.path, lake)
    meta = tmp_path / "meta"
    meta.mkdir()
    monkeypatch.setattr(settings, "DATA", tmp_path)
    monkeypatch.setattr(settings, "LAKE", lake)
    monkeypatch.setattr(settings, "META", meta)
    return lake


@pytest.fixture()
def db_client(mutable_lake, tmp_path, monkeypatch):
    import backend.main as backend
    from pipeline import settings

    monkeypatch.setattr(backend, "LAKE", mutable_lake)
    monkeypatch.setattr(backend, "META", settings.META)
    monkeypatch.setattr(backend, "DB", tmp_path / "app.sqlite")
    backend.app.config.update(TESTING=True)
    with backend.app.test_client() as client:
        yield client


@pytest.fixture(autouse=True)
def block_external_network(monkeypatch):
    """A missed mock must fail locally rather than call a market-data endpoint."""
    import socket

    def denied(*args, **kwargs):
        raise AssertionError("External network access is forbidden in isolated tests")

    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)


@pytest.fixture(autouse=True)
def fresh_update_job(monkeypatch):
    """Background-job assertions must not depend on another test's job state."""
    import backend.main as backend

    monkeypatch.setattr(backend, "_update_job", {
        "id": None, "state": "idle", "progress": 0, "stage": "", "message": "",
        "started_at": None, "finished_at": None, "trade_date": None,
    })


# ---------------------------------------------------------------- 扩展合成库（G 集成收口）
# 既有 synthetic_lake（6 股 × 30 天）一个字节都不改：既有 221 个断言依赖其精确结构。
# 下面两个独立合成库只服务跨切面集成测试（tests/test_integration_fixes.py）：
#   * extended_lake：12 只分析池股票 + 1 只被排除的 BSE 股票，覆盖官方涨跌停名单、
#     ST 5% 档 / 普通 10% 档、并列收益与并列行业名次、部分日 + 次日权重污染、两融交易所覆盖；
#   * scaled_lake：24 个交易日 × 3000 行的"市场级"历史 + 1 个 100 行部分日，用于 gate15
#     发布阻断与 data_quality 披露链路（gate15 只在局部中位数 >= 2000 行时判定部分日）。
def _weekdays(start: date, count: int) -> list[date]:
    days: list[date] = []
    current = start
    while len(days) < count:
        if current.weekday() < 5:
            days.append(current)
        current += timedelta(days=1)
    return days


_DAILY_COLUMNS = (
    "ts_code, trade_date, open, high, low, close, pre_close, pct_chg, vol, amount, "
    "adj_factor, adj_close, turnover_rate, turnover_rate_f, volume_ratio, pe_ttm, pb, "
    "total_mv, circ_mv, up_limit, down_limit"
)


def _build_marts(con) -> None:
    """与 synthetic_lake 相同的 mart 构建路径（不写 status/marts 元数据）。"""
    from pipeline import build_marts
    from pipeline import settings

    bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix()
    for _, sql in build_marts.STEPS:
        con.execute(sql.format(bridge=bridge) if "{bridge}" in sql else sql)


def _daily_row(code: str, day: date, pct: float, *, up_limit: float, down_limit: float,
               circ_mv: float, amount: float = 11000.0) -> tuple:
    """等权 10 元基准的合法日线（OHLC 自洽、pct_chg 与 close/pre_close 精确一致）。"""
    pre_close = 10.0
    close = round(pre_close * (1 + pct / 100.0), 6)
    return (
        code, day, pre_close, max(pre_close, close), min(pre_close, close), close, pre_close,
        pct, 1000.0, amount, 1.0, close, 1.0, 2.0, 1.0, 20.0, 1.0, 200000.0, circ_mv,
        up_limit, down_limit,
    )


@dataclass(frozen=True)
class ExtendedLake:
    """合成库 2：BSE 排除 / ST 5% 档 / 10% 档 / 并列样本 / 部分日 / 官方名单 / 两融。"""

    path: Path
    days: tuple[date, ...]
    base_codes: tuple[str, ...]
    feat_codes: tuple[str, ...]
    bse_code: str
    st_code: str
    normal_limit_code: str
    tie_codes: tuple[str, str]
    sector_tie_codes: tuple[str, str]
    partial_day: date
    pollution_day: date
    st_limit_day: date
    normal_limit_day: date
    limit_event_day: date
    margin_two_exchange_day: date
    margin_single_exchange_day: date

    @property
    def latest(self) -> str:
        return self.days[-1].isoformat()


@pytest.fixture(scope="session")
def extended_lake(tmp_path_factory):
    """30 天 × 12 只分析池股票 + 1 只 BSE 股票，含官方名单/ST 档/并列/部分日/两融样本。"""
    import duckdb

    from pipeline.bootstrap_api import _init

    root = tmp_path_factory.mktemp("extended-source")
    lake = root / "extended.duckdb"
    days = tuple(_weekdays(date(2026, 5, 1), 30))
    base_codes = ("000001.SZ", "600000.SH", "300001.SZ", "301001.SZ", "688001.SH", "600001.SH")
    base_industries = ("银行", "银行", "种植业", "种植业", "化工原料", "化工原料")
    base_returns = (1.0, -1.0, 0.0, 2.0, -2.0, 0.5)
    bse_code, st_code, normal_code = "830001.BJ", "600200.SH", "600201.SH"
    tie_codes = ("600400.SH", "600401.SH")
    sector_tie_codes = ("600300.SH", "600301.SH")
    st_limit_day, normal_limit_day = days[-1], days[-2]
    partial_day = days[12]
    with duckdb.connect(str(lake)) as con:
        _init(con)
        con.executemany(
            "INSERT INTO core_trade_cal (cal_date, trade_date, pretrade_date, is_open) VALUES (?, ?, ?, 1)",
            [(d.strftime("%Y%m%d"), d, (days[i - 1] if i else d - timedelta(days=1)).strftime("%Y%m%d"))
             for i, d in enumerate(days)],
        )
        metas = [
            (code, code[:6], f"Synthetic {i}", base_industries[i])
            for i, code in enumerate(base_codes)
        ]
        metas += [
            (bse_code, "830001", "北证样例", "银行"),
            (st_code, "600200", "ST 合成", "煤炭开采"),
            (normal_code, "600201", "涨停样例", "石油开采"),
            (tie_codes[0], "600400", "并列样例A", "化工原料"),
            (tie_codes[1], "600401", "并列样例B", "化工原料"),
            (sector_tie_codes[0], "600300", "行业并列A", "保险"),
            (sector_tie_codes[1], "600301", "行业并列B", "银行"),
        ]
        con.executemany(
            "INSERT INTO core_stock_meta (ts_code, symbol, name, industry, market, exchange, "
            "list_status, list_date) VALUES (?, ?, ?, ?, NULL, NULL, 'L', '20000101')",
            [(code, symbol, name, industry) for code, symbol, name, industry in metas],
        )
        con.execute("UPDATE core_stock_meta SET market='北交所' WHERE ts_code=?", [bse_code])
        rows = []
        for i, code in enumerate(base_codes):
            for day in days:
                rows.append(_daily_row(code, day, base_returns[i], up_limit=12.0, down_limit=8.0,
                                       circ_mv=100000.0 + i * 10000.0))
        for day in days:
            rows.append(_daily_row(bse_code, day, 0.0, up_limit=13.0, down_limit=7.0,
                                   circ_mv=170000.0))
            rows.append(_daily_row(st_code, day, 5.0 if day == st_limit_day else 0.0,
                                   up_limit=10.5, down_limit=9.5, circ_mv=130000.0))
            rows.append(_daily_row(normal_code, day, 10.0 if day == normal_limit_day else 0.0,
                                   up_limit=11.0, down_limit=9.0, circ_mv=140000.0))
            for code in tie_codes:
                rows.append(_daily_row(code, day, 0.5, up_limit=12.0, down_limit=8.0,
                                       circ_mv=150000.0))
            rows.append(_daily_row(sector_tie_codes[0], day, 0.0, up_limit=12.0, down_limit=8.0,
                                   circ_mv=160000.0))
            rows.append(_daily_row(sector_tie_codes[1], day, 0.0, up_limit=12.0, down_limit=8.0,
                                   circ_mv=161000.0))
        con.executemany(
            f"INSERT INTO core_stock_day ({_DAILY_COLUMNS}) VALUES "
            f"({', '.join(['?'] * 21)})",
            rows,
        )
        con.executemany(
            "INSERT INTO core_index_day (ts_code, trade_date, open, high, low, close, pre_close, "
            "pct_chg, vol, amount) VALUES (?, ?, 100, 101, 100, 101, 100, 1, 1000, 10000)",
            [(code, day) for day in days for code in
             ("000300.SH", "000905.SH", "000852.SH", "000001.SH")],
        )
        margin_two, margin_one = days[2], days[3]
        con.executemany(
            "INSERT INTO core_margin_day VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(margin_two, "SSE", 100, 10, 1, 0, 0),
             (margin_two, "SZSE", 200, 20, 2, 0, 0),
             (margin_one, "SSE", 111, 11, 1, 0, 0),
             (margin_one, "BSE", 900, 90, 9, 0, 0)],
        )
        limit_events = [
            ("600001.SH", st_limit_day, "银行", "样例A", 10.1, 10.0, 1000, 1e6, 1e8, 2e8, 1.0,
             1e6, "093000", "145000", 0, "", 1.0, 1, 0, 0),
            ("600002.SH", st_limit_day, "银行", "样例B", 10.0, 9.9, 900, 9e5, 1e8, 2e8, 1.0,
             5e5, "093500", "145500", 3, "", 2.0, 1, 0, 1),
            ("600003.SH", st_limit_day, "银行", "样例C", 9.0, -10.0, 800, 8e5, 1e8, 2e8, 1.0,
             None, "094000", "145600", 0, "", 1.0, 0, 1, 0),
        ]
        con.executemany(
            "INSERT INTO core_limit_event (ts_code, trade_date, industry, name, close, pct_chg, "
            "amount, limit_amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, "
            "last_time, open_times, up_stat, limit_times, is_up, is_down, is_broken) VALUES "
            f"({', '.join(['?'] * 20)})",
            limit_events,
        )
        # 部分日：只保留 2 只分析池股票 + 1 只 BSE 行（BSE 不进分析池，n_valid=2）。
        # 这两只同属"基础化工"，不改变银行/非银金融的历史窗口，保证并列名次样本干净。
        con.execute(
            "DELETE FROM core_stock_day WHERE trade_date=? AND ts_code NOT IN (?, ?, ?)",
            [partial_day, bse_code, *tie_codes],
        )
        _build_marts(con)
    feat_codes = base_codes + (st_code, normal_code, *tie_codes, *sector_tie_codes)
    return ExtendedLake(
        path=lake,
        days=days,
        base_codes=base_codes,
        feat_codes=feat_codes,
        bse_code=bse_code,
        st_code=st_code,
        normal_limit_code=normal_code,
        tie_codes=tie_codes,
        sector_tie_codes=sector_tie_codes,
        partial_day=partial_day,
        pollution_day=days[13],
        st_limit_day=st_limit_day,
        normal_limit_day=normal_limit_day,
        limit_event_day=st_limit_day,
        margin_two_exchange_day=margin_two,
        margin_single_exchange_day=margin_one,
    )


@pytest.fixture()
def mutable_extended_lake(extended_lake, tmp_path, monkeypatch):
    """每个测试一份可写的 extended_lake 副本（防止 SQL 改动串测试）。"""
    from pipeline import settings

    lake = tmp_path / "extended.duckdb"
    shutil.copyfile(extended_lake.path, lake)
    (tmp_path / "meta").mkdir(exist_ok=True)
    monkeypatch.setattr(settings, "DATA", tmp_path)
    monkeypatch.setattr(settings, "LAKE", lake)
    monkeypatch.setattr(settings, "META", tmp_path / "meta")
    return lake


@pytest.fixture()
def extended_client(mutable_extended_lake, tmp_path, monkeypatch):
    """Flask test_client，LAKE 指向每测试复制的 extended_lake。"""
    import backend.main as backend
    from pipeline import settings

    monkeypatch.setattr(backend, "LAKE", mutable_extended_lake)
    monkeypatch.setattr(backend, "META", settings.META)
    monkeypatch.setattr(backend, "DB", tmp_path / "app.sqlite")
    backend.app.config.update(TESTING=True)
    with backend.app.test_client() as client:
        yield client


@dataclass(frozen=True)
class ScaledLake:
    """合成库 3：市场级历史 + 一个部分日 + 下一个（权重污染）交易日。"""

    path: Path
    days: tuple[date, ...]
    full_rows: int
    partial_day: date
    partial_rows: int
    pollution_day: date


@pytest.fixture(scope="session")
def scaled_lake(tmp_path_factory):
    """24 交易日 × 3000 行 + 1 个 100 行部分日；gate15 需局部中位数 >= 2000 行。"""
    import duckdb
    import numpy as np
    import pandas as pd

    from pipeline.bootstrap_api import _init

    root = tmp_path_factory.mktemp("scaled-source")
    lake = root / "scaled.duckdb"
    days = _weekdays(date(2026, 1, 5), 24)
    partial_idx = 17
    n_stocks = 3000
    industries = ("银行", "化工原料", "种植业", "元器件", "软件服务", "水泥", "保险", "煤炭开采")
    with duckdb.connect(str(lake)) as con:
        _init(con)
        con.executemany(
            "INSERT INTO core_trade_cal (cal_date, trade_date, pretrade_date, is_open) VALUES (?, ?, ?, 1)",
            [(d.strftime("%Y%m%d"), d, (days[i - 1] if i else d - timedelta(days=1)).strftime("%Y%m%d"))
             for i, d in enumerate(days)],
        )
        codes = [f"{300000 + i:06d}.SZ" for i in range(n_stocks)]
        meta = pd.DataFrame({
            "ts_code": codes,
            "symbol": [code[:6] for code in codes],
            "name": [f"Scaled {i}" for i in range(n_stocks)],
            "industry": [industries[i % len(industries)] for i in range(n_stocks)],
            "market": "主板",
            "exchange": "SZSE",
            "list_status": "L",
            "list_date": "20000101",
        })
        con.register("scaled_meta", meta)
        con.execute(
            "INSERT INTO core_stock_meta (ts_code, symbol, name, industry, market, exchange, "
            "list_status, list_date) SELECT ts_code, symbol, name, industry, market, exchange, "
            "list_status, list_date FROM scaled_meta")
        con.unregister("scaled_meta")
        day_index = np.repeat(np.arange(len(days)), n_stocks)
        code_index = np.tile(np.arange(n_stocks), len(days))
        pct = ((((code_index * 7 + day_index * 13) % 1201) - 600) / 10000.0) * 100.0
        close = 10.0 * (1 + pct / 100.0)
        daily = pd.DataFrame({
            "ts_code": np.tile(np.array(codes), len(days)),
            "trade_date": [days[i] for i in day_index],
            "open": 10.0,
            "high": np.maximum(10.0, close),
            "low": np.minimum(10.0, close),
            "close": close,
            "pre_close": 10.0,
            "pct_chg": pct,
            "vol": 1000.0,
            "amount": 10000.0,
            "adj_factor": 1.0,
            "adj_close": close,
            "turnover_rate": 1.0,
            "turnover_rate_f": 2.0,
            "volume_ratio": 1.0,
            "pe_ttm": 20.0,
            "pb": 1.0,
            "total_mv": 200000.0,
            "circ_mv": 100000.0 + (code_index % 100) * 1000.0,
            "up_limit": 12.0,
            "down_limit": 8.0,
            "day_index": day_index,
            "code_index": code_index,
        })
        con.register("scaled_daily", daily)
        con.execute(
            f"INSERT INTO core_stock_day ({_DAILY_COLUMNS}) SELECT {_DAILY_COLUMNS} "
            "FROM scaled_daily WHERE day_index <> ?", [partial_idx])
        con.execute(
            f"INSERT INTO core_stock_day ({_DAILY_COLUMNS}) SELECT {_DAILY_COLUMNS} "
            "FROM scaled_daily WHERE day_index = ? AND code_index < 100", [partial_idx])
        con.unregister("scaled_daily")
        con.executemany(
            "INSERT INTO core_index_day (ts_code, trade_date, open, high, low, close, pre_close, "
            "pct_chg, vol, amount) VALUES (?, ?, 100, 101, 100, 101, 100, 1, 1000, 10000)",
            [(code, day) for day in days for code in
             ("000300.SH", "000905.SH", "000852.SH", "000001.SH")],
        )
        _build_marts(con)
    return ScaledLake(lake, tuple(days), n_stocks, days[partial_idx], 100, days[partial_idx + 1])
