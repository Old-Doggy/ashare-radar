[简体中文](README.md) | **English**

<h1 align="center">Ashare Radar</h1>

<p align="center">Market breadth and structure dashboard for China A-shares</p>

<p align="center">
  <a href="https://github.com/Old-Doggy/ashare-radar/actions/workflows/ci.yml"><img src="https://github.com/Old-Doggy/ashare-radar/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/node-22.18%2B-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/version-v0.4.3-2f6f4e" alt="Version">
</p>

<p align="center">
  <img src="docs/screenshots/en-today.png" width="880" alt="Today">
</p>

Computes breadth, equal- and cap-weighted returns, concentration, sector participation and dispersion from Tushare daily data. Includes eight main screens plus briefing and chart-lab routes, a Flask API and a single-file offline export.

## Features

- Six view families: breadth, concentration, sectors, stocks, sentiment and holdings
- The Rotation view plays the sector strength cloud using each sector's last 5, 10 or 20 daily observations for cumulative equal-weight returns and average breadth
- Daily updates with 18 quality gates (14 in v0.4.2; v0.4.3 adds gates 15–18: full-history integrity, limit-band stability, sealed-amount scale and row-count trend, and fixes gates 1/3/6); current-day post-close akshare fallback
- Missing data stays unknown: rows failing coverage rules do not enter weight-based metrics and the UI shows `—`/gaps instead of 0
- Chinese/English UI, dark/light themes, colorblind palette, URL state, PNG/CSV export
- Single-file HTML build for offline use

## Quick start

Requirements: Python 3.12, Node 22.18+, a Tushare Pro token (additional endpoints require their own permissions).

### 1. Install dependencies and set the token

```bash
git clone https://github.com/Old-Doggy/ashare-radar.git
cd ashare-radar
conda create -n ashare-radar python=3.12 -y
conda activate ashare-radar
pip install -r requirements.txt
cp .env.example .env
```

- `.env.example` is only a template — **do not edit it**. The copied **`.env`** is the real config (git-ignored).
- Edit **`.env`** and set `TUSHARE_TOKEN=your-token`. Without a token you can only open an existing offline snapshot; you cannot fetch or update data.

### 2. Build the data (first run / rebuilding from scratch)

Two steps: fetch raw market data, then compute the analytics tables.

```bash
# 2a. Raw data -> data/lake.duckdb (pick one)
python -m pipeline.bootstrap_api --start 20240101   # A. directly via the Tushare API
python -m pipeline.bootstrap                          # B. from a local parquet snapshot (layout: docs/data_setup.md)

# 2b. Raw data -> analytics tables (required once)
python -m pipeline.build_marts
```

- `bootstrap_api` / `bootstrap`: write only the core raw tables (daily, daily_basic, adj_factor, stk_limit, indices, moneyflow, margin, ...). `--start` is the first date: `20240101` is about one year and takes ~10 minutes; a longer history (e.g. `20161201`) takes ~1–2 hours because of Tushare rate limits.
- `build_marts`: turns raw tables into `feat_stock`, `mart_market_day`, sector/rotation/monthly tables, ... **It must run once after bootstrapping, otherwise the dashboard has no data.** Skip it when you were given a ready `data/lake.duckdb` that already contains marts.
- Both steps need the token. Optional endpoints such as `limit_list_d` are skipped with a warning when unavailable (the affected metrics show `—`, never wrong numbers).

### 3. Start the dashboard (pick one)

**Option 1 (Windows, recommended): double-click `start.bat`**
It picks a Python that has the dependencies; builds the frontend with `npm install && npm run build` when `frontend/dist` is missing; starts the server in the background and opens <http://127.0.0.1:8000>; if the server is already running it just opens the page. Use `stop.bat` to stop it.
It only builds the frontend and starts the server — it **does not create the database**; without `data/lake.duckdb` it only tells you to do step 2 first.

**Option 2 (manual):**

```bash
cd frontend && npm ci && npm run build && cd ..   # first run only; skip if the frontend is unchanged
python -m backend.main                            # foreground server, Ctrl+C to stop
```

- `backend.main`: starts the Flask server that serves both `/api/*` and the built frontend, then open <http://127.0.0.1:8000>. Without a frontend build it only serves the API, not the page.

> If your working copy already contains `data/lake.duckdb` and `frontend/dist` (e.g. an existing dev checkout), **just double-click `start.bat`** — step 2 is not needed.

### 4. Daily updates and the offline single file

```bash
python -m pipeline.release    # fetch the latest session -> 18 quality gates -> rebuild marts -> export offline HTML
```

- Rebuild without fetching: `python -m pipeline.release --rebuild`; export only: `python -m pipeline.export_static`.
- The offline single file is `frontend/dist/ashare-radar.html`; double-click it to open. It is an export-time snapshot, needs no server and is not real-time.
- The scheduled task, the API button and the Windows scripts share one publication chain; a failed run keeps the previous HTML and already-opened offline copies cannot receive later alerts. See the [release instructions](docs/release.md).

## Data & licence

- **Software licence**: code is released under [MIT](LICENSE).
- **Data licence**: market data comes from **Tushare Pro**. You must hold your own account, points and endpoint
  permissions and comply with Tushare's terms. This project **does not redistribute raw market data**
  (`data/`, `frontend/dist/` and `.env` are git-ignored). Screenshots are demos only; the offline HTML is
  generated locally from your own data. See [NOTICE](NOTICE).
- **Disclaimer**: this is a local analytics tool, **not investment advice**. Data may be missing, delayed or
  inconsistent with exchanges/upstream sources and is provided "as is" under MIT without warranty.
  Known issues: [docs/known_limitations.md](docs/known_limitations.md).
- Third-party components (DuckDB/Flask/React/ECharts/Tailwind/Vite/lucide, ...) keep their own licences; inlined
  fonts (Inter, JetBrains Mono, Noto Sans/Serif SC) are SIL OFL 1.1 as declared in [NOTICE](NOTICE).

## Docs

| Doc | Contents |
|---|---|
| [Technical notes](docs/technical.en.md) | Architecture, screens, quality gates, concurrency, limits, roadmap |
| [Metric definitions](docs/metric_contracts.md) | Definition and denominator of each metric |
| [Known limitations](docs/known_limitations.md) | 15 quantified data facts, fix status and reproduction commands |
| [Performance](docs/performance.md) | Measurement date/env/method, first paint and API p50/p95 |
| [Data sources](docs/data_sources.md) | Primary, fallback and degradation rules |
| [Data setup](docs/data_setup.md) | Snapshot layout and bootstrap steps |
| [Data audit (historical)](docs/audit_findings.md) | Correctness checks and known biases (historical) |
| [Release notes](docs/release.md) | Versions, release checklist, tagging |
| [Decision log](docs/decisions.md) | ADR list |

## Version and licence

Current version **v0.4.3** (earlier releases in [release.md](docs/release.md)). Software under [MIT](LICENSE);
data usage and disclaimer in [NOTICE](NOTICE).
