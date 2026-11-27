"""API 加固回归：Host/安全头/404/排序/双路径字段/watchlist/qfq/边界。

对应审核发现：W4-01/02/03/04/05/06/08、W14-01/12/17、W5-03/04、W7-03、W9-22。
全部在合成库 + test_client 上运行，不联网、不写生产 data/。
"""
from __future__ import annotations

import json
import sqlite3

import duckdb
import pytest

from backend import main as api
from pipeline import settings

WATCH_HEADERS = {"X-Requested-With": "ashare-radar"}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


# ---------------------------------------------------------------- Host / 安全头
@pytest.mark.parametrize("base_url", ["http://malicious.example", "http://evil.test:8123"])
def test_get_requests_reject_untrusted_host(db_client, base_url):
    """W4-01 / W14-01：GET /api/* 也必须校验 Host（DNS rebinding 防线）。"""
    for url in ("/api/meta", "/api/market/series", "/api/stocks?date=2026-05-22"):
        response = db_client.get(url, base_url=base_url)
        assert response.status_code == 403
        assert response.is_json
        assert response.get_json()["detail"] == "untrusted host"


@pytest.mark.parametrize("base_url", ["http://127.0.0.1/", "http://localhost/", "http://[::1]/"])
def test_get_requests_accept_trusted_hosts(db_client, base_url):
    assert db_client.get("/api/meta", base_url=base_url).status_code == 200


def test_trusted_hosts_env_override(db_client, monkeypatch):
    monkeypatch.setenv(api.TRUSTED_HOSTS_ENV, "radar.local, 10.0.0.2")
    assert db_client.get("/api/meta", base_url="http://radar.local").status_code == 200
    assert db_client.get("/api/meta", base_url="http://10.0.0.2:8000").status_code == 200
    assert db_client.get("/api/meta", base_url="http://localhost").status_code == 403


@pytest.mark.parametrize("method,url,headers,payload", [
    ("post", "/api/watchlist", {}, {"ts_code": "000001.SZ"}),
    ("patch", "/api/watchlist/000001.SZ", {}, {"shares": 1}),
    ("delete", "/api/watchlist/000001.SZ", {}, None),
    ("post", "/api/update", {"X-Ashare-Radar": "1"}, None),
])
def test_all_write_methods_reject_untrusted_host(db_client, method, url, headers, payload):
    response = getattr(db_client, method)(
        url, base_url="http://malicious.example", headers=headers, json=payload
    )
    assert response.status_code == 403


def test_watchlist_mutations_reject_cross_site_origin(db_client):
    response = db_client.post(
        "/api/watchlist", json={"ts_code": "000001.SZ"}, headers={"Origin": "https://evil.example"}
    )
    assert response.status_code == 403
    response = db_client.delete(
        "/api/watchlist/000001.SZ", headers={"Origin": "null"}
    )
    assert response.status_code == 403


def test_api_responses_carry_security_headers(db_client):
    response = db_client.get("/api/meta")
    for key, value in SECURITY_HEADERS.items():
        assert response.headers.get(key) == value
    assert "Permissions-Policy" in response.headers
    # 错误响应同样补头（含 404 JSON）
    missing = db_client.get("/api/does-not-exist")
    assert missing.status_code == 404
    for key, value in SECURITY_HEADERS.items():
        assert missing.headers.get(key) == value


def test_unknown_api_routes_return_json_404(db_client):
    """W4-05 / W14-12：未匹配 /api/* 不再落入 SPA 兜底返回 200 text/html。"""
    for url in ("/api/nonexistent", "/api/update", "/api/", "/api/lake.duckdb"):
        response = db_client.get(url)
        assert response.status_code == 404, url
        assert response.is_json
        assert "error" in response.get_json()
    # 不存在的路由不应先被 ?date= 参数校验成 400（旧行为）
    assert db_client.get("/api/nonexistent?date=bad").status_code == 404
    assert db_client.post("/api/nonexistent", json={}).status_code == 404


# ---------------------------------------------------------------- watchlist 隐私面
def test_watchlist_get_requires_custom_header(db_client):
    """W14-01：持仓读接口需要自定义头，普通跨源 <img>/fetch 无法静默读取。"""
    response = db_client.get("/api/watchlist")
    assert response.status_code == 403
    ok = db_client.get("/api/watchlist", headers=WATCH_HEADERS)
    assert ok.status_code == 200
    assert ok.get_json() == []
    assert ok.headers["Cache-Control"] == "no-store"


def test_watchlist_get_does_not_create_sqlite(db_client):
    """W4-06：GET 不得创建 data/app.sqlite 或建表（读请求零写副作用）。"""
    assert not api.DB.exists()
    response = db_client.get("/api/watchlist", headers=WATCH_HEADERS)
    assert response.status_code == 200
    assert response.get_json() == []
    assert not api.DB.exists()


def test_watchlist_write_creates_schema_and_roundtrips(db_client):
    assert db_client.post("/api/watchlist", json={"ts_code": "000001.SZ", "shares": 100, "cost": 10}).status_code == 200
    assert api.DB.exists()
    rows = db_client.get("/api/watchlist", headers=WATCH_HEADERS).get_json()
    assert rows[0]["ts_code"] == "000001.SZ"
    assert rows[0]["shares"] == 100
    assert rows[0]["cost"] == 10


def test_watchlist_unknown_json_fields_are_400(db_client):
    """W4-06：未知 JSON 键必须 400，不能静默忽略。"""
    assert db_client.post("/api/watchlist", json={"ts_code": "000001.SZ", "evil": 1}).status_code == 400
    assert db_client.post("/api/watchlist", json={"ts_code": "000001.SZ"}).status_code == 200
    assert db_client.patch("/api/watchlist/000001.SZ", json={"ts_code": "000001.SZ"}).status_code == 400
    assert db_client.patch("/api/watchlist/000001.SZ", json={"shares": 10}).status_code == 200


def test_watchlist_quantities_have_upper_bound(db_client):
    """W4-06：数量上限，拒绝 1e308 这类会溢出前端市值/盈亏的输入。"""
    assert db_client.post(
        "/api/watchlist", json={"ts_code": "000001.SZ", "shares": 1e308, "cost": 1e308}
    ).status_code == 400
    assert db_client.post(
        "/api/watchlist", json={"ts_code": "000001.SZ", "shares": api.MAX_WATCH_SHARES + 1}
    ).status_code == 400


def test_watchlist_added_at_ties_are_ordered_by_code(db_client):
    for code in ("600000.SH", "000001.SZ"):
        assert db_client.post("/api/watchlist", json={"ts_code": code}).status_code == 200
    with sqlite3.connect(api.DB) as con:
        con.execute("UPDATE watchlist SET added_at='2026-01-01T00:00:00'")
    codes = [row["ts_code"] for row in db_client.get("/api/watchlist", headers=WATCH_HEADERS).get_json()]
    assert codes == ["000001.SZ", "600000.SH"]


def test_watchlist_missing_quote_fallback_has_static_payload_fields(db_client):
    """W4-04：缺报价兜底行补齐静态 payload 的 market/sw_l1 字段。"""
    assert db_client.post("/api/watchlist", json={"ts_code": "000002.SZ"}).status_code == 200
    rows = db_client.get("/api/watchlist", headers=WATCH_HEADERS).get_json()
    assert rows[0]["quote_missing"] is True
    assert {"market", "sw_l1"} <= set(rows[0])


# ---------------------------------------------------------------- meta 数据源语义
def test_meta_filters_unavailable_sources(db_client):
    """W7-03 / W9-22：meta.source 不再拼 unavailable，不可用数据集单列。"""
    status_file = api.META / "status.json"
    status_file.write_text(
        json.dumps({
            "status": "ok",
            "sources": {
                "daily": "tushare",
                "index": "tushare",
                "limit_list_d": "unavailable",
                "margin": "unavailable",
            },
        }),
        encoding="utf-8",
    )
    data = db_client.get("/api/meta").get_json()
    assert data["source"] == "tushare"
    assert data["sources"] == {"daily": "tushare", "index": "tushare"}
    assert data["unavailable_datasets"] == ["limit_list_d", "margin"]
    # 与静态 payload 同结构的数据质量摘要，供 Briefing 披露 partial 日
    assert data["data_quality"]["partial_days"] == []
    assert data["data_quality"]["n_partial_days"] == 0
    assert data["data_quality"]["history_gate"]["pass"] is True


def test_meta_data_quality_lists_partial_days(db_client, mutable_lake, synthetic_lake):
    """W11-01/W3-01 披露链：mart_market_day.data_quality='partial' 进入 meta。"""
    with duckdb.connect(str(mutable_lake)) as con:
        columns = {
            row[0]
            for row in con.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name='mart_market_day'"
            ).fetchall()
        }
        if "data_quality" not in columns:
            con.execute("ALTER TABLE mart_market_day ADD COLUMN data_quality VARCHAR")
        con.execute(
            "UPDATE mart_market_day SET data_quality='partial' WHERE trade_date=?",
            [synthetic_lake.days[-2]],
        )
    data = db_client.get("/api/meta").get_json()
    assert data["data_quality"]["partial_days"] == [synthetic_lake.days[-2].isoformat()]
    assert data["data_quality"]["n_partial_days"] == 1
    assert data["data_quality"]["history_gate"]["pass"] is False


def test_meta_data_quality_includes_repair_report(db_client):
    repair = {
        "generated_at": "2026-11-27T10:00:00+08:00",
        "finished_at": "2026-11-27T10:30:00+08:00",
        "repaired": [{"trade_date": "2018-01-02"}, {"trade_date": "2018-01-03"}],
    }
    (api.META / "history_repair.json").write_text(json.dumps(repair), encoding="utf-8")
    data = db_client.get("/api/meta").get_json()
    assert data["data_quality"]["repaired_at"] == "2026-11-27T10:30:00+08:00"
    assert data["data_quality"]["repaired_days"] == 2


def test_meta_version_matches_pyproject(db_client):
    import tomllib

    expected = tomllib.loads((settings.ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    assert db_client.get("/api/meta").get_json()["version"] == expected


def test_reconcile_matches_static_payload_fields(db_client):
    """W9-05 / W4-04：reconcile 字段集与静态 payload 对齐（含 days）。"""
    (api.META / "reconcile.json").write_text(
        json.dumps({"generated_at": "2026-11-26T21:00:00+08:00", "days": ["2026-11-25"],
                    "stocks": 60, "pairs": 60, "mae_pp": 0.01}),
        encoding="utf-8",
    )
    data = db_client.get("/api/reconcile").get_json()
    assert data["days"] == ["2026-11-25"]
    assert data["pairs"] == 60
    assert data["generated_at"] == "2026-11-26T21:00:00+08:00"


# ---------------------------------------------------------------- 未知日期语义
def test_unknown_trade_dates_return_404_everywhere(db_client):
    """W4-05：单日查询未知日期统一 404（区间查询仍 200 空数组）。"""
    for url in (
        "/api/market/day/1999-01-01",
        "/api/distribution/1999-01-01",
        "/api/sectors?date=1999-01-01",
        "/api/stocks?date=1999-01-01",
    ):
        response = db_client.get(url)
        assert response.status_code == 404, url
        assert response.is_json


def test_single_date_endpoints_require_date(db_client):
    assert db_client.get("/api/sectors").status_code == 400
    assert db_client.get("/api/stocks").status_code == 400


def test_range_queries_keep_empty_list_semantics(db_client):
    response = db_client.get("/api/market/series?start=1999-01-01&end=1999-12-31")
    assert response.status_code == 200
    assert response.get_json() == []
    response = db_client.get("/api/sectors/series?start=1999-01-01&end=1999-12-31")
    assert response.status_code == 200
    assert response.get_json()["rows"] == []
    assert response.get_json()["limited"] is False


def test_missing_mart_table_returns_409_json(db_client, mutable_lake):
    """W4-05：旧库/半建库缺表 → 409 + 重建提示，而不是笼统 500。"""
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DROP TABLE mart_rotation_day")
    response = db_client.get("/api/rotation")
    assert response.status_code == 409
    assert response.get_json()["error"] == "mart missing"


# ---------------------------------------------------------------- 排序确定化
def test_stocks_default_limit_total_and_deterministic_order(db_client, synthetic_lake):
    """W4-02 / W4-03：默认 limit 与前端口径一致，返回 total，两次请求顺序一致。"""
    url = f"/api/stocks?date={synthetic_lake.latest}"
    first = db_client.get(url).get_json()
    second = db_client.get(url).get_json()
    assert first["limit"] == api.STOCKS_DEFAULT_LIMIT == 6000
    assert first["total"] == 6
    assert first["rows"] == second["rows"]
    rets = [row["ret"] for row in first["rows"]]
    assert rets == sorted(rets, reverse=True)
    limited = db_client.get(f"{url}&limit=2").get_json()
    assert limited["total"] == 6
    assert limited["rows"] == first["rows"][:2]


def test_stocks_ties_break_by_ts_code(db_client, mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute(
            "UPDATE feat_stock SET ret=0.5 WHERE ts_code IN ('000001.SZ','600000.SH') AND trade_date=?",
            [synthetic_lake.days[-1]],
        )
    rows = db_client.get(f"/api/stocks?date={synthetic_lake.latest}").get_json()["rows"]
    tied = [row["ts_code"] for row in rows if row["ret"] == 0.5]
    assert tied == ["000001.SZ", "600000.SH"]


def test_sector_ties_break_by_name(db_client, mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE mart_sector_day SET ew_ret=0.01 WHERE trade_date=?", [synthetic_lake.days[-1]])
    sectors = db_client.get(f"/api/sectors?date={synthetic_lake.latest}").get_json()
    names = [row["sw_l1"] for row in sectors]
    assert names == sorted(names)
    detail = db_client.get(f"/api/market/day/{synthetic_lake.latest}").get_json()
    assert [row["sw_l1"] for row in detail["sectors"]] == sorted(names)


# ---------------------------------------------------------------- 双路径字段
def test_market_endpoints_expose_new_mart_columns_when_present(db_client, mutable_lake, synthetic_lake):
    """mart_market_day 新列由 A 代理追加；存在则 API 自动透出（旧库不报错）。"""
    new_columns = {
        "weight_coverage": "DOUBLE",
        "n_valid_ratio": "DOUBLE",
        "data_quality": "VARCHAR",
        "margin_n_exchanges": "BIGINT",
        "n_extreme_ret": "BIGINT",
    }
    with duckdb.connect(str(mutable_lake)) as con:
        existing = {
            row[0]
            for row in con.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name='mart_market_day'"
            ).fetchall()
        }
        for name, kind in new_columns.items():
            if name not in existing:
                con.execute(f"ALTER TABLE mart_market_day ADD COLUMN {name} {kind}")
        con.execute(
            """UPDATE mart_market_day
               SET weight_coverage=1.0, n_valid_ratio=1.0, data_quality='ok',
                   margin_n_exchanges=2, n_extreme_ret=0
               WHERE trade_date=?""",
            [synthetic_lake.days[-1]],
        )
    series = db_client.get(f"/api/market/series?start={synthetic_lake.latest}&end={synthetic_lake.latest}").get_json()
    detail = db_client.get(f"/api/market/day/{synthetic_lake.latest}").get_json()
    for row in (series[0], detail):
        assert row["weight_coverage"] == 1.0
        assert row["n_valid_ratio"] == 1.0
        assert row["data_quality"] == "ok"
        assert row["margin_n_exchanges"] == 2
        assert row["n_extreme_ret"] == 0


def test_market_series_month_matches_static_payload_fields(db_client):
    """W4-04：月序列补 n_valid/hs300_n_days，与静态 market_monthly 字段集对齐。"""
    rows = db_client.get("/api/market/series?freq=month").get_json()
    assert rows
    assert {"trade_date", "n_valid", "hs300_n_days", "hs300_ret_cum"} <= set(rows[0])


def test_distribution_reports_binning_exclusions(db_client, mutable_lake, synthetic_lake):
    """W6-03 / W9-04：分布响应补 n_total/n_binned/n_excluded_lt/n_excluded_gt。"""
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute(
            "UPDATE feat_stock SET ret=0.5 WHERE ts_code=? AND trade_date=?",
            [synthetic_lake.codes[0], synthetic_lake.days[-1]],
        )
    data = db_client.get(f"/api/distribution/{synthetic_lake.latest}").get_json()
    assert data["n_total"] == 6
    assert data["n_binned"] == 5
    assert data["n_excluded_gt"] == 1
    assert data["n_excluded_lt"] == 0
    assert sum(bin_["n"] for bin_ in data["bins"]) == data["n_binned"]
    assert data["stats"]["n"] == data["n_total"]


def test_quality_missing_returns_null(db_client):
    """W5-04：质量报告缺失返回 null，不再返回让前端误判的空对象。"""
    assert db_client.get("/api/quality").status_code == 200
    assert db_client.get("/api/quality").get_json() is None


def test_valuation_unknown_code_returns_null(db_client):
    """W5-03：未知代码返回 null，与静态 payload undefined→null 一致。"""
    response = db_client.get("/api/valuation/000002.SZ")
    assert response.status_code == 200
    assert response.get_json() is None


def test_valuation_known_code_returns_percentile(db_client, synthetic_lake):
    data = db_client.get(f"/api/valuation/{synthetic_lake.codes[0]}").get_json()
    assert data["pe"] == 20.0
    assert data["n"] > 0
    assert data["pct"] == 100


# ---------------------------------------------------------------- 个股 K 线前复权
def test_stock_series_is_qfq_adjusted(db_client, mutable_lake, synthetic_lake):
    """P1-6 / 计划 §3：OHLC 按窗口最后 adj_factor 归一，close_raw 保留原始价。"""
    code = synthetic_lake.codes[0]
    days = synthetic_lake.days
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("UPDATE feat_stock SET adj_factor=1.0")
        con.execute(
            "UPDATE feat_stock SET adj_factor=2.0 WHERE ts_code=? AND trade_date>=?",
            [code, days[-2]],
        )
        con.execute(
            "UPDATE feat_stock SET open=19, high=21, low=18, close=20 WHERE ts_code=? AND trade_date=?",
            [code, days[-1]],
        )
    payload = db_client.get(f"/api/stock/{code}?start={days[0]}&end={days[-1]}").get_json()
    assert payload["code"] == code
    assert payload["adjust"] == "qfq"
    series = payload["series"]
    assert series[-1]["trade_date"] == days[-1].isoformat()
    assert series[-1]["close"] == pytest.approx(20.0)
    assert series[-1]["close_raw"] == pytest.approx(20.0)
    assert series[-1]["adj_factor"] == pytest.approx(2.0)
    assert series[-1]["vol"] == 1000
    # 窗口内首日 adj_factor=1 → 10.1 * 1 / 2 = 5.05
    assert series[0]["close"] == pytest.approx(5.05)
    assert series[0]["close_raw"] == pytest.approx(10.1)
    assert series[0]["trade_date"] == days[0].isoformat()
    # 更短窗口（末日在除权前）归一基准=1.0 → 原始价
    short = db_client.get(f"/api/stock/{code}?start={days[0]}&end={days[-3]}").get_json()["series"]
    assert short[0]["close"] == pytest.approx(10.1)


def test_stock_series_unknown_code_is_404(db_client):
    response = db_client.get("/api/stock/000002.SZ")
    assert response.status_code == 404
    assert response.is_json
    assert db_client.get("/api/stock/not-a-code").status_code == 400


# ---------------------------------------------------------------- 行业序列有界
def test_sector_series_default_is_bounded(db_client, mutable_lake):
    """W4-09：无区间时最多 750 行并附 total；单边区间 400。"""
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute(
            """
            INSERT INTO mart_sector_day
            SELECT DATE '2020-01-01' + (i // 3)::INTEGER, 'T' || (i % 3)::VARCHAR,
                   1, 0, 1, 0.5, 0.01, 0.0, 0.01, 0.0, 0.0, 0.0, 0.0, 0.0, 0.01, 1000.0, 1.0, 0
            FROM range(900) t(i)
            """
        )
    data = db_client.get("/api/sectors/series").get_json()
    assert data["limited"] is True
    assert data["limit"] == api.SECTOR_SERIES_DEFAULT_LIMIT
    assert len(data["rows"]) == api.SECTOR_SERIES_DEFAULT_LIMIT
    assert data["total"] > api.SECTOR_SERIES_DEFAULT_LIMIT
    dates = [row["trade_date"] for row in data["rows"]]
    assert dates == sorted(dates)
    ranged = db_client.get("/api/sectors/series?start=2020-01-01&end=2020-01-02").get_json()
    assert ranged["limited"] is False
    assert ranged["total"] == len(ranged["rows"]) == 6
    assert db_client.get("/api/sectors/series?start=2020-01-01").status_code == 400
