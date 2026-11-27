"""API 契约测试（Flask test client，不依赖网络）。"""
from __future__ import annotations

import pytest
import duckdb

from backend.main import app
from pipeline import settings

@pytest.fixture()
def client(db_client):
    return db_client


def test_meta(client):
    r = client.get("/api/meta")
    assert r.status_code == 200
    data = r.get_json()
    assert data["last_trade_date"] == "2026-06-11"
    assert data["n_stocks"] == 6


def test_market_series(client):
    r = client.get("/api/market/series")
    assert r.status_code == 200
    rows = r.get_json()
    assert len(rows) == 30
    assert "breadth" in rows[-1]


def test_market_day_detail(client):
    r = client.get("/api/market/day/2026-05-22")
    assert r.status_code == 200
    d = r.get_json()
    assert len(d["contributors"]) == 6
    assert len(d["sectors"]) == 3


def test_distribution(client):
    r = client.get("/api/distribution/2026-05-22")
    assert r.status_code == 200
    d = r.get_json()
    assert sum(b["n"] for b in d["bins"]) == 6
    assert d["stats"]["n"] == 6


def test_stocks(client):
    r = client.get("/api/stocks?date=2026-05-22&limit=50")
    assert r.status_code == 200
    payload = r.get_json()
    assert 0 < len(payload["rows"]) <= 50
    assert payload["total"] == 6
    assert "ret" in payload["rows"][0]


def test_sectors(client):
    r = client.get("/api/sectors?date=2026-05-22")
    assert r.status_code == 200
    assert len(r.get_json()) == 3


def test_watchlist_roundtrip(client):
    client.delete("/api/watchlist/000001.SZ")
    assert client.post("/api/watchlist", json={"ts_code": "000001.SZ"}).status_code == 200
    # GET 持仓是隐私面：必须带自定义头（见 tests/test_api_hardening.py）
    rows = client.get("/api/watchlist", headers={"X-Requested-With": "ashare-radar"}).get_json()
    assert any(r["ts_code"] == "000001.SZ" for r in rows)
    assert client.delete("/api/watchlist/000001.SZ").status_code == 200

def test_connection_released_after_request(monkeypatch, tmp_path):
    """请求结束后必须释放 DuckDB 锁，否则 17:35 的更新任务打不开库。"""
    import duckdb as dd

    import backend.main as m

    db = tmp_path / "tmp_lock_test.duckdb"
    db.unlink(missing_ok=True)
    dd.connect(str(db)).close()
    monkeypatch.setattr(m, "LAKE", db)

    with m.app.app_context():
        assert m.con() is m.con()
    # 上下文退出后连接应已关闭，此时可以拿到写连接
    dd.connect(str(db)).close()
    db.unlink(missing_ok=True)

def test_meta_includes_alert(client):
    """失败告警应透传到 /api/meta，成功更新后清除。"""
    import json

    p = settings.META / "alert.json"
    backup = p.read_text(encoding="utf-8") if p.exists() else None
    try:
        p.write_text(
            json.dumps({"time": "2026-11-11T16:50:00+08:00", "stage": "export", "message": "simulated"}),
            encoding="utf-8",
        )
        r = client.get("/api/meta")
        assert r.status_code == 200
        assert r.get_json()["alert"]["stage"] == "export"
    finally:
        if backup is None:
            p.unlink(missing_ok=True)
        else:
            p.write_text(backup, encoding="utf-8")


ROLL_FIELDS = {
    "trade_date", "sw_l1",
    "ret_r5", "ret_r10", "ret_r20",
    "br_r5", "br_r10", "br_r20",
    "rank_r5", "rank_r10", "rank_r20",
    "amount",
}


def test_sector_roll_returns_full_rows(client):
    """T3-1：GET /api/sectors/roll → 200，list，字段齐全。"""
    r = client.get("/api/sectors/roll")
    assert r.status_code == 200
    data = r.get_json()
    assert isinstance(data, list)
    assert len(data) == 30 * 3  # 合成库 30 交易日 × 3 行业
    assert ROLL_FIELDS <= set(data[0])
    assert data[0]["trade_date"] == "2026-05-01"
    assert isinstance(data[-1]["rank_r20"], int)
    # 成交额从 mart_sector_day JOIN 回来（单位：元），用于气泡面积
    assert isinstance(data[-1]["amount"], int)
    assert data[-1]["amount"] > 0


def test_sector_roll_rejects_bad_date(client):
    """T3-2：?start=bad → 400（与既有 _date_arg 校验一致）。"""
    r = client.get("/api/sectors/roll?start=bad")
    assert r.status_code == 400
    assert r.get_json()["detail"] == "date must be YYYY-MM-DD"


def test_sector_roll_missing_table_returns_rebuild_status(client, mutable_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DROP TABLE mart_sector_roll")
    response = client.get("/api/sectors/roll")
    assert response.status_code == 409
    assert response.get_json()["error"] == "sector_roll_missing"
    assert client.get("/api/sectors?date=2026-05-22").status_code == 200


def test_sector_roll_end_only_can_query_before_the_latest_250_dates(client, mutable_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("""INSERT INTO mart_sector_roll
            SELECT DATE '2027-01-01' + i::INTEGER, 'Test',
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
            FROM range(251) t(i)""")
    response = client.get("/api/sectors/roll?end=2026-06-11")
    assert response.status_code == 200
    assert len(response.get_json()) == 90
    assert len(client.get("/api/sectors/roll").get_json()) == 250


def test_sector_roll_missing_amount_stays_unknown(client, mutable_lake, synthetic_lake):
    with duckdb.connect(str(mutable_lake)) as con:
        con.execute("DELETE FROM mart_sector_day WHERE sw_l1='银行' AND trade_date=?", [synthetic_lake.days[-1]])
        con.execute("UPDATE mart_sector_day SET amount='inf'::DOUBLE WHERE trade_date=?", [synthetic_lake.days[-1]])
    response = client.get(f"/api/sectors/roll?start={synthetic_lake.latest}")
    assert response.status_code == 200
    assert len(response.get_json()) == 3
    assert all(row["amount"] is None for row in response.get_json())


def test_sector_roll_reversed_range_is_400_but_empty_range_is_200_empty(client):
    """T3-3：空响应。

    方案 A1-3 期望 start>end 返回 200 []，但全局 validate_api_request 在进路由前就
    abort(400)（方案 A2 明确不改该函数），因此实际按 400 断言；空响应用「合法但无数据
    的日期区间」验证为 200 []。
    """
    reversed_range = client.get("/api/sectors/roll?start=2026-05-30&end=2026-05-01")
    assert reversed_range.status_code == 400
    empty = client.get("/api/sectors/roll?start=2016-01-01&end=2016-01-31")
    assert empty.status_code == 200
    assert empty.get_json() == []
