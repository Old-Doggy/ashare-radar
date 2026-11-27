"""从 Tushare API 构建 core 层（没有本地 parquet 快照时使用）。

用法：
    python -m pipeline.bootstrap_api --start 20240101
    python -m pipeline.bootstrap_api --start 20240101 --db data/lake.duckdb

说明：
- 每日请求7类数据，其中涨跌停事件分U/D/Z三次，另有4个指数请求；限频等待至少约2.45秒/日，网络耗时另计。
- `limit_list_d` 需要额外积分，无权限时自动跳过并记录 warning。
- 完成后运行 `python -m pipeline.build_marts` 生成 mart。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import duckdb
import pandas as pd

from . import settings
from .update_daily import DATASETS, fetch, insert, log, tushare_pro
from .update_daily import _checkpoint_schema, _checkpoint, _today
from .locking import publish_lock
from .quality_gates import run_gates
from .ratelimit import call as ts_call
from .ratelimit import default_limiter
from .ratelimit import is_permission_error
from .io_utils import atomic_write_json

# 指数代码：整段历史一次预拉取（4 次请求），避免逐日 4×N 次请求。
INDEX_CODES = ["000300.SH", "000905.SH", "000852.SH", "000001.SH"]
# auto 门禁作用域：最后 N 个交易日用发布门禁，更早的历史日使用 history 门禁。
PUBLISH_GATE_TAIL = 20
# 回放最近 N 个交易日（T+1 数据修正 / 尾部纠错）。
REPLAY_TAIL = 20

SCHEMA = {
    "core_trade_cal": """CREATE TABLE IF NOT EXISTS core_trade_cal (
        cal_date VARCHAR, trade_date DATE, pretrade_date VARCHAR, is_open INTEGER)""",
    "core_stock_meta": """CREATE TABLE IF NOT EXISTS core_stock_meta (
        ts_code VARCHAR, symbol VARCHAR, name VARCHAR, area VARCHAR, industry VARCHAR,
        market VARCHAR, exchange VARCHAR, list_status VARCHAR, list_date VARCHAR,
        delist_date VARCHAR, is_hs VARCHAR)""",
    "core_stock_day": """CREATE TABLE IF NOT EXISTS core_stock_day (
        ts_code VARCHAR, trade_date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
        pre_close DOUBLE, pct_chg DOUBLE, vol DOUBLE, amount DOUBLE, adj_factor DOUBLE,
        turnover_rate DOUBLE, turnover_rate_f DOUBLE, volume_ratio DOUBLE, pe_ttm DOUBLE,
        pb DOUBLE, total_mv DOUBLE, circ_mv DOUBLE, up_limit DOUBLE, down_limit DOUBLE,
        adj_close DOUBLE)""",
    "core_index_day": """CREATE TABLE IF NOT EXISTS core_index_day (
        ts_code VARCHAR, trade_date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
        pre_close DOUBLE, pct_chg DOUBLE, vol DOUBLE, amount DOUBLE)""",
    "core_limit_event": """CREATE TABLE IF NOT EXISTS core_limit_event (
        ts_code VARCHAR, trade_date DATE, industry VARCHAR, name VARCHAR, close DOUBLE,
        pct_chg DOUBLE, amount BIGINT, limit_amount DOUBLE, float_mv DOUBLE, total_mv DOUBLE,
        turnover_ratio DOUBLE, fd_amount DOUBLE, first_time VARCHAR, last_time VARCHAR,
        open_times BIGINT, up_stat VARCHAR, limit_times DOUBLE, is_up INTEGER,
        is_down INTEGER, is_broken INTEGER)""",
    "core_flow_day": """CREATE TABLE IF NOT EXISTS core_flow_day (
        ts_code VARCHAR, trade_date DATE, net_mf_amount DOUBLE, main_net_amount DOUBLE,
        total_buy_amount DOUBLE)""",
    "core_margin_day": """CREATE TABLE IF NOT EXISTS core_margin_day (
        trade_date DATE, exchange_id VARCHAR, rzye BIGINT, rzmre BIGINT, rzche BIGINT,
        rqye BIGINT, rzrqye BIGINT)""",
}

META_FIELDS = "ts_code,symbol,name,area,industry,market,exchange,list_status,list_date,delist_date,is_hs"


def _init(con: duckdb.DuckDBPyConnection) -> None:
    for sql in SCHEMA.values():
        con.execute(sql)


def _load_meta(pro, con: duckdb.DuckDBPyConnection) -> int:
    frames = []
    for status in ("L", "D", "P"):
        try:
            df = ts_call("stock_basic", lambda s=status: pro.stock_basic(
                exchange="", list_status=s, fields=META_FIELDS))
            if status == "L" and (df is None or df.empty):
                raise RuntimeError("listed stock metadata is empty")
            if df is not None and not df.empty:
                frames.append(df)
        except Exception as e:
            raise RuntimeError(f"stock_basic {status} unavailable; old metadata preserved") from e
    if not frames:
        raise RuntimeError("stock metadata unavailable")
    meta = pd.concat(frames, ignore_index=True).drop_duplicates("ts_code")
    for col in ("delist_date", "is_hs", "list_date"):
        meta[col] = meta[col].astype("string").fillna("")
    con.register("meta_df", meta)
    con.execute("DELETE FROM core_stock_meta WHERE ts_code IN (SELECT ts_code FROM meta_df)")
    con.execute(
        """
        INSERT INTO core_stock_meta
        SELECT ts_code, symbol, name, area, industry, market, exchange, list_status,
               list_date, delist_date, is_hs
        FROM meta_df
        WHERE ts_code NOT IN (SELECT ts_code FROM core_stock_meta)
        """
    )
    con.unregister("meta_df")
    return len(meta)


def _load_calendar(pro, con: duckdb.DuckDBPyConnection, start: str, end: str) -> list[str]:
    cal = ts_call("trade_cal", lambda: pro.trade_cal(exchange="SSE", start_date=start, end_date=end))
    if cal is None or cal.empty:
        raise RuntimeError("trade calendar unavailable")
    con.register("cal_df", cal)
    con.execute("DELETE FROM core_trade_cal WHERE cal_date IN (SELECT cal_date::VARCHAR FROM cal_df)")
    con.execute(
        """
        INSERT INTO core_trade_cal
        SELECT cal_date::VARCHAR, strptime(cal_date, '%Y%m%d')::DATE,
               pretrade_date::VARCHAR, is_open::INT
        FROM cal_df
        WHERE cal_date::VARCHAR NOT IN (SELECT cal_date FROM core_trade_cal)
        """
    )
    con.unregister("cal_df")
    return [
        r[0]
        for r in con.execute(
            "SELECT cal_date FROM core_trade_cal WHERE is_open = 1 AND cal_date BETWEEN ? AND ? ORDER BY cal_date",
            [start, end],
        ).fetchall()
    ]


def resolve_gate_scope(mode: str, day: str, index: int, total: int,
                       tail: int = PUBLISH_GATE_TAIL, today: str | None = None) -> str:
    """决定某一天的校验作用域。

    auto：只有「最近一年内、且位于区间最后 tail 个交易日」的日子用发布门禁
    （绝对样本量/行业覆盖等按当前市场口径）；更早的历史日（哪怕在区间末尾）用历史
    轻量门禁——否则回补 2016 年这种老区间时会被发布门禁误拦。显式传 publish/history
    则全程使用该作用域。
    """
    if mode in ("publish", "history"):
        return mode
    cutoff = datetime.strptime(today or _today(), "%Y%m%d").date() - timedelta(days=400)
    day_date = datetime.strptime(day, "%Y%m%d").date()
    return "publish" if day_date >= cutoff and total - index < tail else "history"


def _prefetch_indices(pro, con: duckdb.DuckDBPyConnection, start: str, end: str) -> int:
    """一次性拉取 4 个指数整段历史（4 次请求），替代“每个交易日 4 次”的逐日请求。"""
    d0 = datetime.strptime(start, "%Y%m%d").date()
    d1 = datetime.strptime(end, "%Y%m%d").date()
    total = 0
    for code in INDEX_CODES:
        try:
            df = ts_call("index_daily", lambda c=code: pro.index_daily(
                ts_code=c, start_date=start, end_date=end))
        except Exception as exc:
            log(f"index {code} prefetch failed: {type(exc).__name__}")
            continue
        if df is None or df.empty:
            log(f"index {code}: empty response")
            continue
        df = df.copy()
        df["trade_date"] = pd.to_datetime(df["trade_date"].astype(str), format="%Y%m%d").dt.date
        df = df[(df["ts_code"] == code) & df["trade_date"].between(d0, d1)]
        df = df.drop_duplicates(["ts_code", "trade_date"])
        if df.empty:
            continue
        con.register("tmp_idx", df)
        con.execute(
            """
            MERGE INTO core_index_day c USING tmp_idx t
            ON c.ts_code=t.ts_code AND c.trade_date=t.trade_date
            WHEN MATCHED THEN UPDATE SET open=t.open, high=t.high, low=t.low, close=t.close,
                pre_close=t.pre_close, pct_chg=t.pct_chg, vol=t.vol, amount=t.amount
            WHEN NOT MATCHED THEN INSERT (ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount)
                VALUES (t.ts_code,t.trade_date,t.open,t.high,t.low,t.close,t.pre_close,t.pct_chg,t.vol,t.amount)
            """
        )
        con.unregister("tmp_idx")
        total += len(df)
    log(f"indices prefetched: {total} rows for {len(INDEX_CODES)} codes")
    return total


# ---------------------------------------------------------------- 并行取数（写库仍单线程）
_worker_state = threading.local()
# 建库期间先建 trade_date 索引，让逐日校验查询在千万行表上仍走索引（毫秒级）。
EARLY_INDEX_SQL = ("CREATE INDEX IF NOT EXISTS idx_core_stock_day_trade_date "
                   "ON core_stock_day(trade_date)")
# 需要“按日整体替换”的表（重跑最近交易日时先删当日旧行）
DAY_TABLES = ("core_stock_day", "core_flow_day", "core_limit_event", "core_margin_day")


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(float(raw))
    except ValueError:
        return default
    return value


def _thread_pro():
    """每个工作线程一个 tushare client（独立 requests 会话），共享全局限速器。"""
    pro = getattr(_worker_state, "pro", None)
    if pro is None:
        pro = tushare_pro()
        _worker_state.pro = pro
    return pro


def _fetch_day(day: str, disabled: set[str], lock: threading.Lock) -> dict:
    """在线程中拉取一天的所有数据集；异常对象原样返回给主线程分类处理。"""
    pro = _thread_pro()
    out: dict = {}
    for ds in DATASETS:
        with lock:
            if ds in disabled:
                out[ds] = None
                continue
        try:
            df = fetch(pro, ds, day)
            out[ds] = df if df is not None and not df.empty else None
        except Exception as exc:  # 由主线程区分权限错误/瞬时错误/失败
            out[ds] = exc
    return out


def _summarize_warnings(warnings: list[str], limit: int = 60) -> list[str]:
    """把重复的按日警告合并成 `消息 ×N`，避免 status/payload 里塞上千条。"""
    import re
    from collections import Counter

    counter: Counter = Counter()
    for msg in warnings:
        key = re.sub(r"^\d{8}\s+", "", msg)
        counter[key] += 1
    out = [f"{msg} ×{count}" if count > 1 else msg for msg, count in counter.items()]
    if len(out) > limit:
        out = out[:limit] + [f"… 其余 {len(counter) - limit} 类警告已省略"]
    return out


def _delete_day(con: duckdb.DuckDBPyConnection, day_date) -> None:
    """重跑某交易日时删除旧行；新日期（绝大多数情况）直接跳过。"""
    for table in DAY_TABLES:
        cur = con.execute(f"DELETE FROM {table} WHERE trade_date=?", [day_date])
        try:
            cur.fetchall()   # 消费 DELETE 返回的行数，避免后续 register() 报错
        except Exception:
            pass


def _run(start: str, end: str, db_path: str | None = None, gate_scope: str = "auto",
         workers: int | None = None) -> dict:
    from .build_marts import SQL_VIEW
    end = end or _today()
    datetime.strptime(start, "%Y%m%d")
    datetime.strptime(end, "%Y%m%d")
    if start > end or end > _today():
        raise ValueError("无效的建库日期区间：--start 必须 <= --end 且 <= 今天（格式 YYYYMMDD）")
    con = duckdb.connect(db_path or str(settings.LAKE))
    total = 0
    warnings: list[str] = []
    sources_by_date = {}
    try:
        _init(con)
        _checkpoint_schema(con)
        pro = tushare_pro()
        con.execute("BEGIN TRANSACTION")
        try:
            n_meta = _load_meta(pro, con)
            days = _load_calendar(pro, con, start, end)
            if not days:
                raise RuntimeError("bootstrap interval has no verified trading days")
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        bridge = (settings.ROOT / "config" / "industry_bridge.csv").as_posix().replace("'", "''")
        con.execute(SQL_VIEW.format(bridge=bridge))
        log(f"meta={n_meta} trading_days={len(days)} range={start}..{end}")
        workers = max(1, min(8, workers if workers else _env_int("TUSHARE_BOOTSTRAP_WORKERS", 3)))
        per_day_calls = len(DATASETS) + 1  # 数据集 + 指数（指数已预拉取，作为估算上界）
        limit_per_min = default_limiter().global_per_min
        est_min = len(days) * per_day_calls / max(1, limit_per_min)
        log(f"取数并发={workers}（--workers 可调，1=串行；环境变量 TUSHARE_BOOTSTRAP_WORKERS）")
        log(f"预计约 {est_min:.0f} 分钟起（限速 {limit_per_min} 次/分钟；网络慢会更久；"
            "可 Ctrl+C 后重跑同一条命令续跑）")
        log(f"门禁作用域：最后 {PUBLISH_GATE_TAIL} 个交易日=发布门禁，更早历史日=历史轻量门禁"
            f"（--gate-scope {gate_scope}）")
        log("预拉取 4 个指数整段历史（4 次请求，替代逐日 4 次）...")
        _prefetch_indices(pro, con, start, end)
        con.execute(EARLY_INDEX_SQL)
        completed = {
            row[0]: row[1]
            for row in con.execute(
                """SELECT strftime(trade_date,'%Y%m%d') d, count(DISTINCT dataset) n
                   FROM core_dataset_checkpoint WHERE completed
                     AND dataset IN ('daily','daily_basic','adj_factor','stk_limit')
                   GROUP BY trade_date""").fetchall()
        }
        tasks = [(i, day) for i, day in enumerate(days, 1)
                 if completed.get(day, 0) < 4 or i > len(days) - REPLAY_TAIL]
        log(f"待拉取 {len(tasks)}/{len(days)} 个交易日（已完成检查点自动跳过）")
        started = time.time()
        disabled: set[str] = set()   # 无权限的数据集：跳过后续请求，避免反复烧配额
        disabled_lock = threading.Lock()
        coverage_below_publish = 0
        processed = 0
        required = ("daily", "daily_basic", "adj_factor", "stk_limit")

        def store_day(i: int, day: str, fetched: dict) -> None:
            nonlocal total, processed, coverage_below_publish
            day_date = datetime.strptime(day, "%Y%m%d").date()
            frames: dict = {}
            day_sources: dict = {}
            for ds in DATASETS:
                value = fetched.get(ds)
                if isinstance(value, BaseException):
                    if ds in required:
                        raise RuntimeError(
                            f"{day} required {ds} failed: {type(value).__name__}") from value
                    if is_permission_error(value):
                        with disabled_lock:
                            newly = ds not in disabled
                            disabled.add(ds)
                        if newly:
                            warnings.append(f"{ds}: 无权限/积分不足，已跳过该接口的后续所有交易日")
                    else:
                        warnings.append(f"{day} {ds}: {type(value).__name__}")
                    day_sources[ds] = "unavailable"
                    continue
                if value is None:
                    if ds in required:
                        raise RuntimeError(f"{day} required {ds} failed: empty response")
                    warnings.append(f"{day} {ds}: unavailable (empty response)")
                    day_sources[ds] = "unavailable"
                    continue
                frames[ds] = value
                day_sources[ds] = "tushare"
            con.execute("BEGIN TRANSACTION")
            transaction_active = True
            try:
                existing = con.execute(
                    "SELECT count(*) FROM core_stock_day WHERE trade_date=?", [day_date]).fetchone()[0]
                if existing:
                    _delete_day(con, day_date)
                affected = 0
                for ds, df in frames.items():
                    affected += insert(con, ds, df, day, replace=True)
                    _checkpoint(con, day, ds, "tushare")
                n_indices = con.execute(
                    "SELECT count(DISTINCT ts_code) FROM core_index_day WHERE trade_date=?",
                    [day_date]).fetchone()[0]
                day_sources["index"] = "tushare" if n_indices == 4 else "incomplete"
                prev = con.execute(
                    "SELECT max(cal_date) FROM core_trade_cal WHERE is_open=1 AND cal_date<?",
                    [day]).fetchone()[0]
                scope = resolve_gate_scope(gate_scope, day, i, len(days))
                gate = run_gates(con, day, prev, persist=False, scope=scope)
                if not gate["passed"]:
                    details = "; ".join(
                        f"gate{g['id']} {g['name']}={g['value']}"
                        for g in gate["gates"] if g["pass"] is False and g["level"] == "block")
                    raise RuntimeError(
                        f"{day}（{scope} scope）quality gates failed: {gate['blocking']} [{details}]")
                warnings.extend(f"{day}: gate {g['id']} {g['name']}" for g in gate["gates"]
                                if g["pass"] is False and g["level"] == "warn")
                gate5 = next((g for g in gate["gates"] if g["id"] == 5), None)
                if (scope == "history" and gate5 is not None
                        and isinstance(gate5.get("value"), (int, float))
                        and gate5["value"] < settings.GATE_MIN_COVERAGE):
                    coverage_below_publish += 1
                con.execute("COMMIT")
                transaction_active = False
            except BaseException:
                if transaction_active:
                    con.execute("ROLLBACK")
                raise
            total += affected
            sources_by_date[day] = day_sources
            atomic_write_json(settings.META / "quality" / f"{day}.json", gate)
            atomic_write_json(settings.META / "quality" / "latest.json", gate)
            processed += 1
            if processed <= 2 or processed % 20 == 0 or processed == len(tasks):
                elapsed = time.time() - started
                stats = default_limiter().stats()
                calls = stats["requests"]
                rate_min = calls / elapsed * 60 if elapsed else 0.0
                remaining = max(0, len(tasks) - processed)
                calls_per_day = calls / processed if processed else per_day_calls
                eta = remaining * calls_per_day / max(1e-6, calls / elapsed) if elapsed else 0
                log(f"{processed}/{len(tasks)} days (i={i}/{len(days)}), rows={total:,}, "
                    f"requests={calls}, {rate_min:.0f}/min, elapsed={elapsed:.0f}s, eta={eta:.0f}s")

        if workers <= 1 or len(tasks) <= 1:
            for i, day in tasks:
                store_day(i, day, _fetch_day(day, disabled, disabled_lock))
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                pending: deque = deque()
                cursor = 0

                def submit_more() -> None:
                    nonlocal cursor
                    while cursor < len(tasks) and len(pending) < workers * 2:
                        i2, day2 = tasks[cursor]
                        cursor += 1
                        pending.append((i2, day2, pool.submit(
                            _fetch_day, day2, disabled, disabled_lock)))

                submit_more()
                try:
                    while pending:
                        i2, day2, future = pending.popleft()
                        store_day(i2, day2, future.result())
                        submit_more()
                except BaseException:
                    for _, _, fut in pending:
                        fut.cancel()
                    raise
        if coverage_below_publish:
            warnings.append(
                f"{coverage_below_publish} 个历史交易日上游字段覆盖率低于发布阈值 "
                f"{settings.GATE_MIN_COVERAGE:.0%}（history 门禁以 95% 为阻断下限，属上游覆盖限制）")
        warning_summary = _summarize_warnings(warnings)
        result = {"status": "ok", "days": len(days), "inserted_rows_sum_datasets": total,
                  "affected_rows": total,
                  "warnings": warning_summary, "warnings_raw_count": len(warnings),
                  "sources_by_date": sources_by_date,
                  "rate": default_limiter().stats(),
                  "skipped_datasets": sorted(disabled),
                  "workers": workers,
                  "gate_scope_mode": gate_scope,
                  "history_days_below_publish_coverage": coverage_below_publish}
        log(f"[bootstrap] 完成：{len(days)} 个交易日，请求 {result['rate']['requests']} 次，"
            f"限速等待 {result['rate']['waited_sec']}s，耗时 {time.time() - started:.0f}s；"
            f"无权限集合={sorted(disabled) or '无'}；历史日覆盖率<99% 天数={coverage_below_publish}")
        atomic_write_json(settings.META / "bootstrap.json", result)
        atomic_write_json(settings.META / "status.json", {
            "status": "ok", "last_trade_date": days[-1] if days else None,
            "sources": sources_by_date.get(days[-1], {}) if days else {}, "warnings": warning_summary,
            "skipped_datasets": sorted(disabled)})
        return result
    finally:
        con.close()


def run(start: str, end: str, db_path: str | None = None, gate_scope: str = "auto",
        workers: int | None = None) -> dict:
    with publish_lock():
        try:
            result = _run(start, end, db_path, gate_scope, workers)
        except Exception:
            from . import alerts
            alerts.write("bootstrap", "API建库未完成，请检查本机日志并重试同一区间")
            atomic_write_json(settings.META / "status.json", {
                "status": "failed", "warnings": ["bootstrap incomplete; retry the same date interval"]})
            raise
        # A completed bootstrap is a clean state: drop any stale failure alert.
        from . import alerts
        alerts.clear()
        return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="20240101", help="起始日期 YYYYMMDD")
    ap.add_argument("--end", default=_today())
    ap.add_argument("--db", default=None, help="目标 DuckDB（默认 data/lake.duckdb）")
    ap.add_argument("--gate-scope", choices=["auto", "publish", "history"],
                    default=os.getenv("ASHARE_RADAR_GATE_SCOPE", "auto"),
                    help="auto=最后 20 个交易日用发布门禁、更早用历史门禁（默认）")
    ap.add_argument("--workers", type=int, default=None,
                    help="并行取数线程数（默认 3；1=串行；建议不超过 8）")
    args = ap.parse_args()
    # 先打印一眼能看到的启动信息：否则命令若立刻返回，用户无法判断是否真的执行了。
    print(f"[bootstrap_api] python = {sys.executable}", flush=True)
    print(f"[bootstrap_api] range = {args.start}..{args.end}; db = {args.db or settings.LAKE}", flush=True)
    print(f"[bootstrap_api] 门禁作用域 = {args.gate_scope}"
          "（auto：最后 20 个交易日用发布门禁，更早历史日按历史门禁）", flush=True)
    if settings.TUSHARE_TOKEN:
        print("[bootstrap_api] TUSHARE_TOKEN = 已配置", flush=True)
    else:
        print("[bootstrap_api] TUSHARE_TOKEN = 未配置：请复制 .env.example 为 .env 并填写 token", flush=True)
    limits = default_limiter().stats()["limits"]
    print(f"[bootstrap_api] 限速：全局 {limits['global_per_min']} 次/分钟；"
          f"limit_list_d {limits['per_api_per_min'].get('limit_list_d', '默认')} 次/分钟"
          f"（日预算 {limits['daily_total'].get('limit_list_d', '默认')}）；"
          f"最小间隔 {limits['min_interval_sec']}s（可用环境变量覆盖，见 docs/rate_limits.md）",
          flush=True)
    try:
        result = run(args.start, args.end, args.db, args.gate_scope, args.workers)
    except Exception as exc:
        print(f"[bootstrap_api] 失败：{type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        if isinstance(exc, ValueError):
            print("[bootstrap_api] 检查 --start/--end：格式 YYYYMMDD、start <= end、end <= 今天",
                  file=sys.stderr, flush=True)
        else:
            print("[bootstrap_api] 排查顺序：", file=sys.stderr, flush=True)
            print("  1) python -c \"import sys, duckdb, tushare, flask; print(sys.executable)\" 是否成功", file=sys.stderr, flush=True)
            print("  2) where.exe python 是否指向装了依赖的环境（不要用 Windows 应用商店占位程序）", file=sys.stderr, flush=True)
            print("  3) 项目根目录 .env 是否已填 TUSHARE_TOKEN", file=sys.stderr, flush=True)
        raise SystemExit(2)
    print(json.dumps(result, ensure_ascii=False, indent=1, default=str), flush=True)
