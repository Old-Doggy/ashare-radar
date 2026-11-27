"""G 代理：跨切面集成回归（2026-11-27 修复收口）。

与 A 的 `test_pipeline_fixes.py`（数据层单点）和 B 的 `test_api_hardening.py`
（API 单点）互补，不重复其断言：这里让同一份合成库同时穿过
`core_* → build_marts → export_static.build_payload` 与 `Flask /api/*` 两条路径，
验证契约在集成态成立：

1. fixture 扩展本身（BSE 排除 / ST 5% 档 / 10% 档 / 并列收益 / 部分日）；
2. 注册制官方涨跌停名单（broken_rate / fd_amount / open_share）；
3. 部分日 + 次日权重污染 → data_quality=partial 且权重家族列 NULL；
4. 两融交易所完整性（缺任一交易所 → rzye NULL + margin_n_exchanges）；
5. gate15 历史完整性：部分日 block、完整历史 pass、<20 天 pass；
6. 导出/API 除 `meta.generated_at` 外完全可复现、并列排序确定；
7. 双路径字段集（market/monthly/sector_roll/sector_ranks/limit_quality）；
8. K 线前复权跨路径一致且除权日无假跳空；
9. 安全错误响应（403 JSON + 安全头，补充 B 未覆盖的 403 分支）；
10. meta.version / data_quality 在 API 与静态 payload 同源，前端版本展示读 meta.version。
"""
from __future__ import annotations

import json
import re
import shutil
import tomllib
from pathlib import Path

import duckdb
import pytest

from backend import main as api
from pipeline import build_marts, export_static, settings
from pipeline.quality_gates import history_completeness, run_gates

ROOT = Path(__file__).resolve().parents[1]
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}
NEW_MARKET_COLUMNS = {
    "weight_coverage", "n_valid_ratio", "data_quality", "margin_n_exchanges", "n_extreme_ret",
}
NULLED_ON_PARTIAL = {
    "cw_ret", "hhi", "max_weight", "top10_share", "top10_contrib_pct",
    "gain_share_top5pct", "ew_cw_gap", "limit_up_n", "limit_down_n",
    "max_streak", "streak_n", "first_board_n",
}


def read_payload(lake: Path) -> dict:
    with duckdb.connect(str(lake), read_only=True) as con:
        return export_static.build_payload(con)


def deterministic(payload: dict) -> dict:
    """除 `meta.generated_at`（时间戳）外的完整 payload。"""
    clone = json.loads(json.dumps(payload))
    clone.get("meta", {}).pop("generated_at", None)
    return clone


def gate(report: dict, gate_id: int) -> dict:
    return next(item for item in report["gates"] if item["id"] == gate_id)


def pyproject_version() -> str:
    with (ROOT / "pyproject.toml").open("rb") as stream:
        return str(tomllib.load(stream)["project"]["version"])


# ---------------------------------------------------------------- 1. fixture 自身
def test_extended_fixture_covers_bse_st_band_and_ties(extended_lake, synthetic_lake):
    """扩展库覆盖 ①BSE 排除 ②ST 5%/10% 档 ③并列收益/并列名次；既有库结构不变。"""
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        # ② BSE 行存在于 core_stock_day/v_stock，但被排除在 feat_stock/mart 之外
        n_bse = con.execute(
            "SELECT count(*) FROM core_stock_day WHERE ts_code=?", [extended_lake.bse_code]
        ).fetchone()[0]
        assert n_bse == len(extended_lake.days)
        assert con.execute(
            "SELECT exchange, market FROM v_stock WHERE ts_code=? AND trade_date=?",
            [extended_lake.bse_code, extended_lake.days[-1]],
        ).fetchone() == ("BSE", "北交所")
        assert con.execute(
            "SELECT count(*) FROM feat_stock WHERE ts_code=?", [extended_lake.bse_code]
        ).fetchone()[0] == 0
        n_valid = con.execute("SELECT n_valid FROM mart_market_day WHERE trade_date=?",
                              [extended_lake.days[-1]]).fetchone()[0]
        assert n_valid == len(extended_lake.feat_codes) == 12
        # ③ ST 行 5% 档、普通行 10% 档（档位由 up_limit/pre_close-1 派生，不由名称决定）
        bands = dict(con.execute(
            "SELECT ts_code, round(up_limit / nullif(pre_close, 0) - 1, 6) FROM core_stock_day "
            "WHERE trade_date=? AND ts_code IN (?, ?)",
            [extended_lake.days[-1], extended_lake.st_code, extended_lake.normal_limit_code],
        ).fetchall())
        assert bands[extended_lake.st_code] == pytest.approx(0.05)
        assert bands[extended_lake.normal_limit_code] == pytest.approx(0.10)
        # ④ 并列收益/并列权重样本（三只 ret=0.5%、prev_circ_mv=150000）
        tied = con.execute(
            "SELECT ret, prev_circ_mv FROM feat_stock WHERE trade_date=? AND ts_code IN (?, ?) "
            "ORDER BY ts_code",
            [extended_lake.days[-1], *extended_lake.tie_codes],
        ).fetchall()
        assert tied[0] == tied[1] == pytest.approx((0.005, 150000.0))
        # ⑤ 并列名次样本：银行 / 非银金融 两行业相同 ew_ret（0）→ mart_sector_rank 同名次
        ranks = con.execute(
            "SELECT sw_l1, rank20 FROM mart_sector_rank WHERE trade_date=? AND sw_l1 IN ('银行','非银金融')",
            [extended_lake.days[-1]],
        ).fetchall()
        assert len(ranks) == 2 and ranks[0][1] == ranks[1][1]
        # 部分日：2 行（分析池），显著低于 12 行
        partial_rows = con.execute("SELECT n_valid FROM mart_market_day WHERE trade_date=?",
                                   [extended_lake.partial_day]).fetchone()[0]
        assert partial_rows == 2
    # 既有 synthetic_lake 完全未被改写
    with duckdb.connect(str(synthetic_lake.path), read_only=True) as con:
        assert con.execute("SELECT n_valid FROM mart_market_day ORDER BY trade_date DESC LIMIT 1"
                           ).fetchone()[0] == 6


# ---------------------------------------------------------------- 2. 官方涨跌停名单
def test_official_limit_list_feeds_broken_rate_and_fd_amount(extended_lake):
    day = extended_lake.limit_event_day
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        market = con.execute(
            "SELECT limit_up_list_n, limit_down_list_n, broken_n, broken_rate, limit_fd_amount "
            "FROM mart_market_day WHERE trade_date=?", [day]).fetchone()
        limit_quality = con.execute(
            "SELECT n_limit_up, open_share, avg_open_times FROM mart_limit_quality "
            "WHERE trade_date=?", [day]).fetchone()
        report = run_gates(con, day.strftime("%Y%m%d"),
                           extended_lake.days[-2].strftime("%Y%m%d"), persist=False)
    limit_up_list_n, limit_down_list_n, broken_n, broken_rate, limit_fd_amount = market
    assert (limit_up_list_n, limit_down_list_n, broken_n) == (2, 1, 1)
    assert broken_rate == pytest.approx(1 / 3)          # 官方名单口径 broken/(up+broken)
    assert limit_fd_amount == pytest.approx(1.5e6)      # 官方名单封单额（clean）
    assert limit_quality[0] == 2
    assert limit_quality[1] == pytest.approx(0.5)       # open_times>0 的涨停占比
    assert limit_quality[2] == pytest.approx(1.5)       # 平均开板次数
    assert gate(report, 17)["pass"] is True             # fd_amount 量纲正常 → 不告警


def test_st_five_percent_and_ten_percent_band_counts(extended_lake):
    """契约：limit_up_non5pct_n 由 >=6% 档派生，limit_up_5pct_n = limit_up_n - non5pct。"""
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        st_row = con.execute(
            "SELECT limit_up_n, limit_up_non5pct_n, limit_up_5pct_n FROM mart_market_day "
            "WHERE trade_date=?", [extended_lake.st_limit_day]).fetchone()
        normal_row = con.execute(
            "SELECT limit_up_n, limit_up_non5pct_n, limit_up_5pct_n FROM mart_market_day "
            "WHERE trade_date=?", [extended_lake.normal_limit_day]).fetchone()
    assert st_row == (1, 0, 1)          # ST 5% 档涨停：全部计入 5% 档
    assert normal_row == (1, 1, 0)      # 普通 10% 档涨停：全部计入非 5% 档


# ---------------------------------------------------------------- 3. 权重覆盖/data_quality
def test_partial_day_nulls_weight_family_and_pollutes_next_day(extended_lake):
    days = extended_lake.days
    break_day, polluted_day, recovered_day = extended_lake.partial_day, extended_lake.pollution_day, days[14]
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        fields = ("trade_date, n_valid, data_quality, weight_coverage, ew_ret, breadth, "
                  "cw_ret, hhi, max_weight, top10_share")
        rows = {
            row[0]: row
            for row in con.execute(
                f"SELECT {fields} FROM mart_market_day WHERE trade_date IN (?, ?, ?) ORDER BY trade_date",
                [break_day, polluted_day, recovered_day]).fetchall()
        }
    partial = rows[break_day]
    assert partial[1] == 2 and partial[2] == "partial"
    assert partial[4] is not None and partial[5] is not None    # ew_ret/breadth 保留
    assert all(value is None for value in partial[6:])          # 权重家族 NULL（不重新归一）
    polluted = rows[polluted_day]
    assert polluted[1] == 12 and polluted[2] == "partial"       # 次日样本完整但前日权重缺失
    assert polluted[3] == pytest.approx(2 / 12)                 # weight_coverage 反映污染
    assert polluted[6] is None and polluted[7] is None          # cw/hhi 不得用 1/4 样本归一
    recovered = rows[recovered_day]
    assert recovered[2] == "ok" and recovered[3] == pytest.approx(1.0)
    assert recovered[6] is not None and recovered[7] is not None
    # 契约：partial 日对上述列一律 NULL；完整日不得 NULL
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        columns = ", ".join(sorted(NULLED_ON_PARTIAL))
        values = con.execute(
            f"SELECT {columns} FROM mart_market_day WHERE trade_date=?", [break_day]).fetchone()
    assert all(value is None for value in values)


# ---------------------------------------------------------------- 4. 两融交易所完整性
def test_margin_requires_both_exchanges_and_excludes_bse(extended_lake):
    with duckdb.connect(str(extended_lake.path), read_only=True) as con:
        two = con.execute(
            "SELECT rzye, rzmre, margin_n_exchanges FROM mart_market_day WHERE trade_date=?",
            [extended_lake.margin_two_exchange_day]).fetchone()
        one = con.execute(
            "SELECT rzye, rzmre, margin_n_exchanges FROM mart_market_day WHERE trade_date=?",
            [extended_lake.margin_single_exchange_day]).fetchone()
    assert two == (300.0, 30.0, 2)          # 只汇总 SSE+SZSE
    assert one[0] is None and one[1] is None  # 缺 SZSE → 不输出部分和
    assert one[2] == 1                       # 仅记录实际覆盖交易所数（BSE 不计）


# ---------------------------------------------------------------- 5. gate15 历史完整性
def test_gate15_blocks_publish_when_history_contains_partial_day(scaled_lake):
    with duckdb.connect(str(scaled_lake.path), read_only=True) as con:
        hist = history_completeness(con)
        assert hist["pass"] is False
        assert hist["value"]["count"] == 1
        assert hist["value"]["days"][0]["date"] == scaled_lake.partial_day.isoformat()
        assert hist["value"]["days"][0]["rows"] == scaled_lake.partial_rows
        report = run_gates(con, scaled_lake.days[-1].strftime("%Y%m%d"),
                           scaled_lake.days[-2].strftime("%Y%m%d"), persist=False)
    assert 15 in report["blocking"]
    assert gate(report, 15)["level"] == "block" and gate(report, 15)["pass"] is False


def test_gate15_passes_on_complete_history_and_short_history(scaled_lake, tmp_path):
    with duckdb.connect(str(scaled_lake.path), read_only=True) as con:
        short = history_completeness(con, day=scaled_lake.days[10])
    assert short["pass"] is True and short["value"]["insufficient_history"] is True

    complete = tmp_path / "complete.duckdb"
    shutil.copyfile(scaled_lake.path, complete)
    fill_source = scaled_lake.days[16]  # 部分日的前一个完整交易日
    with duckdb.connect(str(complete)) as con:
        con.execute("DELETE FROM core_stock_day WHERE trade_date=?", [scaled_lake.partial_day])
        con.execute(
            "INSERT INTO core_stock_day SELECT * REPLACE (? AS trade_date) FROM core_stock_day "
            "WHERE trade_date=?", [scaled_lake.partial_day, fill_source])
        hist = history_completeness(con)
        report = run_gates(con, scaled_lake.days[-1].strftime("%Y%m%d"),
                           scaled_lake.days[-2].strftime("%Y%m%d"), persist=False)
    assert hist["pass"] is True and hist["value"]["count"] == 0
    assert 15 not in report["blocking"]


def test_scaled_payload_data_quality_chain_matches_api(scaled_lake, tmp_path, monkeypatch):
    """市场级库：payload meta.data_quality（历史完整性披露）与 API 同源且反映部分日。"""
    monkeypatch.setattr(api, "LAKE", scaled_lake.path)
    monkeypatch.setattr(api, "META", tmp_path / "meta")
    monkeypatch.setattr(api, "DB", tmp_path / "app.sqlite")
    (tmp_path / "meta").mkdir(exist_ok=True)
    payload = read_payload(scaled_lake.path)
    quality = payload["meta"]["data_quality"]
    partial = scaled_lake.partial_day.isoformat()
    polluted = scaled_lake.pollution_day.isoformat()
    recovered = scaled_lake.days[scaled_lake.days.index(scaled_lake.pollution_day) + 1].isoformat()
    assert quality["partial_days"] == [partial, polluted]      # 部分日 + 次日权重污染
    assert quality["n_partial_days"] == 2
    assert quality["history_gate"]["pass"] is False
    assert quality["history_gate"]["n_days"] == len(scaled_lake.days)
    market = {row["trade_date"]: row for row in payload["market"]}
    assert market[partial]["data_quality"] == "partial"
    assert market[partial]["cw_ret"] is None and market[partial]["hhi"] is None
    assert market[polluted]["data_quality"] == "partial"
    assert market[polluted]["weight_coverage"] < 0.95
    assert market[polluted]["cw_ret"] is None
    assert market[recovered]["data_quality"] == "ok" and market[recovered]["cw_ret"] is not None
    with api.app.test_client() as client:
        series = client.get(f"/api/market/series?start={partial}&end={recovered}").get_json()
        by_day = {row["trade_date"]: row for row in series}
        for date in (partial, polluted, recovered):
            assert set(by_day[date]) == set(market[date])
            assert by_day[date]["data_quality"] == market[date]["data_quality"]
            if market[date]["cw_ret"] is None:
                assert by_day[date]["cw_ret"] is None
            else:
                # 静态 payload 导出时四舍五入到 6 位小数（export_static._round），API 不取整。
                assert by_day[date]["cw_ret"] == pytest.approx(market[date]["cw_ret"], abs=1e-6)
        meta = client.get("/api/meta").get_json()
    assert meta["data_quality"]["partial_days"] == quality["partial_days"]
    assert meta["data_quality"]["history_gate"]["pass"] is False


# ---------------------------------------------------------------- 6. 导出可复现/排序确定
def test_export_payload_is_deterministic_except_generated_at(extended_lake):
    first = read_payload(extended_lake.path)
    second = read_payload(extended_lake.path)
    assert deterministic(first) == deterministic(second)
    expected = ["600200.SH", "301001.SZ", "000001.SZ",
                "600001.SH", "600400.SH", "600401.SH",
                "300001.SZ", "600201.SH", "600300.SH", "600301.SH",
                "600000.SH", "688001.SH"]
    assert [row["ts_code"] for row in first["stocks"]] == expected      # ret DESC, ts_code
    contrib = first["contrib"][extended_lake.latest]
    tied = [row["ts_code"] for row in contrib if row["ret"] == 0.005]
    assert tied == sorted(tied)                                          # 同贡献按 ts_code
    assert [row["ts_code"] for row in first["watch_pool"]] == sorted(
        row["ts_code"] for row in first["watch_pool"])
    assert first["sectors"] and first["contrib"] and first["sector_roll"]
    assert first["meta"]["generated_at"]


def test_api_stocks_two_requests_identical_and_tie_break(extended_client, extended_lake):
    url = f"/api/stocks?date={extended_lake.latest}"
    first = extended_client.get(url).get_json()
    second = extended_client.get(url).get_json()
    assert first == second
    assert first["total"] == len(extended_lake.feat_codes) == 12
    codes = [row["ts_code"] for row in first["rows"]]
    assert codes[:6] == ["600200.SH", "301001.SZ", "000001.SZ", "600001.SH", "600400.SH", "600401.SH"]
    assert [row["ts_code"] for row in first["rows"] if row["ret"] == 0.005] == sorted(
        row["ts_code"] for row in first["rows"] if row["ret"] == 0.005)


# ---------------------------------------------------------------- 7. 双路径字段集
def test_static_payload_and_api_share_field_contract(extended_client, extended_lake):
    payload = read_payload(extended_lake.path)
    latest = extended_lake.latest
    first_day = extended_lake.days[0].isoformat()
    assert set(payload["market"][0]) >= NEW_MARKET_COLUMNS

    series = extended_client.get(f"/api/market/series?start={first_day}&end={latest}").get_json()
    assert len(series) == len(payload["market"]) == len(extended_lake.days)
    assert set(series[0]) == set(payload["market"][0])      # SELECT * 双路径同列集
    assert set(series[-1]) >= NEW_MARKET_COLUMNS

    detail = extended_client.get(f"/api/market/day/{latest}").get_json()
    assert set(payload["market"][-1]) <= set(detail)
    assert {"contributors", "sectors"} <= set(detail)

    monthly_api = extended_client.get("/api/market/series?freq=month").get_json()
    assert monthly_api and set(monthly_api[0]) == set(payload["market_monthly"][0])

    ranks_api = extended_client.get("/api/sector-ranks").get_json()
    assert ranks_api and set(ranks_api[0]) == set(payload["sector_ranks"][0]) == {
        "trade_date", "sw_l1", "rank20", "ret20"}

    roll_api = extended_client.get("/api/sectors/roll").get_json()
    roll_payload = payload["sector_roll"]
    assert roll_api and roll_payload
    # v0.4.3：API 与静态导出共用 SQL_SECTOR_ROLL_ROWS（含 n_sectors），字段集必须一致。
    assert set(roll_api[0]) == set(roll_payload[0])
    assert "n_sectors" in roll_api[0]

    quality_api = extended_client.get("/api/limit-quality").get_json()
    assert quality_api and set(quality_api[0]) == set(payload["limit_quality"][0])


# ---------------------------------------------------------------- 8. K 线前复权（双路径）
def test_kline_qfq_continuity_across_export_and_api(db_client, mutable_lake, synthetic_lake):
    code = synthetic_lake.codes[0]
    days = synthetic_lake.days
    ex_day, pre_day = days[-1], days[-2]
    with duckdb.connect(str(mutable_lake)) as con:
        # 构造除权日：原始价格减半、adj_factor 翻倍；qfq 后应无跳空。
        con.execute("UPDATE core_stock_day SET adj_factor=1.0, adj_close=close WHERE ts_code=?", [code])
        con.execute(
            "UPDATE core_stock_day SET open=5.05, high=5.05, low=5.05, close=5.05, pre_close=10.1, "
            "pct_chg=-50.0, adj_factor=2.0, adj_close=5.05 WHERE ts_code=? AND trade_date=?",
            [code, ex_day])
        con.execute(
            "UPDATE core_stock_day SET open=10.1, high=10.1, low=10.1, close=10.1, pre_close=10.1, "
            "pct_chg=0.0, adj_factor=1.0, adj_close=10.1 WHERE ts_code=? AND trade_date<date(?)",
            [code, ex_day])
        bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix()
        for sql in (build_marts.SQL_VIEW, build_marts.SQL_FEAT):
            con.execute(sql.format(bridge=bridge) if "{bridge}" in sql else sql)
        payload = export_static.build_payload(con)
    bars = payload["stock_series"][code]
    assert payload["coverage"]["stock_series"].startswith("top-60")
    assert "qfq adjusted" in payload["coverage"]["stock_series"]
    api_series = db_client.get(f"/api/stock/{code}").get_json()
    assert api_series["adjust"] == "qfq"
    assert len(api_series["series"]) == len(bars)
    for bar, point in zip(bars, api_series["series"]):
        assert bar[0] == point["trade_date"]
        assert bar[4] == pytest.approx(point["close"], abs=1e-6)
        assert bar[6] == point["adj_factor"]
    raw = [point["close_raw"] for point in api_series["series"]]
    adjusted = [point["close"] for point in api_series["series"]]
    # 未复权原始价在除权日出现 -50% 假跳空；前复权价连续。
    assert raw[-2] / raw[-1] > 1.9
    assert adjusted[-1] == pytest.approx(adjusted[-2], abs=1e-6)
    assert adjusted[-1] == pytest.approx(5.05, abs=1e-6)
    assert raw[-1] == pytest.approx(5.05, abs=1e-6)


# ---------------------------------------------------------------- 9. 安全错误响应
def test_untrusted_host_403_is_json_with_security_headers(db_client):
    """B 已覆盖 404 错误头；这里补 403（Host 拒绝）分支同样带安全头。"""
    response = db_client.get("/api/meta", base_url="http://attacker.example")
    assert response.status_code == 403
    assert response.is_json and response.get_json()["detail"] == "untrusted host"
    for key, value in SECURITY_HEADERS.items():
        assert response.headers.get(key) == value
    assert "Permissions-Policy" in response.headers
    assert db_client.get("/api/no-such-endpoint").status_code == 404


# ---------------------------------------------------------------- 10. meta/version 同源
def test_api_and_export_meta_version_data_quality_are_consistent(db_client, mutable_lake):
    import tomllib

    version = pyproject_version()
    status = {
        "status": "ok", "updated_at": "2026-11-27T18:00:00+08:00",
        "sources": {"daily": "tushare", "limit_list_d": "unavailable", "margin": "unavailable"},
        "warnings": [],
    }
    (api.META / "status.json").write_text(json.dumps(status), encoding="utf-8")
    api_meta = db_client.get("/api/meta").get_json()
    payload = read_payload(mutable_lake)
    static_meta = payload["meta"]
    assert api_meta["version"] == static_meta["version"] == version
    assert tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8")
                         )["project"]["version"] == version
    assert api_meta["data_quality"] == static_meta["data_quality"]
    assert static_meta["data_quality"]["history_gate"]["pass"] is True
    assert api_meta["source"] == static_meta["source"] == "tushare"
    assert api_meta["unavailable_datasets"] == static_meta["unavailable_datasets"] == [
        "limit_list_d", "margin"]
    assert api_meta["sources"] == static_meta["sources"] == {"daily": "tushare"}


def test_frontend_version_display_comes_from_meta_version():
    """Briefing/About/StatusBar 的版本串必须来自 meta.version，不得硬编码发布号。"""
    for relative in ("src/pages/Briefing.tsx", "src/pages/About.tsx", "src/components/StatusBar.tsx"):
        source = (ROOT / "frontend" / relative).read_text(encoding="utf-8")
        assert "versionLabel(meta?.version)" in source, f"{relative} 应从 meta.version 取版本"
        assert re.search(r"v\d+\.\d+\.\d+", source) is None, f"{relative} 不得硬编码版本串"
    fallback = (ROOT / "frontend/src/lib/format.ts").read_text(encoding="utf-8")
    assert "VERSION_FALLBACK" in fallback
