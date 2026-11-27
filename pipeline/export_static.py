"""把 DuckDB mart 导出成一个「单文件 HTML」dashboard。

产物：frontend/dist/ashare-radar.html
- 内联 CSS / JS / 字体 / 数据，双击即可打开（file://），无需服务器。
- 同时写出一份 data/static-data.json 便于排查。

用法：python -m pipeline.export_static [--allow-failed] [--clear-alert]

排序确定化（W4-02）：所有数组型 payload 都带二级 tie-break（ts_code / sw_l1），
所以除 meta.generated_at 外，同一份 mart 可导出可复现的字节内容。
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import tomllib
from datetime import datetime
from pathlib import Path

from . import settings
from .db import session, table_exists
from .io_utils import atomic_write_text
from .locking import publish_lock
from .sector_roll import SQL_SECTOR_ROLL_ROWS, roll_params

DIST = Path(os.getenv("ASHARE_RADAR_DIST_DIR", str(settings.ROOT / "frontend" / "dist"))).resolve()
OUT = DIST / "ashare-radar.html"

# 月度市场序列的投影必须与 API 对齐（W1-08）。API 当前返回同一组字段。
MARKET_MONTH_COLUMNS = """month::VARCHAR AS trade_date, n_days, n_valid, breadth, ew_ret, cw_ret,
    med_ret, csd, amount, hhi, top10_share, ew_ret_cum, hs300_ret_cum, hs300_n_days"""


def _round(v):
    if isinstance(v, float):
        return round(v, 6)
    if isinstance(v, dict):
        return {k: _round(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_round(x) for x in v]
    return v


def _version() -> str:
    try:
        with (settings.ROOT / "pyproject.toml").open("rb") as stream:
            return str(tomllib.load(stream).get("project", {}).get("version") or "unknown")
    except Exception:
        return "unknown"


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _column_names(con, table: str) -> set[str]:
    try:
        return {d[0] for d in con.execute(f"SELECT * FROM {table} LIMIT 0").description}
    except Exception:
        return set()


def build_payload(con) -> dict:
    def norm(v):
        if isinstance(v, float) and not math.isfinite(v):
            return None
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return v

    def rows(sql: str, params=None):
        cur = con.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        return [{c: norm(v) for c, v in zip(cols, r)} for r in cur.fetchall()]

    base = rows("SELECT min(trade_date) f, max(trade_date) d, count(*) n FROM mart_market_day")[0]
    meta = {
        "first_trade_date": str(base["f"]) if base["f"] else None,
        "last_trade_date": str(base["d"]) if base["d"] else None,
        "n_days": base["n"],
        "n_stocks": rows("SELECT n_valid n FROM mart_market_day ORDER BY trade_date DESC LIMIT 1")[0]["n"] if base["n"] else 0,
        "version": _version(),
        "source": "unknown",
        "sources": {},
        "unavailable_datasets": [],
        "status": "unknown",
        "updated_at": None,
        "warnings": [],
        "alert": None,
        "allow_failed": False,
        "data_quality": {"partial_days": [], "n_partial_days": 0,
                         "repaired_at": None, "history_gate": None},
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    alert_file = settings.META / "alert.json"
    if alert_file.exists():
        try:
            meta["alert"] = _read_json(alert_file)
            if isinstance(meta["alert"], dict):
                meta["alert"].pop("log", None)
        except Exception:
            pass
    status_file = settings.META / "status.json"
    if status_file.exists():
        st = _read_json(status_file)
        if isinstance(st, dict):
            meta["updated_at"] = st.get("updated_at")
            meta["status"] = st.get("status", "unknown")
            meta["warnings"] = st.get("warnings", [])
            raw_sources = st.get("sources", {}) or {}
            # 与 /api/meta 同口径：sources 只保留真实可用源，不可用数据集单列
            # （W7-03/W9-22；契约见 _fix_20261127/修复计划与接口约定.md §2.5）。
            meta["sources"] = {k: v for k, v in raw_sources.items()
                               if v not in ("unavailable", "incomplete")}
            used = sorted(set(meta["sources"].values()))
            meta["source"] = ", ".join(used) or "unknown"
            meta["unavailable_datasets"] = sorted(
                k for k, v in raw_sources.items() if v in ("unavailable", "incomplete"))
            if st.get("adj_degraded_days"):
                meta["adj_degraded_days"] = st["adj_degraded_days"]

    # 数据质量摘要（W11-01/W3-01）：partial 日清单来自 mart_market_day + 修复报告。
    if "data_quality" in _column_names(con, "mart_market_day"):
        partial = [r["trade_date"] for r in rows(
            "SELECT trade_date FROM mart_market_day WHERE data_quality <> 'ok' "
            "ORDER BY trade_date")]
    else:
        partial = []
    repair = _read_json(settings.META / "history_repair.json") or {}
    meta["data_quality"] = {
        "partial_days": partial,
        "n_partial_days": len(partial),
        "repaired_at": repair.get("finished_at") or repair.get("generated_at"),
        "repaired_days": len(repair.get("repaired") or []),
        "history_gate": {
            "pass": not partial,
            "n_partial_days": len(partial),
            "n_days": meta["n_days"],
            "source": "mart_market_day.data_quality",
        },
    }

    market = rows("SELECT * FROM mart_market_day ORDER BY trade_date")
    sectors_rows = rows(
        """
        SELECT trade_date::VARCHAR AS trade_date, sw_l1, n, n_adv, n_dec, breadth, ew_ret, cw_ret,
               med_ret, q10, q25, q75, q90, iqr, csd, amount, turnover_rate, limit_up_n
        FROM mart_sector_day
        WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 3 YEAR FROM mart_sector_day)
        ORDER BY trade_date, ew_ret DESC NULLS LAST, sw_l1
        """
    )
    sectors: dict[str, list] = {}
    for r in sectors_rows:
        sectors.setdefault(r["trade_date"], []).append(r)

    monthly = rows(
        f"""
        SELECT {MARKET_MONTH_COLUMNS}
        FROM mart_market_month ORDER BY month
        """
    )

    sector_monthly = rows(
        """
        SELECT month::VARCHAR AS month, sw_l1, n_days, breadth, ew_ret, cw_ret, iqr, amount, ew_ret_cum
        FROM mart_sector_month ORDER BY month, sw_l1
        """
    )

    rotation = rows(
        """
        SELECT trade_date::VARCHAR AS trade_date, rotation_intensity, n_sectors
        FROM mart_rotation_day
        WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 3 YEAR FROM mart_rotation_day)
        ORDER BY trade_date
        """
    )

    limit_quality = rows(
        """
        SELECT trade_date::VARCHAR AS trade_date, fd_ratio, open_share, avg_open_times, n_limit_up
        FROM mart_limit_quality
        WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 400 DAY FROM mart_limit_quality)
        ORDER BY trade_date
        """
    )

    sector_ranks = rows(
        """
        SELECT trade_date::VARCHAR AS trade_date, sw_l1, rank20, ret20
        FROM mart_sector_rank
        WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 1 YEAR FROM mart_sector_rank)
        ORDER BY trade_date, sw_l1
        """
    )

    # 旧库未重建 marts 时不能整包导出失败：缺表 → sector_roll=None（前端据此提示“离线包未包含”）。
    # amount 来自 mart_sector_day（单位：元），只作为气泡面积/成交额展示用，不进新表。
    has_sector_roll = table_exists(con, "mart_sector_roll")
    sector_roll = rows(SQL_SECTOR_ROLL_ROWS, roll_params()) if has_sector_roll else None
    if sector_roll is not None:
        n_by_day = {r["trade_date"]: r["n_sectors"] for r in rotation}
        for row in sector_roll:
            row["n_sectors"] = n_by_day.get(row["trade_date"])

    contrib_rows = rows(
        """
        WITH days AS (
            SELECT DISTINCT trade_date FROM mart_market_day ORDER BY trade_date DESC LIMIT 130
        ),
        f AS (
            SELECT s.trade_date, s.ts_code, s.name, s.sw_l1, s.ret, s.prev_circ_mv
            FROM feat_stock s JOIN days USING (trade_date)
            WHERE NOT s.is_new_stock AND s.prev_circ_mv > 0
        ),
        w AS (
            SELECT *, prev_circ_mv / sum(prev_circ_mv) OVER (PARTITION BY trade_date) AS weight FROM f
        ),
        r AS (
            SELECT *, weight * ret AS contrib,
                   row_number() OVER (PARTITION BY trade_date
                                      ORDER BY abs(weight * ret) DESC, ts_code) AS rn
            FROM w
        )
        SELECT trade_date::VARCHAR AS trade_date, ts_code, name, sw_l1, ret, weight, contrib
        FROM r WHERE rn <= 24 ORDER BY trade_date, rn
        """
    )
    contrib: dict[str, list] = {}
    for r in contrib_rows:
        contrib.setdefault(r["trade_date"], []).append(r)

    dist_rows = rows(
        """
        WITH f AS (
            SELECT ret FROM feat_stock
            WHERE trade_date = (SELECT max(trade_date) FROM feat_stock)
              AND NOT is_new_stock AND ret BETWEEN -0.11 AND 0.11
        )
        SELECT least(43, greatest(0, cast(floor((ret + 0.11) / 0.22 * 44) AS INTEGER))) AS b, count(*) AS n, min(ret) AS lo, max(ret) AS hi
        FROM f GROUP BY b ORDER BY b
        """
    )
    dist_stats = rows(
        """
        SELECT count(*) n, median(ret) med, quantile_cont(ret,0.05) p05, quantile_cont(ret,0.25) p25,
               quantile_cont(ret,0.75) p75, quantile_cont(ret,0.95) p95, avg(ret) mean, stddev_samp(ret) sd
        FROM feat_stock
        WHERE trade_date = (SELECT max(trade_date) FROM feat_stock) AND NOT is_new_stock
        """
    )[0]
    # 分箱只覆盖 ±11%，区间外样本不绘制、只计数。四个计数放在 distribution 顶层，
    # 与 API /api/distribution/<d> 结构一致（W6-03/W9-04，D3 契约）。
    dist_coverage = rows(
        """
        SELECT count(*) AS n_total,
               count(*) FILTER (WHERE ret BETWEEN -0.11 AND 0.11) AS n_binned,
               count(*) FILTER (WHERE ret < -0.11) AS n_excluded_lt,
               count(*) FILTER (WHERE ret > 0.11)  AS n_excluded_gt
        FROM feat_stock
        WHERE trade_date = (SELECT max(trade_date) FROM feat_stock) AND NOT is_new_stock
        """
    )[0]

    stocks = rows(
        """
        SELECT ts_code, name, sw_l1, market, trade_date::VARCHAR AS trade_date, close, ret,
               circ_mv, total_mv, turnover_rate, pe_ttm, pb, amount * 1000 AS amount,
               is_limit_up, is_limit_down
        FROM feat_stock
        WHERE trade_date = (SELECT max(trade_date) FROM feat_stock) AND NOT is_new_stock
        ORDER BY ret DESC, ts_code
        """
    )
    watch_pool = rows(
        """
        SELECT *
        FROM mart_stock_latest
        ORDER BY ts_code
        """
    )

    quality = _read_json(settings.META / "quality" / "latest.json") or {}

    top_codes = [
        r["ts_code"]
        for r in rows(
            "SELECT ts_code FROM feat_stock WHERE trade_date = (SELECT max(trade_date) FROM feat_stock) "
            "ORDER BY amount DESC, ts_code LIMIT 60"
        )
    ]
    sample_codes = ["600519.SH", "300750.SZ", "688981.SH", "600036.SH", "002594.SZ", "300059.SZ"]
    series_codes = sorted(set(top_codes) | set(sample_codes))
    ph = ",".join(["?"] * len(series_codes))
    series_rows = rows(
        f"""
        SELECT ts_code, trade_date::VARCHAR AS trade_date, open, high, low, close, vol, adj_factor
        FROM feat_stock
        WHERE ts_code IN ({ph})
          AND trade_date >= (SELECT max(trade_date) - INTERVAL 190 DAY FROM feat_stock)
        ORDER BY ts_code, trade_date
        """,
        series_codes,
    )
    # P1-6：K 线改为前复权（按窗口内最后一个**非空** adj_factor 归一，与 /api/stock 一致），
    # 数组 [date, o_adj, h_adj, l_adj, c_adj, vol, adj_factor]。
    stock_series: dict[str, list] = {}
    for r in series_rows:
        stock_series.setdefault(r["ts_code"], []).append(r)
    series_payload: dict[str, list] = {}
    for code, bars in stock_series.items():
        norm_factor = None
        for bar in bars:
            factor = bar.get("adj_factor")
            if factor is not None and math.isfinite(factor) and factor > 0:
                norm_factor = factor
        if not norm_factor:
            norm_factor = 1.0
        rows_out = []
        for bar in bars:
            factor = bar.get("adj_factor")
            scale = (factor / norm_factor) if factor is not None and math.isfinite(factor) else 1.0
            rows_out.append([bar["trade_date"],
                             bar["open"] * scale if bar["open"] is not None else None,
                             bar["high"] * scale if bar["high"] is not None else None,
                             bar["low"] * scale if bar["low"] is not None else None,
                             bar["close"] * scale if bar["close"] is not None else None,
                             bar["vol"], bar["adj_factor"]])
        series_payload[code] = rows_out

    updates = []
    for p in sorted(settings.META.glob("update_*.json"), reverse=True)[:30]:
        d = _read_json(p)
        if not isinstance(d, dict):
            continue
        updates.append(
            {
                "date": p.stem.replace("update_", ""),
                "status": d.get("status"),
                "days": len(d.get("days", [])),
                "duration": d.get("duration_sec"),
                "warnings": len(d.get("warnings", [])),
            }
        )

    reconcile = {}
    rfile = settings.META / "reconcile.json"
    if rfile.exists():
        rj = _read_json(rfile)
        if isinstance(rj, dict):
            reconcile = {k: rj.get(k) for k in ("generated_at", "days", "stocks", "pairs",
                                                "mae_pp", "p95_pp", "max_pp", "share_gt_0_1pp")}

    pe_rows = rows(
        f"""
        SELECT ts_code, trade_date::VARCHAR AS trade_date, pe_ttm
        FROM feat_stock
        WHERE ts_code IN ({ph})
          AND trade_date >= (SELECT max(trade_date) - INTERVAL 3 YEAR FROM feat_stock)
        ORDER BY ts_code, trade_date
        """,
        series_codes,
    )
    pe_hist: dict[str, list] = {}
    for r in pe_rows:
        pe_hist.setdefault(r["ts_code"], []).append(r)
    pe_percentile = {}
    for code, vals in pe_hist.items():
        current = vals[-1]
        last = current["pe_ttm"]
        if last is None or not math.isfinite(last) or last <= 0:
            pe_percentile[code] = {"pe": None, "pct": None, "n": 0, "quote_date": current["trade_date"]}
            continue
        vals = [r["pe_ttm"] for r in vals if r["pe_ttm"] is not None and math.isfinite(r["pe_ttm"]) and r["pe_ttm"] > 0]
        pe_percentile[code] = {
            "pe": round(last, 2),
            "pct": round(100 * sum(v <= last for v in vals) / len(vals)),
            "n": len(vals),
            "quote_date": current["trade_date"],
        }
    payload = {
        "meta": meta,
        "quality": quality,
        "updates": updates,
        "reconcile": reconcile,
        "market": market,
        "market_monthly": monthly,
        "sectors": sectors,
        "sector_monthly": sector_monthly,
        "rotation": rotation,
        "sector_ranks": sector_ranks,
        "sector_roll": sector_roll,
        "limit_quality": limit_quality,
        "contrib": contrib,
        "distribution": {meta["last_trade_date"]: {
            "bins": dist_rows, "stats": dist_stats,
            "n_total": dist_coverage["n_total"],
            "n_binned": dist_coverage["n_binned"],
            "n_excluded_lt": dist_coverage["n_excluded_lt"],
            "n_excluded_gt": dist_coverage["n_excluded_gt"],
        }},
        "stocks": stocks,
        "watch_pool": watch_pool,
        "stock_series": series_payload,
        "pe_percentile": pe_percentile,
        "coverage": {
            "stocks": "latest day only",
            "distribution": "latest day only; +/-11% returns excluded from bins (counted in stats)",
            "sectors": "last three years",
            "sector_roll": "last 250 trading days" if has_sector_roll else "unavailable: rebuild marts to export",
            "contributors": "last 130 trading days",
            "stock_series": "top-60 and sample stocks, last 190 calendar days, qfq adjusted by last adj_factor in window",
        },
    }
    return _round(payload)


def _inline_assets(html: str, assets: dict[str, bytes]) -> str:
    # CSS：内联并把字体替换为 base64
    def repl_css(match: re.Match) -> str:
        href = match.group(1).lstrip("./").split("/")[-1]
        raw = assets.get(href)
        if raw is None:
            raise ValueError(f"missing stylesheet asset: {href}")
        css = raw.decode("utf-8")
        for name, blob in assets.items():
            if not name.endswith((".woff2", ".woff")):
                continue
            b64 = base64.b64encode(blob).decode()
            pattern = r"url\(\s*[\"']?(?:\./|/assets/|assets/)?" + re.escape(name) + r"[\"']?\s*\)"
            mime = "woff2" if name.endswith(".woff2") else "woff"
            css = re.sub(pattern, f"url(data:font/{mime};base64,{b64})", css)
        for url in re.findall(r"url\(([^)]*)\)", css):
            if not url.strip().strip("\"'").startswith(("data:", "#")):
                raise ValueError("stylesheet contains non-inlined asset URLs")
        return f"<style>{css}</style>"

    html = re.sub(r'<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>', repl_css, html)
    html = re.sub(r'<link[^>]+rel="modulepreload"[^>]*>', "", html)

    # JS：内联模块
    def repl_js(match: re.Match) -> str:
        src = match.group(1)
        name = src.split("/")[-1]
        raw = assets.get(name)
        if raw is None:
            raise ValueError(f"missing JavaScript asset: {name}")
        js = re.sub(r"</script", lambda _: "<\\/script", raw.decode("utf-8"), flags=re.IGNORECASE)
        for icon in ("favicon.png", "app-icon.png"):
            if icon in assets:
                encoded = "data:image/png;base64," + base64.b64encode(assets[icon]).decode("ascii")
                for quote in ('"', "'", '`'):
                    for path in (icon, '/' + icon, './' + icon):
                        js = js.replace(quote + path + quote, json.dumps(encoded))
        return f'<script type="module">{js}</script>'

    html = re.sub(r'<script[^>]+type="module"[^>]*src="([^"]+)"[^>]*></script>', repl_js, html)
    for icon in ("favicon.png", "app-icon.png"):
        pattern = rf'href="(?:/|\./)?{re.escape(icon)}"'
        if re.search(pattern, html):
            if icon not in assets:
                raise ValueError(f"missing icon asset: {icon}")
            encoded = "data:image/png;base64," + base64.b64encode(assets[icon]).decode("ascii")
            html = re.sub(pattern, f'href="{encoded}"', html)
    return html


def _script_json(payload: dict) -> str:
    return (json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            .replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def main(allow_failed: bool = False, clear_alert: bool = False) -> None:
    with publish_lock():
        _export(allow_failed, clear_alert)


def _export(allow_failed: bool, clear_alert: bool = False) -> None:
    with session(read_only=True) as con:
        con.execute("BEGIN TRANSACTION")
        payload = build_payload(con)
    if clear_alert:
        payload["meta"]["alert"] = None
    if allow_failed:
        payload["meta"]["allow_failed"] = True
    quality = payload.get("quality", {})
    if not payload["meta"]["n_days"]:
        raise RuntimeError("cannot export empty market data")
    quality_day = str(quality.get("date") or "").replace("-", "")
    latest_day = str(payload["meta"]["last_trade_date"] or "").replace("-", "")
    if not allow_failed and (not quality.get("passed") or quality_day != latest_day
                             or payload["meta"]["status"] != "ok"):
        raise RuntimeError("quality gates/status must pass for the exported trade date")

    data_json = _script_json(payload)
    index = (DIST / "index.html").read_text(encoding="utf-8")
    assets = {p.name: p.read_bytes() for p in (DIST / "assets").iterdir() if p.is_file()}
    for icon in ("favicon.png", "app-icon.png"):
        icon_path = DIST / icon
        if icon_path.is_file():
            assets[icon] = icon_path.read_bytes()
    html = _inline_assets(index, assets)
    data_script = f"<script>window.__BL_DATA__={data_json};</script>"
    html = html.replace("</head>", data_script + "</head>", 1) if "</head>" in html else data_script + html
    # 两个产物成对替换：HTML 写失败时把 static-data.json 恢复为旧内容（W3-16/W4-07）。
    json_path = settings.DATA / "static-data.json"
    previous_json = json_path.read_bytes() if json_path.exists() else None
    atomic_write_text(json_path, data_json)
    try:
        atomic_write_text(OUT, html)
    except BaseException:
        if previous_json is not None:
            atomic_write_text(json_path, previous_json.decode("utf-8"))
        raise
    size = OUT.stat().st_size / 1e6
    print(f"[export] {OUT}  {size:.1f} MB  (json {len(data_json)/1e6:.1f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-failed", action="store_true",
                        help="re-export existing marts with a failure warning (frontend shows the alert)")
    parser.add_argument("--clear-alert", action="store_true", help="omit the current alert from the payload")
    args = parser.parse_args()
    main(args.allow_failed, args.clear_alert)
