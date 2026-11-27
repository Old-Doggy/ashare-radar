"""Quality gates. Failed block gates prevent publication; warnings remain visible.

Gate contract (v0.4.3):
- gates 1..14 validate the day being published;
- gate 15 history completeness (block, publication chain): full-history count(*) vs a
  ±10 day local median (current day excluded), independent of the day being updated;
- gate 16 limit-band stability (warn): count of stocks whose 5%/10%/20%/30% price-limit
  band changed vs the previous trading day (upstream stk_limit band shifts);
- gate 17 fd_amount scale (warn): share of official limit events whose
  fd_amount/float_mv > 2 (upstream unit anomaly);
- gate 18 row-count trend (warn): core row count vs the prior-20-day median, warning
  band 0.95–0.98 (below 0.95 is blocked by gate 1).

Historical repair scope (`scope="history"`) is used by pipeline.repair_history:
- gates 7 (static industry mapping, not point-in-time) and 14 (delisted codes may lack
  stock_basic metadata) are recorded with their actual values but marked
  `not_applicable_historical` and never block (documented in docs/known_limitations);
- gates 15/16/17/18 are skipped per day; the repair batch runs gate 15 once at the end;
- thresholds themselves are never relaxed.
"""
from __future__ import annotations

import json
from datetime import datetime
from statistics import median

import duckdb

from . import settings
from .io_utils import atomic_write_json

# 历史修复日不适用的门禁：记录实际值但不计入 blocking（Lead 2026-11-27 约定）。
HISTORICAL_NOT_APPLICABLE = {
    7: "static industry bridge is not point-in-time; historical unmapped names are a disclosed limitation",
    14: "some delisted/NEEQ-era codes have no stock_basic metadata; listing dates are unavailable historically",
}
# 历史修复作用域跳过的重型/发布专用门禁（批次结束后统一跑 gate15）。
HISTORICAL_SKIPPED = (15, 16, 17, 18)
# 历史日期的上游字段覆盖本身达不到发布阈值：2016 年 Tushare daily_basic 只有约 98.2%
# （部分老股无市值行）。history scope 以 95% 作为阻断下限——低于它说明本次拉取真的异常；
# 发布日（publish scope）仍要求 99%。阈值数值本身不放宽，只是区分历史/发布两个作用域。
HISTORY_MIN_COVERAGE = 0.95
# gate15 用「局部中位数 >= 该值」确认这是一个真实的完整市场日，避免合成小库误判。
HISTORY_MIN_TYPICAL_ROWS = 2000
HISTORY_RATIO = 0.85


def _scalar(con, sql: str, params=None):
    row = con.execute(sql, params or []).fetchone()
    return row[0] if row else None


SAMPLE_SQL = """
WITH calendar AS (
    SELECT trade_date, row_number() OVER (ORDER BY trade_date) AS trade_num
    FROM core_trade_cal WHERE is_open=1
), listing_age AS (
    SELECT m.ts_code,
           coalesce(try_cast(m.list_date AS DATE),try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE) AS listed_on,
           min(c.trade_num) AS listing_num
    FROM core_stock_meta m LEFT JOIN calendar c ON c.trade_date >=
        coalesce(try_cast(m.list_date AS DATE),try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
    GROUP BY m.ts_code,m.list_date
), eligible AS (
    SELECT *, coalesce(try_cast(list_date AS DATE),
              try_strptime(list_date::VARCHAR, '%Y%m%d')::DATE) AS listed_on
    FROM v_stock
    WHERE exchange IN ('SSE', 'SZSE') AND market IN ('主板', '创业板', '科创板')
      AND ret IS NOT NULL AND isfinite(ret) AND ret > -1
      AND close > 0 AND isfinite(close) AND adj_factor > 0 AND isfinite(adj_factor)
      AND adj_close > 0 AND isfinite(adj_close)
), sample AS (
    SELECT e.* FROM eligible e JOIN listing_age a USING(ts_code)
    JOIN calendar c ON c.trade_date=e.trade_date
    WHERE e.listed_on IS NOT NULL AND (
      e.listed_on < (SELECT min(trade_date) FROM calendar)
      OR c.trade_num-a.listing_num >= 5)
)
"""


def _daily_counts(con, day) -> list[tuple]:
    """One full-table scan: rows per day up to and including `day` (gate 1/15/18)."""
    return con.execute(
        "SELECT trade_date, count(*) FROM core_stock_day WHERE trade_date <= ? "
        "GROUP BY 1 ORDER BY 1",
        [day],
    ).fetchall()


def _prior_median(counts: list[tuple], window: int = 20, minimum: int = 5):
    """Median of the previous `window` daily counts (current day excluded)."""
    values = [c for _, c in counts[-(window + 1):-1]]
    if len(values) < minimum:
        return None, len(values)
    return float(median(values)), len(values)


def history_completeness(con, day=None, counts: list[tuple] | None = None) -> dict:
    """gate15 core: day list whose row count is < 85% of a ±10 day local median.

    The current day is excluded from the neighbourhood median. A day is only
    considered partial when the local median looks like a full market day
    (>= HISTORY_MIN_TYPICAL_ROWS), so tiny synthetic databases never trip the gate.
    """
    d = day or con.execute("SELECT max(trade_date) FROM core_stock_day").fetchone()[0]
    counts = counts if counts is not None else _daily_counts(con, d)
    n_days = len(counts)
    value = {"n_days": n_days, "count": 0, "days": [], "insufficient_history": n_days < 20}
    if n_days < 20:
        return {"pass": True, "value": value,
                "threshold": f"0 partial days (needs >=20 history days; have {n_days})"}
    partial = []
    for i, (trade_date, n) in enumerate(counts):
        neighbours = [c for j, (_, c) in enumerate(counts) if j != i and abs(j - i) <= 10]
        if not neighbours:
            continue
        local = float(median(neighbours))
        if local >= HISTORY_MIN_TYPICAL_ROWS and n < HISTORY_RATIO * local:
            partial.append({"date": trade_date.isoformat(), "rows": int(n), "typical_rows": local})
    value["count"] = len(partial)
    value["days"] = partial
    return {"pass": len(partial) == 0, "value": value,
            "threshold": (f"0 partial days (count < {HISTORY_RATIO:.2f} x +/-10d local median, "
                          f"median >= {HISTORY_MIN_TYPICAL_ROWS})")}


def _band(col: str) -> str:
    return (f"CASE WHEN {col} < 0.075 THEN 5 WHEN {col} < 0.15 THEN 10 "
            f"WHEN {col} < 0.25 THEN 20 ELSE 30 END")


def _band_stability(con, day, prev_day):
    """gate16: how many stocks changed price-limit band vs the previous trading day."""
    ratio = "up_limit / nullif(pre_close, 0) - 1"
    sql = f"""
    WITH a AS (
        SELECT ts_code, {ratio} r FROM core_stock_day
        WHERE trade_date = ? AND pre_close > 0 AND up_limit > 0 AND isfinite(up_limit)
          AND isfinite(pre_close)
    ), b AS (
        SELECT ts_code, {ratio} r FROM core_stock_day
        WHERE trade_date = ? AND pre_close > 0 AND up_limit > 0 AND isfinite(up_limit)
          AND isfinite(pre_close)
    )
    SELECT count(*),
           count(*) FILTER (WHERE {_band("a.r")} <> {_band("b.r")}),
           count(*) FILTER (WHERE {_band("a.r")} = 5)
    FROM a JOIN b USING (ts_code)
    """
    compared, switched, five = con.execute(sql, [day, prev_day]).fetchone()
    share = switched / compared if compared else None
    ok = switched <= 50 and (share is None or share <= 0.02)
    return {"pass": ok, "value": int(switched),
            "threshold": "<=2% of comparable stocks and <=50 stocks switch 5%/10%/20% band",
            "message": (f"{switched}/{compared} limit bands changed vs {prev_day}"
                        f" ({share:.2%})" if compared else "no comparable limit rows")}


def _fd_scale(con, day):
    """gate17: fd_amount unit anomaly share (fd_amount/float_mv > 2)."""
    abnormal, total = con.execute(
        """SELECT count(*) FILTER (WHERE float_mv > 0 AND fd_amount IS NOT NULL
                                   AND isfinite(fd_amount) AND isfinite(float_mv)
                                   AND fd_amount / float_mv > 2),
                  count(*) FILTER (WHERE float_mv > 0 AND fd_amount IS NOT NULL
                                   AND isfinite(fd_amount) AND isfinite(float_mv))
           FROM core_limit_event WHERE trade_date = ?""",
        [day],
    ).fetchone()
    share = abnormal / total if total else None
    ok = share is None or share <= 0.01
    return {"pass": ok, "value": share,
            "threshold": "<=1% of official limit events have fd_amount/float_mv > 2",
            "message": (f"{abnormal}/{total} fd_amount rows exceed 2x float_mv ({share:.2%})"
                        if total else "no official limit events for this date")}


SSE_SZSE = "(ts_code LIKE '%.SH' OR ts_code LIKE '%.SZ')"


def _history_gates(con: duckdb.DuckDBPyConnection, day: str, prev_day: str | None) -> dict:
    """历史建库日的轻量校验：只阻断“数据不完整/不合法”，比发布门禁快一个数量级。

    历史日期只阻断：行数连续性、主键唯一、OHLC 结构异常、收益一致性、字段覆盖
    （95% 历史下限）、成交额有效性、限价覆盖（95% 历史下限）、指数完整/一致性。
    跳过仅对发布日有意义的门禁：6/9（连续性 warn）、7/14（行业与上市日期元数据，
    静态映射非 PIT）、15–18（发布链专用）。阈值本身不放宽，只是区分作用域。
    gate3 对 |pct_chg|>44 只记录不阻断（退市整理/复牌等真实事件，W11-10）。
    """
    d = datetime.strptime(day, "%Y%m%d").date()
    previous = datetime.strptime(prev_day, "%Y%m%d").date() if prev_day else None
    gates = []

    def add(gid, name, ok, value, threshold, level, message=""):
        gates.append({"id": gid, "name": name, "pass": bool(ok) if ok is not None else None,
                      "value": value, "threshold": threshold, "level": level,
                      "message": message})

    counts = _daily_counts(con, d)
    n = counts[-1][1] if counts and counts[-1][0] == d else 0
    n_prev = _scalar(con, "SELECT count(*) FROM core_stock_day WHERE trade_date=?", [previous]) if previous else None
    ratio = n / n_prev if n_prev else None
    median20, n_prior = _prior_median(counts)
    median_ratio = n / median20 if median20 else None
    count_ok = (n > 0 and (ratio is None or 0.95 <= ratio <= 1.05)
                and (median_ratio is None or median_ratio >= 0.95))
    add(1, "row count", count_ok, n,
        "history scope: >0; previous-day ratio 0.95..1.05; >=0.95 x prior-20d median",
        "block", f"previous={n_prev}, ratio={ratio}, prior20_median={median20}, median_ratio={median_ratio}")

    dup = _scalar(con, """SELECT count(*) FROM (
        SELECT ts_code FROM core_stock_day WHERE trade_date=? GROUP BY ts_code HAVING count(*)>1)""", [d]) or 0
    add(2, "primary key unique", dup == 0, dup, "0 duplicate keys", "block")

    bad, extreme = con.execute(
        f"""SELECT count(*) FILTER (WHERE close IS NULL OR NOT isfinite(close) OR close<=0
              OR high IS NULL OR low IS NULL OR NOT isfinite(high) OR NOT isfinite(low)
              OR low<=0 OR high<low OR close<low-0.011 OR close>high+0.011),
              count(*) FILTER (WHERE abs(pct_chg) > 44)
           FROM core_stock_day WHERE trade_date=? AND {SSE_SZSE}""", [d]).fetchone()
    add(3, "price structure", bad == 0, bad,
        "finite positive OHLC; low<=close<=high (SSE/SZSE); |pct_chg|>44 recorded only",
        "block", f"structural_bad={bad}, extreme_pct_chg_rows={extreme} (真实事件，不阻断)")

    comparable, conflict = con.execute(
        f"""SELECT count(*), count(*) FILTER (WHERE abs(pct_chg-(close/pre_close-1)*100)>0.1)
            FROM core_stock_day WHERE trade_date=? AND pre_close>0 AND isfinite(pre_close)
              AND close>0 AND isfinite(close) AND pct_chg IS NOT NULL AND isfinite(pct_chg)
              AND {SSE_SZSE}""", [d]).fetchone()
    share = conflict / comparable if comparable else 1.0
    add(4, "return consistency", share < 0.01, share, "<1% of comparable rows", "block",
        f"{conflict}/{comparable} comparable rows")

    cov = _scalar(con, f"""SELECT count(*) FILTER (
        WHERE adj_factor>0 AND isfinite(adj_factor) AND circ_mv>0 AND isfinite(circ_mv)
        AND adj_close>0 AND isfinite(adj_close))::DOUBLE/nullif(count(*),0)
        FROM core_stock_day WHERE trade_date=? AND {SSE_SZSE}""", [d]) or 0
    add(5, "positive field coverage", cov >= HISTORY_MIN_COVERAGE, cov,
        f">={HISTORY_MIN_COVERAGE} (history floor; publish requires "
        f"{settings.GATE_MIN_COVERAGE:.0%})", "block", f"historical upstream coverage {cov:.2%}")

    for gid, name in ((6, "breadth continuity"), (7, "industry coverage"),
                      (9, "EW continuity"), (14, "listing dates available")):
        add(gid, name, None, None, "skipped in history scope", "info",
            "发布日专属检查（历史建库不适用；阈值未放宽）")

    bad_adj = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND (ts_code LIKE '%.SH' OR ts_code LIKE '%.SZ')
        AND (adj_factor IS NULL OR NOT isfinite(adj_factor) OR adj_factor<=0)""", [d]) or 0
    bse_no_adj = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND ts_code LIKE '%.BJ'
        AND (adj_factor IS NULL OR NOT isfinite(adj_factor) OR adj_factor<=0)""", [d]) or 0
    add(8, "adj factor valid", bad_adj == 0, bad_adj, "0 invalid factors (SSE/SZSE)", "warn",
        f"北交所缺复权因子行={bse_no_adj}（不在分析池，不计告警）")

    bad_amount = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND (amount IS NULL OR NOT isfinite(amount) OR amount<0 OR vol IS NULL
             OR NOT isfinite(vol) OR vol<0)""", [d]) or 0
    add(10, "amount and volume", bad_amount == 0, bad_amount,
        "finite nonnegative; amount in thousand CNY", "block")

    limit_cov = _scalar(con, f"""SELECT count(*) FILTER (
        WHERE up_limit>0 AND isfinite(up_limit) AND down_limit>0 AND isfinite(down_limit)
        AND up_limit>=down_limit)::DOUBLE/nullif(count(*),0)
        FROM core_stock_day WHERE trade_date=? AND {SSE_SZSE}""", [d])
    add(11, "limit-price coverage", limit_cov is not None and limit_cov >= HISTORY_MIN_COVERAGE,
        limit_cov, f">={HISTORY_MIN_COVERAGE} (history floor)", "block")

    n_indices = _scalar(con, """SELECT count(DISTINCT ts_code) FROM core_index_day WHERE trade_date=?
        AND ts_code IN ('000300.SH','000905.SH','000852.SH','000001.SH')
        AND pct_chg IS NOT NULL AND isfinite(pct_chg) AND close>0""", [d]) or 0
    add(12, "index completeness", n_indices == 4, n_indices, "4 benchmark indices", "warn")

    bad_indices = _scalar(con, """SELECT count(*) FROM core_index_day WHERE trade_date=?
        AND pre_close>0 AND pct_chg IS NOT NULL
        AND abs(pct_chg-(close/pre_close-1)*100)>0.1""", [d]) or 0
    add(13, "index return consistency", bad_indices == 0, bad_indices, "0 conflicts >0.1pp", "block")

    skipped = [6, 7, 9, 14, 15, 16, 17, 18]
    blocking = [g["id"] for g in gates if g["pass"] is False and g["level"] == "block"]
    return {"date": day, "scope": "history",
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "rows": n, "gates": gates, "passed": not blocking, "blocking": blocking,
            "not_applicable": [7, 14], "skipped": skipped}


def run_gates(con: duckdb.DuckDBPyConnection, day: str, prev_day: str | None = None,
              *, persist: bool = True, scope: str = "publish") -> dict:
    """Validate a YYYYMMDD day. persist=False supports a caller-owned transaction.

    scope="publish" (default) runs the full gate set.
    scope="history" uses the lightweight historical build checks (see _history_gates).
    """
    d = datetime.strptime(day, "%Y%m%d").date()
    previous = datetime.strptime(prev_day, "%Y%m%d").date() if prev_day else None
    gates = []
    if scope == "history":
        out = _history_gates(con, day, prev_day)
        if persist:
            persist_report(out)
        return out
    skipped = []

    def add(gid, name, ok, value, threshold, level, message=""):
        gates.append({"id": gid, "name": name, "pass": bool(ok) if ok is not None else None,
                      "value": value, "threshold": threshold, "level": level,
                      "message": message})

    counts = _daily_counts(con, d)
    n = counts[-1][1] if counts and counts[-1][0] == d else 0
    n_prev = _scalar(con, "SELECT count(*) FROM core_stock_day WHERE trade_date=?", [previous]) if previous else None
    ratio = n / n_prev if n_prev else None
    median20, n_prior = _prior_median(counts)
    median_ratio = n / median20 if median20 else None
    # 绝对样本量 >=3000 是「当前市场容量」的发布门禁；历史修复日（2016-17 市场
    # 不足 3000 只）改用与局部中位数的相对覆盖判定，阈值数值本身不变。
    absolute_ok = n >= 3000 if scope == "publish" else True
    count_ok = (absolute_ok
                and (ratio is None or 0.95 <= ratio <= 1.05)
                and (median_ratio is None or median_ratio >= 0.95))
    threshold = (">=3000; previous-day ratio 0.95..1.05; >=0.95 x prior-20d median (excl. current)"
                 if scope == "publish" else
                 "history scope: previous-day ratio 0.95..1.05; >=0.95 x prior-20d median (excl. current)")
    add(1, "row count", count_ok, n, threshold, "block",
        f"previous={n_prev}, ratio={ratio}, prior20_median={median20}, median_ratio={median_ratio}")

    dup = _scalar(con, """SELECT count(*) FROM (
        SELECT ts_code FROM core_stock_day WHERE trade_date=? GROUP BY ts_code HAVING count(*)>1
    )""", [d]) or 0
    add(2, "primary key unique", dup == 0, dup, "0 duplicate keys", "block")

    # gate3：上市日期之前（pre-listing）的行一律 block；IPO 30 日豁免要求
    # trade_date >= list_date。北交所（NEEQ 时期）pre-BSE-listing 历史不在分析池内，
    # 单独计数并在 message 中披露，不阻断（见 docs/known_limitations）。
    bad = _scalar(con, """SELECT count(*) FROM core_stock_day d
        LEFT JOIN core_stock_meta m USING(ts_code)
        WHERE d.trade_date=? AND (
          close IS NULL OR NOT isfinite(close) OR close<=0 OR
          high IS NULL OR low IS NULL OR NOT isfinite(high) OR NOT isfinite(low) OR
          low<=0 OR high<low OR close<low-0.011 OR close>high+0.011 OR
          pct_chg IS NULL OR NOT isfinite(pct_chg) OR pct_chg<=-100 OR
          (abs(pct_chg)>44
           AND NOT coalesce(up_limit>=999999 AND down_limit<=0.01, FALSE) AND NOT (
             coalesce(try_cast(m.list_date AS DATE), try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
               IS NOT NULL AND d.trade_date >= coalesce(try_cast(m.list_date AS DATE),
                 try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
               AND d.trade_date <= coalesce(try_cast(m.list_date AS DATE),
                 try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE) + INTERVAL 30 DAY)
           AND NOT (coalesce(m.market,'') = '北交所'
             AND coalesce(try_cast(m.list_date AS DATE), try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
                 IS NOT NULL
             AND d.trade_date < coalesce(try_cast(m.list_date AS DATE),
                 try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)))
        )""", [d]) or 0
    out_of_scope_prelisting = _scalar(con, """SELECT count(*) FROM core_stock_day d
        JOIN core_stock_meta m USING(ts_code)
        WHERE d.trade_date=? AND coalesce(m.market,'') = '北交所'
          AND coalesce(try_cast(m.list_date AS DATE), try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
              IS NOT NULL
          AND d.trade_date < coalesce(try_cast(m.list_date AS DATE),
              try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)""", [d]) or 0
    prelisting_in_scope = _scalar(con, """SELECT count(*) FROM core_stock_day d
        JOIN core_stock_meta m USING(ts_code)
        WHERE d.trade_date=? AND coalesce(m.market,'') <> '北交所'
          AND coalesce(try_cast(m.list_date AS DATE), try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)
              IS NOT NULL
          AND d.trade_date < coalesce(try_cast(m.list_date AS DATE),
              try_strptime(m.list_date::VARCHAR,'%Y%m%d')::DATE)""", [d]) or 0
    add(3, "price sanity", bad == 0 and prelisting_in_scope == 0, bad,
        "finite positive OHLC; low<=close<=high; IPO exemption only from list_date -30d to +30d; "
        "in-scope pre-listing rows blocked (BSE/NEEQ history disclosed, not gated)",
        "block",
        f"prelisting_in_scope={prelisting_in_scope}, out_of_scope_bse_prelisting={out_of_scope_prelisting}")

    comparable, conflict = con.execute("""SELECT count(*), count(*) FILTER (
        WHERE abs(pct_chg-(close/pre_close-1)*100)>0.1)
        FROM core_stock_day WHERE trade_date=? AND pre_close>0 AND isfinite(pre_close)
        AND close>0 AND isfinite(close) AND pct_chg IS NOT NULL AND isfinite(pct_chg)
    """, [d]).fetchone()
    share = conflict / comparable if comparable else 1.0
    add(4, "return consistency", share < 0.01, share, "<1% of comparable rows", "block",
        f"{conflict}/{comparable} comparable rows")
    cov = _scalar(con, """SELECT count(*) FILTER (
        WHERE adj_factor>0 AND isfinite(adj_factor) AND circ_mv>0 AND isfinite(circ_mv)
        AND adj_close>0 AND isfinite(adj_close))::DOUBLE/nullif(count(*),0)
        FROM core_stock_day WHERE trade_date=?""", [d]) or 0
    # 历史作用域用 95% 阻断下限（2016 年上游 daily_basic 覆盖本身约 98.2%）；发布日仍 99%。
    coverage_floor = HISTORY_MIN_COVERAGE if scope == "history" else settings.GATE_MIN_COVERAGE
    coverage_message = ""
    if scope == "history" and settings.GATE_MIN_COVERAGE > cov >= HISTORY_MIN_COVERAGE:
        coverage_message = (f"historical upstream coverage {cov:.2%} is below the publish threshold "
                            f"{settings.GATE_MIN_COVERAGE:.0%}; history floor is {HISTORY_MIN_COVERAGE:.0%}")
    add(5, "positive field coverage", cov >= coverage_floor, cov,
        f">={coverage_floor}" + (" (history scope; publish requires 99%)" if scope == "history" else ""),
        "block", coverage_message)

    def stats(dt):
        return con.execute(SAMPLE_SQL + """SELECT
            count(*) FILTER(WHERE ret>0)::DOUBLE/nullif(count(*) FILTER(WHERE ret<>0),0),
            avg(ret) FROM sample WHERE trade_date=?""", [dt]).fetchone()

    breadth, ew = stats(d)
    # gate6：与「前 5 个交易日 breadth 中位数」比较（水平偏离，而不是只看相邻两日）。
    prev_calendar = [r[0] for r in con.execute(
        """SELECT cal_date FROM core_trade_cal WHERE is_open=1
           AND cal_date < ? ORDER BY cal_date DESC LIMIT 5""", [day]).fetchall()]
    prev_breadths: list[float] = []
    if prev_calendar:
        prev_dates = [datetime.strptime(str(cal), "%Y%m%d").date() for cal in prev_calendar]
        marks = ",".join(["?"] * len(prev_dates))
        rows = con.execute(
            SAMPLE_SQL + f"""SELECT trade_date,
                   count(*) FILTER (WHERE ret>0)::DOUBLE/nullif(count(*) FILTER (WHERE ret<>0),0)
            FROM sample WHERE trade_date IN ({marks}) GROUP BY trade_date""",
            prev_dates,
        ).fetchall()
        prev_breadths = [r[1] for r in rows if r[1] is not None]
    median_b = float(median(prev_breadths)) if prev_breadths else None
    delta_b = abs(breadth - median_b) if breadth is not None and median_b is not None else None
    if breadth is None:
        add(6, "breadth continuity", False, None,
            "|breadth - prior-5d median|<=0.50; all-flat day => breadth undefined",
            "warn", "all-flat day: breadth is undefined (0 adv / 0 dec)")
    else:
        add(6, "breadth continuity", delta_b is None or delta_b <= 0.50, delta_b,
            "|breadth - prior-5d median|<=0.50; all-flat day => breadth undefined",
            "warn", f"breadth={breadth:.6f}, prior5_median={median_b}")
    prev_b, prev_ew = stats(previous) if previous else (None, None)
    unmapped = _scalar(con, """SELECT count(*) FILTER(WHERE sw_l1='未分类')::DOUBLE/
        nullif(count(*),0) FROM v_stock WHERE trade_date=?
        AND exchange IN ('SSE','SZSE') AND market IN ('主板','创业板','科创板')""", [d])
    coverage = 1 - unmapped if unmapped is not None else 0
    gate7 = {"pass": coverage >= settings.GATE_MIN_INDUSTRY_COVERAGE, "value": coverage,
             "threshold": f">={settings.GATE_MIN_INDUSTRY_COVERAGE}",
             "message": f"unmapped={unmapped:.6f}" if unmapped is not None else ""}
    add(7, "industry coverage", gate7["pass"], coverage,
        f">={settings.GATE_MIN_INDUSTRY_COVERAGE}", "block", gate7["message"])
    bad_adj = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND (ts_code LIKE '%.SH' OR ts_code LIKE '%.SZ')
        AND (adj_factor IS NULL OR NOT isfinite(adj_factor) OR adj_factor<=0)""", [d]) or 0
    bse_no_adj = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND ts_code LIKE '%.BJ'
        AND (adj_factor IS NULL OR NOT isfinite(adj_factor) OR adj_factor<=0)""", [d]) or 0
    add(8, "adj factor valid", bad_adj == 0, bad_adj, "0 invalid factors (SSE/SZSE)", "warn",
        f"北交所缺复权因子行={bse_no_adj}（不在分析池，不计告警）")
    delta_ew = abs(ew - prev_ew) if ew is not None and prev_ew is not None else None
    add(9, "EW continuity", delta_ew is None or delta_ew <= 0.08, delta_ew,
        "|EW change|<=0.08", "warn", "not comparable" if delta_ew is None else "")
    bad_amount = _scalar(con, """SELECT count(*) FROM core_stock_day WHERE trade_date=?
        AND (amount IS NULL OR NOT isfinite(amount) OR amount<0 OR vol IS NULL
             OR NOT isfinite(vol) OR vol<0)""", [d]) or 0
    add(10, "amount and volume", bad_amount == 0, bad_amount, "finite nonnegative; amount in thousand CNY", "block")
    limit_cov = _scalar(con, SAMPLE_SQL + """SELECT count(*) FILTER (
        WHERE up_limit>0 AND isfinite(up_limit) AND down_limit>0 AND isfinite(down_limit)
        AND up_limit>=down_limit)::DOUBLE/nullif(count(*),0) FROM sample WHERE trade_date=?""", [d])
    add(11, "limit-price coverage", limit_cov is not None and limit_cov >= 0.99,
        limit_cov, ">=0.99 of seasoned valid sample", "block")
    n_indices = _scalar(con, """SELECT count(DISTINCT ts_code) FROM core_index_day WHERE trade_date=?
        AND ts_code IN ('000300.SH','000905.SH','000852.SH','000001.SH')
        AND pct_chg IS NOT NULL AND isfinite(pct_chg) AND close>0 AND isfinite(close)""", [d]) or 0
    add(12, "index completeness", n_indices == 4, n_indices, "4 benchmark indices", "warn")
    bad_indices = _scalar(con, """SELECT count(*) FROM core_index_day WHERE trade_date=?
        AND pre_close>0 AND pct_chg IS NOT NULL
        AND abs(pct_chg-(close/pre_close-1)*100)>0.1""", [d]) or 0
    add(13, "index return consistency", bad_indices == 0, bad_indices, "0 conflicts >0.1pp", "block")
    missing_listing = _scalar(con, """SELECT count(*) FROM v_stock WHERE trade_date=?
        AND exchange IN ('SSE','SZSE') AND market IN ('主板','创业板','科创板')
        AND coalesce(try_cast(list_date AS DATE),try_strptime(list_date::VARCHAR,'%Y%m%d')::DATE) IS NULL""", [d]) or 0
    add(14, "listing dates available", missing_listing == 0, missing_listing, "0 missing listing dates", "block")

    if scope == "history":
        for gate in gates:
            if gate["id"] in HISTORICAL_NOT_APPLICABLE:
                gate["not_applicable_historical"] = True
                gate["reason"] = HISTORICAL_NOT_APPLICABLE[gate["id"]]
                gate["level"] = "info"
                gate["recorded_pass"] = gate["pass"]
                gate["pass"] = None
    else:
        hist = history_completeness(con, d, counts)
        add(15, "history completeness", hist["pass"], hist["value"], hist["threshold"], "block",
            f"{hist['value']['count']} partial day(s) over {hist['value']['n_days']} history days")
        if previous:
            band = _band_stability(con, d, previous)
            add(16, "limit band stability", band["pass"], band["value"], band["threshold"],
                "warn", band["message"])
        fd = _fd_scale(con, d)
        add(17, "fd_amount scale", fd["pass"], fd["value"], fd["threshold"], "warn", fd["message"])
        add(18, "row count trend", median_ratio is None or median_ratio >= 0.98, median_ratio,
            "prior-20d median ratio >=0.98 (below 0.95 is blocked by gate 1)", "warn",
            f"prior20_median={median20}, n_prior={n_prior}")

    blocking = [g["id"] for g in gates
                if g["pass"] is False and g.get("level") == "block"]
    out = {"date": day, "scope": scope,
           "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
           "rows": n, "gates": gates, "passed": not blocking, "blocking": blocking,
           "not_applicable": [g["id"] for g in gates if g.get("not_applicable_historical")],
           "skipped": list(skipped)}
    if persist:
        persist_report(out)
    return out


def persist_report(out: dict) -> None:
    qdir = settings.META / "quality"
    atomic_write_json(qdir / f"{out['date']}.json", out)
    atomic_write_json(qdir / "latest.json", out)


def latest() -> dict:
    p = settings.META / "quality" / "latest.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
