# Technical notes

**Current version v0.4.3 (2026-11-27)**: fixes the P0/P1 data-integrity and contract issues found by the audit on top of v0.4.2, and adds data-licence / disclaimer disclosures. The authoritative fact list is [known limitations](known_limitations.md) (Chinese); historical reports ([completion report](release_completion_report.md), [v0.4.0 final review](release_review_v0.4.0.md)) carry historical banners and are process evidence only. Passing gates does not mean the event-permission gaps, point-in-time sector data or independent-source verification are resolved.

## Architecture

```
Tushare API / akshare fallback / local parquet snapshot
        │  bootstrap / bootstrap_api / update_daily (idempotent, per-day, quality gates)
        ▼
data/lake.duckdb
        │  core_stock_day / core_index_day / core_limit_event / core_flow_day / core_margin_day
        ▼
feat_stock (adjustment, moving averages, highs, limit flags, streaks)
mart_market_day / mart_sector_day / mart_sector_month / mart_stock_latest
                    └──► mart_sector_roll (rolling windows over sector observations)
        ▼
Flask API ──► React + ECharts (dark/light, Chinese/English)
        └──► export_static.py ──► single-file HTML
```

Stack: DuckDB for local columnar aggregation, Flask for the API, React + TypeScript + Tailwind + ECharts on the frontend, built with Vite. Historical repair and takeover: `pipeline/repair_history.py` (detects partial sessions via local medians and backfills them) and `pipeline/promote_repair.py` (isolated copy → backup → atomic replace → rebuild marts → verify → rollback on failure; v0.4.3).

## Screens

| Screen | Contents |
|---|---|
| Today | Verdict, five KPIs, return × breadth, top contributors |
| Market structure | Return/breadth series, concentration, dispersion |
| Regime | Quadrant scatter, 30-day trail, regime duration and forward stats |
| Sectors | Bubbles, cumulative returns, rank migration, rotation strength |
| Stocks | Cap × return, distribution, table, candlesticks (forward-adjusted), PE percentile |
| Sentiment | Limit-ups/downs, streaks, highs/lows, seal quality, margin |
| Watchlist | Sector exposure, P&L contribution, positions, CSV |
| Method & data | Lineage, quality gates, update log, source reconciliation (with as-of) |
| `/labs` | Chart experiments (hexbin, treemap, gradient cloud, small multiples) |
| `/briefing` | A4 daily briefing with chart animation disabled |

## Update pipeline

`python -m pipeline.release` (steps 1–4 use update_daily):

1. Extend the trading calendar and find missing sessions
2. Fetch `daily / daily_basic / adj_factor / stk_limit / limit_list_d / moneyflow / margin` per day
3. Write the core layer
4. Run 18 gates in the daily transaction (14 in v0.4.2); blocking failures roll back the day and prevent publication
5. `build_marts` rebuilds features and marts
6. `export_static` regenerates the single-file build

`pipeline.release` is the single entry point for the API and Windows scripts; `--rebuild` verifies, rebuilds and exports only. On Windows, the weekday 17:35 task runs the chain and Sunday 02:00 runs a full rebuild. Historical partial sessions are repaired in an isolated copy by `repair_history` and taken over through `promote_repair` (v0.4.3).

Double-click `start.bat` to launch the web app: it validates the interpreter, reuses a running server, builds the frontend if needed and opens the browser; `stop.bat` stops it. Override the port with `ASHARE_RADAR_PORT` (default 8000). If only the offline single-file build exists, the script explicitly warns that it is a non-realtime snapshot.

`python -m pipeline.export_static --allow-failed` is a **diagnostic escape hatch** that bypasses the quality/status guards; it must not be used for releases (the publication chain requires all gates to pass). A failed export does not embed a failure banner — do not distribute it.

## Quality gates

The v0.4.3 publish scope (`scope="publish"`) runs **18** gates (14 in v0.4.2). The historical-repair scope
(`scope="history"`) records gate 7 and gate 14 with their actual values but marks them `not_applicable_historical`
(never blocking) and skips gates 15–18 per day (gate 15 runs once over the repaired batch); **thresholds are never relaxed**
(see the contract at the top of `pipeline/quality_gates.py`).

| # | Check | Level |
|---|---|---|
| 1 | Sample size ≥ 3,000; previous-day ratio 0.95–1.05; ≥0.95 of the previous 20-session median (excluding the day) | block |
| 2 | Primary key unique | block |
| 3 | Price sanity; in-scope pre-listing rows block; IPO exemption requires `trade_date >= list_date` and ≤30 days after listing; BSE/NEEQ-era pre-listing history is counted and disclosed, not gated | block |
| 4 | Return conflicts >0.1pp affect <1% of comparable rows | block |
| 5 | Positive finite factor/capitalization/adjusted-price coverage ≥99% | block |
| 6 | Breadth vs previous 5-session median ≤0.50; all-flat days are explicitly warned as undefined | warn |
| 7 | Sector coverage ≥97% | block |
| 8 | All adjustment factors valid | warn |
| 9 | Same-sample core EW change ≤8pp | warn |
| 10 | Finite nonnegative amount and volume | block |
| 11 | Positive limit-price coverage ≥99% of eligible sample | block |
| 12 | Four benchmark indices complete | warn |
| 13 | Index return consistency | block |
| 14 | Listing dates present | block |
| 15 | Full-history integrity: days whose `count(*)` is <0.85 of a ±10 window local median (excluding the day) block publication (full-table scan independent of the updated day) | block (new in v0.4.3) |
| 16 | Limit-band stability: stocks switching 5%/10%/20%/30% band vs the previous session above threshold → warn with counts | warn (new in v0.4.3) |
| 17 | `fd_amount` scale: share of official limit events with `fd_amount/float_mv > 2` above 1% → warn | warn (new in v0.4.3) |
| 18 | Row-count trend: current core rows / previous 20-session median <0.98 → warn (below 0.95 is already blocked by gate 1) | warn (new in v0.4.3) |

Results go to `data/meta/quality/YYYYMMDD.json` and are shown on the Method & data screen; the payload `meta.data_quality` carries `partial_days/n_partial_days/repaired_at/history_gate` (v0.4.3; after the takeover `n_partial_days=0`, `repaired_days=192`; the 2026-11-26 report passes 18/18 with `blocking=[]`). Repair days run with `scope="history"`: gates 7/14 are recorded as `not_applicable_historical` because 2016–2022 static sector mapping and listing-date completeness do not meet the current thresholds by construction, and gate 15 runs once over the whole repaired batch. This is an explicit "not applicable" annotation, **not** a threshold relaxation — see [known_limitations.md](known_limitations.md) §1.

## Concurrency and locking

DuckDB allows one writer at a time.

- API: a read-only connection per request, closed at request end
- Updater: `connect_wait` retries every 5 seconds, 300 seconds by default (`ASHARE_RADAR_LOCK_TIMEOUT`)
- While the updater holds the write lock, the API returns `503 + Retry-After: 10`
- The publication chain is covered by an OS file lock (fetch → gates → rebuild → export); conflicts exit non-zero instead of pretending success
- Scheduled tasks (v0.4.3): `-RestartCount 3 -RestartInterval 10min -AllowStartIfOnBatteries`; the entry scripts retry and keep logs

## Failure alerts

- A failed run writes `data/meta/alert.json` with time, stage, reason and log path
- `/api/meta` and the static payload carry `alert`
- The UI shows a red banner. A failure preserves the previous complete HTML; the wrapper does **not** re-export a partially updated build, and already-distributed offline copies cannot receive future alerts
- The disk alert is cleared only after the new HTML has been atomically replaced; candidate HTML excludes stale alerts

## Data sources

Primary: Tushare Pro. Fallback: akshare (Eastmoney, free, no token), covering same-day `daily / daily_basic / stk_limit / adj_factor`. See [data_sources.md](data_sources.md). Licence and redistribution limits: [NOTICE](../NOTICE) — raw market data is not distributed with the repository and users must hold their own Tushare permissions.

Metric definitions: [metric_contracts.md](metric_contracts.md). Data setup: [data_setup.md](data_setup.md).

## Known limitations

Full quantified list (15 items): [known_limitations.md](known_limitations.md) (Chinese). Essentials:

- Historical partial sessions: 192 sessions before v0.4.3 (2016-12-08..2022-11-16); v0.4.3 backfilled them and gate 15 prevents regressions. Historical sector coverage after repair is still 93–97% (static mapping, not point-in-time).
- ST 5% band: since 2026-07-06 Tushare `stk_limit` returns a 10% band for ST-named stocks (verified upstream); `limit_up_5pct_n` has been 0 for 98 sessions. Not fabricated locally; disclosed and monitored by gate 16.
- `limit_list_d` requires extra points: without it the broken-board rate and sealed amount show `—` (only 1,569/2,425 sessions have values); streak height falls back to price limits.
- Margin is published T+1, so the latest session may be empty; SZSE was missing upstream on 2026-05-11/18/21 and v0.4.3 outputs NULL instead of a partial sum on such days (`margin_n_exchanges`: 2,421 days=2 / 3 days=1 / latest=0).
- Northbound flow changed definition on 2024-08-19; no cross-period series.
- Sector membership is static (look-ahead bias); 241 stocks / 328,485 rows (3.13%) are unmapped and excluded from sector aggregates.
- Three historical codes lack listing dates (2,720 rows permanently excluded); `fd_amount` had a 95-session unit anomaly, now treated as NULL.
- The single-file build is an export-time snapshot: it cannot receive later alerts, and `meta.generated_at` keeps the export byte-wise non-reproducible.
- `/labs` hexbin and treemap views are visual transforms; inputs are audited, individual cells are not.
- Performance: the single-file build is 63,231,201 B (about 63.2 MB, measured after the v0.4.3 integration) with FCP 912 ms / load 852 ms / `/api/stocks` p95 591–614 ms; the old "all endpoints p95<150 ms" claim no longer holds — see [performance.md](performance.md).

## Roadmap

- [x] Daily briefing PDF/PNG
- [x] Holdings P&L, sector rotation, candlesticks (forward-adjusted), PE percentile
- [x] 18 quality gates (including v0.4.3 history-integrity/limit-band gates), update log, source reconciliation, failure alerts
- [x] Colorblind mode, URL state, PNG/CSV export
- [x] v0.4.3: historical partial-session backfill, margin scope, missing-value semantics, data licence/disclaimer
- [ ] Point-in-time Shenwan membership (requires `index_member_all`)
- [ ] Brinson attribution
- [ ] Independent-source reconciliation (baostock etc.)

## Layout

```
pipeline/   bootstrap / bootstrap_api / build_marts / update_daily / export_static / quality_gates / alerts;
            repair_history / promote_repair (v0.4.3)
backend/    Flask API
frontend/   Vite + React + TypeScript + Tailwind + ECharts
config/     industry_bridge.csv (the only config read by code; v0.4.2 universe.yaml/theme.json/data_source_registry.yaml were confirmed unused and cleaned up in v0.4.3)
scripts/    update/rebuild/start/stop/dev/python/briefing/install_task (PowerShell), audit_all/gen_insights/
            perf_api/probe_akshare/test_fallback_insert (Python), shot.mjs
tests/      metrics, API, locking, alerts, fallback source, publication integrity, history repair
docs/       definitions, known limitations, data sources, audits, performance, technical notes, release, insights, screenshots
```

Licence and disclaimer: [NOTICE](../NOTICE). Historical documents: see the banner at the top of each file.

> Tooling boundary: `scripts/perf_api.py`, `perf_web.ps1`, `probe_akshare.py`, `test_fallback_insert.py`, `gen_insights.py` and
> `backfill_index.py`/`backfill_margin.py`/`reconcile_sources.py` are **manual dev/verification tools** that are not wired into the
> Makefile or the publication chain (W3-13/W3-17); `refresh_meta.py` and `update_daily.quality()` have no callers and are dead code
> pending cleanup. The publication chain only uses `pipeline.release` plus `scripts/update.ps1`/`rebuild.ps1`.
