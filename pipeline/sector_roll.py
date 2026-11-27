"""Shared row contract for the rolling sector API and offline export."""

SQL_SECTOR_ROLL_ROWS = """
SELECT r.trade_date, r.sw_l1, r.ret_r5, r.ret_r10, r.ret_r20,
       r.br_r5, r.br_r10, r.br_r20, r.rank_r5, r.rank_r10, r.rank_r20,
       CASE WHEN d.amount >= 0 AND isfinite(d.amount)
            THEN try_cast(round(d.amount) AS BIGINT) END AS amount,
       rot.n_sectors
FROM mart_sector_roll r
LEFT JOIN mart_sector_day d USING (trade_date, sw_l1)
LEFT JOIN mart_rotation_day rot USING (trade_date)
WHERE (?::DATE IS NULL OR r.trade_date >= ?::DATE)
  AND (?::DATE IS NULL OR r.trade_date <= ?::DATE)
  AND (?::DATE IS NOT NULL OR r.trade_date IN (
        SELECT DISTINCT trade_date FROM mart_sector_roll
        WHERE (?::DATE IS NULL OR trade_date <= ?::DATE)
        ORDER BY trade_date DESC LIMIT 250))
ORDER BY r.trade_date, r.sw_l1
"""


def roll_params(start: str | None = None, end: str | None = None) -> list[str | None]:
    return [start, start, end, end, start, end, end]
