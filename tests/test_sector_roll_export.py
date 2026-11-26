"""静态导出 payload 的 sector_roll 契约（合成库，对应方案 T5 三项）。

1. build_payload 结果包含 sector_roll 键，且字段齐全、250 交易日窗口不截断；
2. coverage 里有对应说明；
3. _script_json（allow_nan=False）序列化不抛错，且内联 JS 安全。
"""
from __future__ import annotations

import json

import duckdb
import pytest

from pipeline import export_static

ROLL_FIELDS = (
    "trade_date", "sw_l1",
    "ret_r5", "ret_r10", "ret_r20",
    "br_r5", "br_r10", "br_r20",
    "rank_r5", "rank_r10", "rank_r20",
    "amount",
)


@pytest.fixture(scope="module")
def payload(synthetic_lake):
    con = duckdb.connect(str(synthetic_lake.path), read_only=True)
    try:
        return export_static.build_payload(con)
    finally:
        con.close()


def test_build_payload_contains_sector_roll(payload):
    """T5-1：payload 有 sector_roll，字段齐全，日期降序窗口正确。"""
    assert "sector_roll" in payload
    data = payload["sector_roll"]
    assert len(data) == 30 * 3  # 合成库 30 交易日 × 3 行业；不足 250 天不截断
    assert set(ROLL_FIELDS) <= set(data[0])
    assert data[0]["trade_date"] == "2026-05-01"
    assert data[-1]["trade_date"] == "2026-06-11"
    assert isinstance(data[-1]["rank_r20"], int)  # rank 是整数，_round 不改类型
    # 成交额从 mart_sector_day JOIN 回来（单位：元）；整数，_round 不改类型
    assert isinstance(data[-1]["amount"], int)
    assert data[-1]["amount"] > 0


def test_coverage_mentions_sector_roll_window(payload):
    """T5-2：coverage 有 sector_roll 的说明。"""
    coverage = payload["coverage"]
    assert "sector_roll" in coverage
    assert coverage["sector_roll"] == "last 250 trading days"


def test_script_json_is_nan_free_and_safe(payload):
    """T5-3：_script_json 用 allow_nan=False，NaN/inf 必须已经在 norm() 里清掉。"""
    sector = "</script>行业"
    modified = {**payload, "sector_roll": [{**payload["sector_roll"][0], "sw_l1": sector}, *payload["sector_roll"][1:]]}
    encoded = export_static._script_json(modified)
    assert "<" not in encoded
    decoded = json.loads(encoded)
    assert len(decoded["sector_roll"]) == 30 * 3
    assert decoded["sector_roll"][0]["sw_l1"] == sector
    assert decoded["coverage"]["sector_roll"] == "last 250 trading days"


def test_missing_roll_table_degrades_instead_of_blocking_export(mutable_lake):
    """P1-1：旧库没有 mart_sector_roll 时，export_static 必须降级而不是整包失败。

    仓库文档把 `python -m pipeline.export_static` 列为可单独执行的命令；未重建 marts
    的库上跑导出不能因为多了一张新表而报 DuckDB catalog error。
    """
    con = duckdb.connect(str(mutable_lake))
    try:
        con.execute("DROP TABLE mart_sector_roll")
        payload = export_static.build_payload(con)
    finally:
        con.close()
    assert payload["sector_roll"] is None
    assert "rebuild marts" in payload["coverage"]["sector_roll"]
    decoded = json.loads(export_static._script_json(payload))  # allow_nan=False 不抛错
    assert decoded["sector_roll"] is None
