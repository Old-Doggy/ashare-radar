"""Ashare Radar 全局配置。

所有路径、口径常量集中在这里，禁止在其它模块里重复定义。
口径本身（收益/广度/集中度定义）见 docs/metric_contracts.md；本文件不再保留
没有消费者的历史常量（DISPLAY_START/SNAPSHOT_END/RETURN_CLIP/BREADTH_*/
INCLUDE_BSE/UNIVERSE_* 等已于 v0.4.3 删除，见 W1-05/W12-10）。
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if os.getenv("ASHARE_RADAR_LOAD_ENV", "1") != "0":
    load_dotenv(ROOT / ".env")

# ---------------------------------------------------------------- 路径
SOURCE_ROOT = Path(os.getenv("ASHARE_RADAR_SOURCE", str(ROOT / "data" / "snapshot")))
DATA = Path(os.getenv("ASHARE_RADAR_DATA_DIR", str(ROOT / "data"))).resolve()
RAW = DATA / "raw"
MARTS = DATA / "marts"
META = DATA / "meta"
SNAPSHOTS = DATA / "snapshots"
LAKE = DATA / "lake.duckdb"
CACHE = DATA / "cache"

for _p in (DATA, RAW, MARTS, META, SNAPSHOTS, CACHE):
    _p.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- 时间
# 主分析窗口起点：2016-12 作为 252 日新高的预热区；展示区间由前端区间选择决定，
# 不在后端截断（payload 从数据首日开始导出）。
BOOTSTRAP_START = "2016-12-01"

# ---------------------------------------------------------------- 质量门禁
GATE_MIN_COVERAGE = 0.99
GATE_MIN_INDUSTRY_COVERAGE = 0.97

TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN", "").strip()

__all__ = [
    "ROOT", "SOURCE_ROOT", "DATA", "RAW", "MARTS", "META", "SNAPSHOTS", "LAKE", "CACHE",
    "BOOTSTRAP_START",
    "GATE_MIN_COVERAGE", "GATE_MIN_INDUSTRY_COVERAGE", "TUSHARE_TOKEN",
]
