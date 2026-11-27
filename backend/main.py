"""Ashare Radar API（Flask 同步版）。

运行：python -m backend.main  （默认 127.0.0.1:8000）
设计：口径在 mart 层算好，接口只做筛选与序列化；DuckDB 单连接 + 锁。

安全约定（见 docs/technical.md「API 安全」）：
- 所有 /api/* 请求（含 GET）校验 Host ∈ TRUSTED_HOSTS（默认 127.0.0.1/localhost/[::1]，
  可用 ASHARE_RADAR_TRUSTED_HOSTS 覆盖，逗号分隔）；非法 Host 返回 403 JSON。
- 写接口额外校验 Origin / 客户端地址；GET /api/watchlist 额外要求
  `X-Requested-With: ashare-radar` 且所有 /api/* 响应 Cache-Control: no-store。
- 未匹配的 /api/* 返回 404 JSON，不再落入 SPA 兜底。
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import threading
import tomllib
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import duckdb
from flask import Flask, abort, g, jsonify, request, send_from_directory
from flask.json.provider import DefaultJSONProvider
from werkzeug.exceptions import HTTPException

from pipeline import settings
from pipeline.db import table_exists
from pipeline.sector_roll import SQL_SECTOR_ROLL_ROWS, roll_params

ROOT = settings.ROOT
LAKE = settings.LAKE
META = settings.META
DB = settings.DATA / "app.sqlite"
DIST = Path(os.getenv("ASHARE_RADAR_DIST_DIR", str(ROOT / "frontend" / "dist"))).resolve()

# ---------------------------------------------------------------- 安全常量
LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
TRUSTED_HOSTS_ENV = "ASHARE_RADAR_TRUSTED_HOSTS"
WATCHLIST_HEADER = "X-Requested-With"
WATCHLIST_HEADER_VALUE = "ashare-radar"
API_SECURITY_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
    ("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()"),
    ("Cache-Control", "no-store"),
)

# ---------------------------------------------------------------- 契约常量
STOCKS_DEFAULT_LIMIT = 6000  # 与前端 api.ts 默认值一致（静态包为全量后由前端 slice）
STOCKS_MAX_LIMIT = 10000
SECTOR_SERIES_DEFAULT_LIMIT = 750  # 无区间时 /api/sectors/series 最多返回的行数
MAX_WATCH_SHARES = 1e12
MAX_WATCH_COST = 1e9
DEFAULT_UPDATE_TIMEOUT = 2700  # 秒；ASHARE_RADAR_UPDATE_TIMEOUT 可覆盖
DISTRIBUTION_BOUND = 0.11


class ISOJSONProvider(DefaultJSONProvider):
    """DuckDB DATE/DATETIME 默认会被 Flask 序列化成 RFC 822，前端和图表要 ISO。"""

    def default(self, obj: Any) -> Any:
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        return super().default(obj)


app = Flask(__name__, static_folder=None)
app.json = ISOJSONProvider(app)
app.json.ensure_ascii = False
app.json.sort_keys = False


def _parse_host(value: str | None) -> str | None:
    """把 Host/Origin 值归一为小写主机名（容忍端口与 IPv6 方括号）。"""
    if not value:
        return None
    raw = value.strip().lower()
    if not raw:
        return None
    try:
        parsed = urlsplit("//" + raw)
    except ValueError:
        return None
    return parsed.hostname


def trusted_hosts() -> frozenset[str]:
    """信任的 Host 集合；ASHARE_RADAR_TRUSTED_HOSTS 非空时整体覆盖默认值。"""
    raw = (os.getenv(TRUSTED_HOSTS_ENV) or "").strip()
    if raw:
        hosts = {host for host in (_parse_host(item) for item in raw.split(",")) if host}
        if hosts:
            return frozenset(hosts)
    return LOCAL_HOSTS


def _is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


@app.before_request
def validate_api_request():
    """统一入口校验：/api/* 全部方法（含 GET）先过 Host，再做参数与写接口鉴权。"""
    if not _is_api_path(request.path):
        return None
    if _parse_host(request.host) not in trusted_hosts():
        abort(403, "untrusted host")
    rule = request.url_rule
    if rule is None or rule.endpoint == "static_files":
        # 未匹配的 /api/* 不要回落到 SPA index，也不要先做参数校验。
        abort(404, "unknown API endpoint")
    for key in ("date", "start", "end"):
        raw = request.args.get(key)
        if raw is not None:
            _date_arg(raw)
    start, end = request.args.get("start"), request.args.get("end")
    if start and end and start > end:
        abort(400, "start must not be after end")
    if request.method in ("POST", "PATCH", "DELETE"):
        if request.remote_addr and request.remote_addr not in LOCAL_HOSTS:
            abort(403, "local client required")
        origin = request.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.hostname not in trusted_hosts():
                abort(403, "local origin required")
    return None


@app.after_request
def add_api_security_headers(response):
    """所有 /api/* 响应补安全头；UI/静态资源不加 CSP（避免破坏 SPA）。"""
    if _is_api_path(request.path):
        for key, value in API_SECURITY_HEADERS:
            response.headers.setdefault(key, value)
    return response


def _date_arg(raw: str) -> str:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            raise ValueError
        date.fromisoformat(raw)
    except ValueError:
        abort(400, "date must be YYYY-MM-DD")
    return raw


def _code_arg(code: str) -> str:
    if not re.fullmatch(r"\d{6}\.(?:SH|SZ)", code):
        abort(400, "invalid A-share code")
    return code


def _quantity(value: Any, field: str, maximum: float | None = None) -> float:
    try:
        if isinstance(value, bool):
            raise ValueError
        number = float(value)
        if not math.isfinite(number) or number < 0:
            raise ValueError
        if maximum is not None and number > maximum:
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        abort(400, f"{field} must be a finite non-negative number")
    return number


def _payload() -> dict:
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        abort(400, "JSON object required")
    return value


def _strict_payload(allowed: set[str]) -> dict:
    """写接口 JSON body 白名单：未知键 400，避免静默忽略客户端拼写错误。"""
    payload = _payload()
    unknown = sorted(set(payload) - allowed)
    if unknown:
        abort(400, f"unknown fields: {', '.join(unknown)}")
    return payload


@app.errorhandler(HTTPException)
def http_error(error):
    return jsonify({"error": error.name, "detail": error.description}), error.code


@app.errorhandler(duckdb.CatalogException)
def _db_schema_missing(error):
    """旧库/半建库缺 mart 表时返回 409 + 重建提示，而不是笼统 500。"""
    message = str(error).lower()
    if any(hint in message for hint in ("does not exist", "not found", "no such")):
        return (
            jsonify({"error": "mart missing", "detail": "数据表未完整构建，请运行 python -m pipeline.build_marts 重建"}),
            409,
        )
    return internal_error(error)


@app.errorhandler(sqlite3.OperationalError)
def _watch_db_busy(error):
    message = str(error).lower()
    if "locked" in message or "busy" in message:
        return (
            jsonify({"error": "watchlist busy", "detail": "本地自选库繁忙，请稍后重试"}),
            503,
            {"Retry-After": "5"},
        )
    return internal_error(error)


@app.errorhandler(Exception)
def internal_error(error):
    app.logger.error("request failed: %s", type(error).__name__)
    return jsonify({"error": "internal server error"}), 500


_lock = threading.Lock()
_update_lock = threading.Lock()
_update_job: dict[str, Any] = {
    "id": None,
    "state": "idle",
    "progress": 0,
    "stage": "",
    "message": "",
    "started_at": None,
    "finished_at": None,
    "trade_date": None,
}


def con() -> duckdb.DuckDBPyConnection:
    """每请求一个只读连接，请求结束即释放，避免长期占锁让更新任务打不开库。"""
    c = getattr(g, "_con", None)
    if c is None:
        if not LAKE.exists():
            abort(503, "lake.duckdb 尚未构建")
        c = duckdb.connect(str(LAKE), read_only=True)
        try:
            c.execute("SET threads=4")
            c.execute("BEGIN TRANSACTION")
            g._con = c
        except Exception:
            c.close()
            raise
    return c


@app.errorhandler(duckdb.Error)
def _db_busy(e):
    if any(hint in str(e).lower() for hint in ("could not set lock", "conflicting lock", "being used",
                                               "file is already open in", "different configuration")):
        return (
            jsonify({"error": "database busy", "detail": "数据更新中，请稍后重试"}),
            503,
            {"Retry-After": "10"},
        )
    return internal_error(e)


@app.teardown_appcontext
def _release_con(exc: BaseException | None) -> None:
    c = g.pop("_con", None)
    if c is not None:
        c.close()


def _clean(v: Any) -> Any:
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def rows(sql: str, params: list[Any] | None = None) -> list[dict]:
    with _lock:
        cur = con().execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        return [{c: _clean(v) for c, v in zip(cols, r)} for r in cur.fetchall()]


def one(sql: str, params: list[Any] | None = None) -> dict:
    r = rows(sql, params)
    return r[0] if r else {}


def _trade_date_exists(d: str) -> bool:
    return bool(one("SELECT 1 AS ok FROM mart_market_day WHERE trade_date = ?::DATE", [d]).get("ok"))


def _table_columns(table: str) -> set[str]:
    """information_schema 列名（旧库缺列时用于可选的兼容输出）。"""
    try:
        return {
            str(row["column_name"])
            for row in rows(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ?", [table]
            )
        }
    except duckdb.Error:
        return set()


def _read_meta_json(name: str) -> dict:
    try:
        value = json.loads((META / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _data_quality_meta(n_days: int) -> dict:
    """meta.data_quality：与 export_static.py 同结构（partial 日清单 + 修复报告摘要）。"""
    partial_days: list[str] = []
    if "data_quality" in _table_columns("mart_market_day"):
        partial_days = [
            str(row["d"])
            for row in rows(
                "SELECT trade_date::VARCHAR AS d FROM mart_market_day "
                "WHERE data_quality <> 'ok' ORDER BY trade_date"
            )
        ]
    repair = _read_meta_json("history_repair.json")
    return {
        "partial_days": partial_days,
        "n_partial_days": len(partial_days),
        "repaired_at": repair.get("finished_at") or repair.get("generated_at"),
        "repaired_days": len(repair.get("repaired") or []),
        "history_gate": {
            "pass": not partial_days,
            "n_partial_days": len(partial_days),
            "n_days": n_days,
            "source": "mart_market_day.data_quality",
        },
    }


def _app_version() -> str:
    """pyproject.toml 的版本号（静态 payload meta.version 同源，供 Briefing 页脚）。"""
    try:
        with (ROOT / "pyproject.toml").open("rb") as stream:
            return str(tomllib.load(stream).get("project", {}).get("version") or "unknown")
    except Exception:
        return "unknown"


APP_VERSION = _app_version()


# ------------------------------------------------------------------ update job
class UpdateError(RuntimeError):
    pass


def _job_snapshot() -> dict:
    with _update_lock:
        return dict(_update_job)


def _job_set(**kw: Any) -> None:
    with _update_lock:
        _update_job.update(kw)


def _job_progress(value: int, stage: str | None = None, message: str | None = None) -> None:
    with _update_lock:
        if _update_job.get("state") != "running":
            return
        _update_job["progress"] = max(int(_update_job.get("progress") or 0), min(99, value))
        if stage:
            _update_job["stage"] = stage
        if message:
            _update_job["message"] = message


def _update_timeout() -> int:
    """子进程超时（秒），默认 2700；ASHARE_RADAR_UPDATE_TIMEOUT 可覆盖。"""
    raw = os.getenv("ASHARE_RADAR_UPDATE_TIMEOUT")
    if raw is None:
        return DEFAULT_UPDATE_TIMEOUT
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_UPDATE_TIMEOUT
    if not math.isfinite(value) or value <= 0:
        return DEFAULT_UPDATE_TIMEOUT
    return max(1, int(value))


def _friendly_update_error(text: str) -> str:
    low = (text or "").lower()
    if "no module named 'duckdb'" in low or "no module named \"duckdb\"" in low:
        return "运行环境缺少数据依赖，请用 ashare-radar 环境重新执行"
    if "tushare_token" in low or "token" in low and "not" in low:
        return "未配置 Tushare Token，暂时无法拉取数据"
    if "no permission" in low:
        return "Tushare 权限不足，部分数据源不可用"
    if "another update" in low or "already running" in low:
        return "已有更新任务正在运行，请稍后再试"
    if "quality" in low or "gate" in low:
        return "数据质量校验未通过，本次更新已中止"
    if "empty" in low or "no data" in low:
        return "数据源尚未返回今日数据，请稍后重试"
    if "traceback" in low:
        return "更新脚本执行失败，请稍后重试"
    if "timeout" in low or "timed out" in low:
        return "更新超时，任务已中止，请检查本地更新日志"
    return "更新失败，请检查本地更新日志后重试"


def _run_step(args: list[str], stage: str, start: int, end: int) -> tuple[int, str]:
    _job_progress(start, stage, "正在连接数据源" if stage == "fetching" else "正在重算指标")
    proc = subprocess.Popen(
        args,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    timed_out = threading.Event()

    def stop():
        timed_out.set()
        proc.kill()

    timer = threading.Timer(_update_timeout(), stop)
    timer.daemon = True
    timer.start()
    lines: list[str] = []
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line:
                continue
            lines.append(line)
            if len(lines) > 120:
                lines.pop(0)
            if line.startswith("[update]"):
                _job_progress(35, "fetching", "正在更新并校验行情")
            elif line.startswith("[marts]"):
                _job_progress(65, "building", "正在重算指标")
            elif line.startswith("[export]"):
                _job_progress(95, "export", "正在生成离线文件")
        code = proc.wait()
    finally:
        timer.cancel()
        if proc.stdout is not None:
            proc.stdout.close()
    return (124, "update timeout") if timed_out.is_set() else (code, "\n".join(lines))


def _status_trade_date() -> str | None:
    try:
        data = json.loads((META / "status.json").read_text(encoding="utf-8"))
        raw = str(data.get("last_trade_date") or "")
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}" if len(raw) == 8 else (raw or None)
    except Exception:
        return None


def _run_update_job() -> None:
    try:
        _job_set(state="running", progress=4, stage="preparing", message="准备更新数据")
        code, out = _run_step([sys.executable, "-m", "pipeline.release"], "fetching", 8, 97)
        if code != 0:
            raise UpdateError(out)
        if '"status": "skipped"' in out or "another update" in out:
            raise UpdateError("已有更新任务正在运行，请稍后再试")

        d = _status_trade_date()
        _job_set(
            state="done",
            progress=100,
            stage="done",
            message=f"已更新到 {d}" if d else "数据更新完成",
            trade_date=d,
            finished_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        )
    except Exception as exc:
        msg = _friendly_update_error(str(exc))
        _job_set(
            state="failed",
            stage="failed",
            message=msg,
            finished_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        )
        try:
            from pipeline import alerts
            # A rejected second updater must not overwrite the active publisher's
            # alert/status outside its publication lock.
            if "another update" not in str(exc).lower() and "already running" not in str(exc).lower():
                alerts.write("update", msg)
        except Exception:
            pass


@app.post("/api/update")
def start_update():
    # 自定义头会让跨站表单触发 CORS 预检而失败，避免任意网页触发本地更新
    if request.headers.get("X-Ashare-Radar") != "1":
        abort(403, "missing X-Ashare-Radar header")
    with _update_lock:
        if _update_job.get("state") == "running":
            # 运行中再次 POST：明确 409，调用方不会把“未入队”误判为“已开始”。
            return (
                jsonify({
                    "error": "update already running",
                    "detail": "已有更新任务正在运行，请稍后重试",
                    "job": dict(_update_job),
                }),
                409,
            )
        job_id = uuid.uuid4().hex[:10]
        _update_job.update(
            id=job_id,
            state="running",
            progress=1,
            stage="preparing",
            message="准备更新数据",
            started_at=datetime.now().astimezone().isoformat(timespec="seconds"),
            finished_at=None,
            trade_date=None,
        )
        snapshot = dict(_update_job)
    threading.Thread(target=_run_update_job, name="ashare-radar-update", daemon=True).start()
    return jsonify(snapshot), 202


@app.get("/api/update/status")
def update_status():
    return jsonify(_job_snapshot())


@app.get("/api/meta")
def meta():
    base = one("SELECT min(trade_date) f, max(trade_date) d, count(*) n FROM mart_market_day")
    n_stocks = one("SELECT n_valid n FROM mart_market_day ORDER BY trade_date DESC LIMIT 1").get("n", 0)
    status = {"status": "unknown", "updated_at": None, "warnings": [], "sources": {}}
    p = META / "status.json"
    if p.exists():
        try:
            status.update(json.loads(p.read_text(encoding="utf-8")))
        except Exception:
            pass
    alert = None
    ap = META / "alert.json"
    if ap.exists():
        try:
            alert = json.loads(ap.read_text(encoding="utf-8"))
            if isinstance(alert, dict):
                alert.pop("log", None)
        except Exception:
            alert = None
    raw_sources = status.get("sources") if isinstance(status.get("sources"), dict) else {}
    sources: dict[str, Any] = {}
    unavailable: list[str] = []
    for name, source in raw_sources.items():
        label = "" if source is None else str(source).strip()
        if label in ("unavailable", "incomplete"):
            if label == "unavailable":
                unavailable.append(str(name))
        else:
            sources[str(name)] = source
    source_names = sorted({str(value).strip() for value in sources.values() if str(value).strip()})
    payload = {
        "first_trade_date": str(base["f"]) if base.get("f") else None,
        "last_trade_date": str(base["d"]) if base.get("d") else None,
        "n_days": base.get("n"),
        "n_stocks": n_stocks,
        "version": APP_VERSION,
        "source": ", ".join(source_names) or "unknown",
        "sources": sources,
        "unavailable_datasets": sorted(unavailable),
        "status": status.get("status", "unknown"),
        "updated_at": status.get("updated_at"),
        "warnings": status.get("warnings", []),
        "alert": alert,
        "data_quality": _data_quality_meta(int(base.get("n") or 0)),
    }
    if status.get("adj_degraded_days"):
        payload["adj_degraded_days"] = status["adj_degraded_days"]
    return jsonify(payload)


@app.get("/api/market/series")
def market_series():
    start = request.args.get("start")
    end = request.args.get("end")
    freq = request.args.get("freq", "day")
    if freq not in ("day", "month"):
        abort(400, "freq must be day or month")
    if freq == "month":
        return jsonify(
            rows(
                """
                SELECT month::VARCHAR AS trade_date, n_days, n_valid, breadth, ew_ret, cw_ret, med_ret,
                       csd, amount, hhi, top10_share, ew_ret_cum, hs300_ret_cum, hs300_n_days
                FROM mart_market_month
                WHERE (?::DATE IS NULL OR month >= ?::DATE) AND (?::DATE IS NULL OR month <= ?::DATE)
                ORDER BY month
                """,
                [start, start, end, end],
            )
        )
    # SELECT *：mart_market_day 追加新列（weight_coverage/n_valid_ratio/data_quality/
    # margin_n_exchanges/n_extreme_ret）后 API 自动透出，旧库未重建时也不会报错。
    return jsonify(
        rows(
            """
            SELECT * FROM mart_market_day
            WHERE (?::DATE IS NULL OR trade_date >= ?::DATE) AND (?::DATE IS NULL OR trade_date <= ?::DATE)
            ORDER BY trade_date
            """,
            [start, start, end, end],
        )
    )


@app.get("/api/market/day/<d>")
def market_day(d: str):
    _date_arg(d)
    m = one("SELECT * FROM mart_market_day WHERE trade_date = ?::DATE", [d])
    if not m:
        abort(404, "no data for this date")
    contrib = rows(
        """
        WITH f AS (
            SELECT ts_code, name, sw_l1, ret, prev_circ_mv
            FROM feat_stock
            WHERE trade_date = ?::DATE AND NOT is_new_stock AND prev_circ_mv > 0
        ),
        w AS (SELECT *, prev_circ_mv / sum(prev_circ_mv) OVER () AS weight FROM f)
        SELECT ts_code, name, sw_l1, ret, weight, weight * ret AS contrib
        FROM w ORDER BY abs(weight * ret) DESC, ts_code LIMIT 24
        """,
        [d],
    )
    sectors = rows(
        "SELECT * FROM mart_sector_day WHERE trade_date = ?::DATE "
        "ORDER BY ew_ret DESC NULLS LAST, sw_l1",
        [d],
    )
    m["contributors"] = contrib
    m["sectors"] = sectors
    return jsonify(m)


@app.get("/api/distribution/<d>")
def distribution(d: str):
    _date_arg(d)
    counts = one(
        f"""
        SELECT count(*) AS n_total,
               count(*) FILTER (WHERE ret BETWEEN -{DISTRIBUTION_BOUND} AND {DISTRIBUTION_BOUND}) AS n_binned,
               count(*) FILTER (WHERE ret < -{DISTRIBUTION_BOUND}) AS n_excluded_lt,
               count(*) FILTER (WHERE ret > {DISTRIBUTION_BOUND}) AS n_excluded_gt
        FROM feat_stock WHERE trade_date = ?::DATE AND NOT is_new_stock
        """,
        [d],
    )
    if not counts.get("n_total"):
        abort(404, "no data for this date")
    bins = rows(
        f"""
        WITH f AS (
            SELECT ret FROM feat_stock
            WHERE trade_date = ?::DATE AND NOT is_new_stock AND ret BETWEEN -{DISTRIBUTION_BOUND} AND {DISTRIBUTION_BOUND}
        )
        SELECT least(43, greatest(0, cast(floor((ret + {DISTRIBUTION_BOUND}) / {2 * DISTRIBUTION_BOUND} * 44) AS INTEGER))) AS b,
               count(*) AS n, min(ret) AS lo, max(ret) AS hi
        FROM f GROUP BY b ORDER BY b
        """,
        [d],
    )
    stats = one(
        """
        SELECT count(*) n, median(ret) med, quantile_cont(ret,0.05) p05, quantile_cont(ret,0.25) p25,
               quantile_cont(ret,0.75) p75, quantile_cont(ret,0.95) p95,
               avg(ret) mean, stddev_samp(ret) sd
        FROM feat_stock WHERE trade_date = ?::DATE AND NOT is_new_stock
        """,
        [d],
    )
    return jsonify({"bins": bins, "stats": stats, **{
        key: counts.get(key) for key in ("n_total", "n_binned", "n_excluded_lt", "n_excluded_gt")
    }})


@app.get("/api/sectors")
def sectors():
    d = request.args.get("date")
    if not d:
        abort(400, "date required")
    data = rows(
        "SELECT * FROM mart_sector_day WHERE trade_date = ?::DATE "
        "ORDER BY ew_ret DESC NULLS LAST, sw_l1",
        [d],
    )
    if not data and not _trade_date_exists(d):
        abort(404, "no data for this date")
    return jsonify(data)


@app.get("/api/sectors/series")
def sector_series():
    """行业日序列表。

    契约：必须同时提供 start/end，或都不提供。都不提供时最多返回最近
    SECTOR_SERIES_DEFAULT_LIMIT（750）行，并附全量 total；区间查询返回区间内全部行。
    """
    start, end = request.args.get("start"), request.args.get("end")
    if bool(start) != bool(end):
        abort(400, "start and end must be provided together")
    if not start:
        rows_ = rows(
            """
            SELECT * FROM (
                SELECT * FROM mart_sector_day
                ORDER BY trade_date DESC, ew_ret DESC NULLS LAST, sw_l1 DESC LIMIT ?
            ) ORDER BY trade_date, ew_ret DESC NULLS LAST, sw_l1
            """,
            [SECTOR_SERIES_DEFAULT_LIMIT],
        )
        total = one("SELECT count(*) AS n FROM mart_sector_day").get("n", 0)
        return jsonify({
            "rows": rows_,
            "total": total,
            "limited": True,
            "limit": SECTOR_SERIES_DEFAULT_LIMIT,
        })
    data = rows(
        """
        SELECT * FROM mart_sector_day
        WHERE trade_date >= ?::DATE AND trade_date <= ?::DATE
        ORDER BY trade_date, ew_ret DESC NULLS LAST, sw_l1
        """,
        [start, end],
    )
    return jsonify({"rows": data, "total": len(data), "limited": False, "limit": None})


@app.get("/api/sectors/roll")
def sector_roll():
    """滚动强度序列，供轮动图取数。默认最近 250 个交易日。

    `amount` 不复制进 mart_sector_roll：它来自 mart_sector_day（单位：元），
    只作为气泡面积/成交额展示用，JOIN 回来即可，避免新表口径膨胀。
    """
    if not table_exists(con(), "mart_sector_roll"):
        return jsonify({"error": "sector_roll_missing", "detail": "Run pipeline.build_marts to initialize sector rotation"}), 409
    return jsonify(rows(SQL_SECTOR_ROLL_ROWS, roll_params(request.args.get("start"), request.args.get("end"))))


@app.get("/api/sectors/monthly")
def sector_monthly():
    start, end = request.args.get("start"), request.args.get("end")
    return jsonify(
        rows(
            """
            SELECT month::VARCHAR AS month, sw_l1, n_days, breadth, ew_ret, cw_ret, iqr, amount, ew_ret_cum
            FROM mart_sector_month
            WHERE (?::DATE IS NULL OR month >= ?::DATE) AND (?::DATE IS NULL OR month <= ?::DATE)
            ORDER BY month, sw_l1
            """,
            [start, start, end, end],
        )
    )


@app.get("/api/stocks")
def stocks():
    """单日个股列表（默认 Top 6000，与前端一致）。

    返回 `{"date", "limit", "total", "rows"}`；total 为过滤条件（date/sector）下的
    总行数，rows 按 `ret DESC, ts_code` 确定排序。
    """
    d = request.args.get("date")
    if not d:
        abort(400, "date required")
    sector = request.args.get("sector")
    try:
        limit = int(request.args.get("limit", STOCKS_DEFAULT_LIMIT))
        if not 1 <= limit <= STOCKS_MAX_LIMIT:
            raise ValueError
    except ValueError:
        abort(400, f"limit must be an integer between 1 and {STOCKS_MAX_LIMIT}")
    data = rows(
        """
        SELECT ts_code, name, sw_l1, market, trade_date, close, ret, circ_mv, total_mv,
               turnover_rate, pe_ttm, pb, amount * 1000 AS amount, is_limit_up, is_limit_down,
               count(*) OVER () AS total
        FROM feat_stock
        WHERE trade_date = ?::DATE AND NOT is_new_stock
          AND (? IS NULL OR sw_l1 = ?)
        ORDER BY ret DESC, ts_code
        LIMIT ?
        """,
        [d, sector, sector, limit],
    )
    if data:
        total = int(data[0].pop("total"))
    else:
        if not _trade_date_exists(d):
            abort(404, "no data for this date")
        total = 0
    return jsonify({"date": d, "limit": limit, "sector": sector, "total": total, "rows": data})


STOCK_SERIES_FIELDS = (
    "trade_date::VARCHAR AS trade_date, open, high, low, close, vol, adj_factor, adj_close, ret,"
    " circ_mv, turnover_rate, amount * 1000 AS amount, sw_l1, name"
)


@app.get("/api/stock/<code>")
def stock_series(code: str):
    """个股 K 线：前复权 OHLC（按返回窗口最后一个非空 adj_factor 归一）。

    返回 `{code, adjust: "qfq", series: [{trade_date, open, high, low, close, vol,
    adj_factor, close_raw, adj_close, ret, circ_mv, turnover_rate, amount, sw_l1, name}]}`；
    open/high/low/close 为前复权价，close_raw 为原始收盘价（与静态 payload
    stock_series 的 qfq 口径一致，便于前端 K 线跨除权日连续）。
    """
    _code_arg(code)
    start, end = request.args.get("start"), request.args.get("end")
    if not one("SELECT 1 AS ok FROM feat_stock WHERE ts_code = ? LIMIT 1", [code]).get("ok"):
        abort(404, "no data for this code")
    data = rows(
        f"""
        SELECT {STOCK_SERIES_FIELDS}
        FROM feat_stock
        WHERE ts_code = ?
          AND (?::DATE IS NULL OR trade_date >= ?::DATE)
          AND (?::DATE IS NULL OR trade_date <= ?::DATE)
        ORDER BY trade_date
        """,
        [code, start, start, end, end],
    )
    norm: float | None = None
    for row in data:
        factor = row.get("adj_factor")
        if factor is not None:
            norm = factor
    for row in data:
        factor = row.get("adj_factor")
        scale = (factor / norm) if factor is not None and norm else 1.0
        row["close_raw"] = row.get("close")
        for field in ("open", "high", "low", "close"):
            value = row.get(field)
            row[field] = value * scale if value is not None else None
    return jsonify({"code": code, "adjust": "qfq", "series": data})


def _watch_connect(read_only: bool) -> sqlite3.Connection:
    """本地自选 SQLite 连接。

    读路径绝不创建文件/表（GET /api/watchlist 无库时返回 []）；写路径才建表并迁移。
    """
    if read_only and not DB.exists():
        raise FileNotFoundError(DB)
    c = sqlite3.connect(str(DB), timeout=5)
    try:
        if read_only:
            c.execute("PRAGMA query_only = ON")
        else:
            _ensure_watch_schema(c)
    except BaseException:
        c.close()
        raise
    return c


def _ensure_watch_schema(c: sqlite3.Connection) -> None:
    c.execute(
        "CREATE TABLE IF NOT EXISTS watchlist "
        "(ts_code TEXT PRIMARY KEY, shares REAL DEFAULT 0, cost REAL DEFAULT 0, added_at TEXT)"
    )
    columns = {row[1] for row in c.execute("PRAGMA table_info(watchlist)").fetchall()}
    if "shares" not in columns:
        c.execute("ALTER TABLE watchlist ADD COLUMN shares REAL DEFAULT 0")
    if "cost" not in columns:
        c.execute("ALTER TABLE watchlist ADD COLUMN cost REAL DEFAULT 0")


def _watch_positions() -> dict[str, dict[str, float]]:
    """读取持仓；库/表不存在时返回空 dict（不产生任何写副作用）。"""
    if not DB.exists():
        return {}
    conn = _watch_connect(read_only=True)
    try:
        try:
            raws = conn.execute(
                "SELECT ts_code, shares, cost FROM watchlist ORDER BY added_at, ts_code"
            ).fetchall()
        except sqlite3.OperationalError as error:
            if "no such table" in str(error).lower():
                return {}
            raise
    finally:
        conn.close()
    return {row[0]: {"shares": row[1] or 0.0, "cost": row[2] or 0.0} for row in raws}


@app.get("/api/watchlist")
def watchlist():
    if request.headers.get(WATCHLIST_HEADER) != WATCHLIST_HEADER_VALUE:
        abort(403, f"missing {WATCHLIST_HEADER} header")
    pos = _watch_positions()
    if not pos:
        return jsonify([])
    codes = list(pos.keys())
    ph = ",".join("?" * len(codes))
    data = rows(
        f"""
        SELECT *
        FROM mart_stock_latest WHERE ts_code IN ({ph})
        """,
        codes,
    )
    present = {r["ts_code"] for r in data}
    data.extend(
        {"ts_code": code, "name": code, "market": None, "sw_l1": None, "close": None, "ret": None,
         "trade_date": None, "quote_date": None, "quote_missing": True}
        for code in codes if code not in present
    )
    # 按持仓顺序（added_at, ts_code）输出，避免 IN 查询结果顺序不确定。
    position = {code: index for index, code in enumerate(codes)}
    data.sort(key=lambda row: position.get(row["ts_code"], len(position)))
    for r in data:
        p = pos.get(r["ts_code"], {})
        r["shares"] = p.get("shares", 0.0)
        r["cost"] = p.get("cost", 0.0)
    return jsonify(data)


@app.post("/api/watchlist")
def add_watch():
    payload = _strict_payload({"ts_code", "shares", "cost"})
    code = _code_arg(str(payload.get("ts_code", "")).strip())
    shares = _quantity(payload.get("shares", 0), "shares", maximum=MAX_WATCH_SHARES)
    cost = _quantity(payload.get("cost", 0), "cost", maximum=MAX_WATCH_COST)
    conn = _watch_connect(read_only=False)
    try:
        conn.execute(
            """INSERT INTO watchlist (ts_code, shares, cost, added_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(ts_code) DO UPDATE SET shares=excluded.shares, cost=excluded.cost""",
            (code, shares, cost, datetime.now().isoformat()),
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.patch("/api/watchlist/<code>")
def patch_watch(code: str):
    _code_arg(code)
    payload = _strict_payload({"shares", "cost"})
    patch = {key: _quantity(payload[key], key, maximum=MAX_WATCH_SHARES if key == "shares" else MAX_WATCH_COST)
             for key in ("shares", "cost") if key in payload}
    if not patch:
        abort(400, "shares or cost required")
    conn = _watch_connect(read_only=False)
    try:
        if not conn.execute("SELECT 1 FROM watchlist WHERE ts_code=?", (code,)).fetchone():
            abort(404, "watch item not found")
        if "shares" in patch:
            conn.execute("UPDATE watchlist SET shares = ? WHERE ts_code = ?", (patch["shares"], code))
        if "cost" in patch:
            conn.execute("UPDATE watchlist SET cost = ? WHERE ts_code = ?", (patch["cost"], code))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.delete("/api/watchlist/<code>")
def del_watch(code: str):
    _code_arg(code)
    conn = _watch_connect(read_only=False)
    try:
        conn.execute("DELETE FROM watchlist WHERE ts_code = ?", (code,))
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/rotation")
def rotation():
    return jsonify(
        rows(
            """
            SELECT trade_date::VARCHAR AS trade_date, rotation_intensity, n_sectors
            FROM mart_rotation_day
            WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 3 YEAR FROM mart_rotation_day)
            ORDER BY trade_date
            """
        )
    )


@app.get("/api/sector-ranks")
def sector_ranks():
    return jsonify(
        rows(
            """
            SELECT trade_date::VARCHAR AS trade_date, sw_l1, rank20, ret20
            FROM mart_sector_rank
            WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 1 YEAR FROM mart_sector_rank)
            ORDER BY trade_date, sw_l1
            """
        )
    )


@app.get("/api/limit-quality")
def limit_quality():
    return jsonify(
        rows(
            """
            SELECT trade_date::VARCHAR AS trade_date, fd_ratio, open_share, avg_open_times, n_limit_up
            FROM mart_limit_quality
            WHERE trade_date >= (SELECT max(trade_date) - INTERVAL 400 DAY FROM mart_limit_quality)
            ORDER BY trade_date
            """
        )
    )


@app.get("/api/updates")
def updates():
    import glob

    out = []
    for p in sorted(glob.glob(str(META / "update_*.json")), reverse=True)[:30]:
        try:
            d = json.loads(Path(p).read_text(encoding="utf-8"))
            out.append(
                {
                    "date": Path(p).stem.replace("update_", ""),
                    "status": d.get("status"),
                    "days": len(d.get("days", [])),
                    "duration": d.get("duration_sec"),
                    "warnings": len(d.get("warnings", [])),
                }
            )
        except Exception:
            continue
    return jsonify(out)


@app.get("/api/reconcile")
def reconcile():
    p = META / "reconcile.json"
    if not p.exists():
        return jsonify({})
    d = json.loads(p.read_text(encoding="utf-8"))
    return jsonify(
        {k: d.get(k) for k in ("generated_at", "days", "stocks", "pairs",
                               "mae_pp", "p95_pp", "max_pp", "share_gt_0_1pp")}
    )


@app.get("/api/valuation/<code>")
def valuation(code: str):
    _code_arg(code)
    data = rows(
        """
        SELECT trade_date, pe_ttm
        FROM feat_stock
        WHERE ts_code = ?
          AND trade_date >= (SELECT max(trade_date) - INTERVAL 3 YEAR FROM feat_stock)
        ORDER BY trade_date
        """,
        [code],
    )
    if not data:
        # 未知代码统一 null（与静态 payload `pe_percentile[code]` 的 undefined→null 对齐，
        # 避免前端把 {} 读成“有数据但字段缺失”）。
        return jsonify(None)
    latest = data[-1]
    last = latest["pe_ttm"]
    if last is None or not math.isfinite(last) or last <= 0:
        return jsonify({"pe": None, "pct": None, "n": 0, "quote_date": latest["trade_date"]})
    vals = [r["pe_ttm"] for r in data if r["pe_ttm"] is not None and math.isfinite(r["pe_ttm"]) and r["pe_ttm"] > 0]
    return jsonify(
        {"pe": round(last, 2), "pct": round(100 * sum(v <= last for v in vals) / len(vals)),
         "n": len(vals), "quote_date": latest["trade_date"]}
    )


@app.get("/api/quality")
def quality():
    p = META / "quality" / "latest.json"
    if not p.exists():
        # 缺失时返回 null，前端据真值判断展示“质量报告不可用”（不是空对象）。
        return jsonify(None)
    try:
        return jsonify(json.loads(p.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return jsonify(None)


@app.get("/api/health")
def health():
    n = one("SELECT count(*) n FROM mart_market_day")["n"]
    return jsonify({"ok": True, "rows": n})


# ------------------------------------------------------------------ static SPA
@app.get("/")
def index():
    if (DIST / "index.html").exists():
        return send_from_directory(DIST, "index.html")
    return jsonify({"app": "Ashare Radar", "api": "/api/meta"})


@app.get("/<path:path>")
def static_files(path: str):
    if path == "api" or path.startswith("api/"):
        abort(404, "unknown API endpoint")
    target = DIST / path
    if target.is_file():
        return send_from_directory(DIST, path)
    if (DIST / "index.html").exists():
        return send_from_directory(DIST, "index.html")
    abort(404)


if __name__ == "__main__":
    port = int(os.getenv("ASHARE_RADAR_PORT", "8000"))
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
