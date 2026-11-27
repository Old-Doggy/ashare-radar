[简体中文](README.md) | [English](README.en.md)

<h1 align="center">A股雷达</h1>

<p align="center">A 股市场宽度与结构面板</p>

<p align="center">
  <a href="https://github.com/Old-Doggy/ashare-radar/actions/workflows/ci.yml"><img src="https://github.com/Old-Doggy/ashare-radar/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <img src="https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/node-22.18%2B-339933?logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/version-v0.4.3-2f6f4e" alt="Version">
</p>

<p align="center">
  <img src="docs/screenshots/today.png" width="880" alt="今日盘面">
</p>

基于 Tushare 日频数据计算市场广度、等权/市值加权收益、集中度、行业参与和个股分化。包含 8 个主页面、每日简报与图表实验页，以及 Flask API 与单文件离线导出。

## 特性

- 广度、集中度、行业、个股、情绪、持仓六类视图
- 行业页「轮动」播放行业强度云，比较每个行业最近 5、10、20 条日度观测的累计等权收益和平均上涨占比
- 每日更新 + 18 条质量门禁（v0.4.2 为 14 条；v0.4.3 新增 gate15–18：全历史完整性、限价档稳定性、封单额量纲、行数趋势，并修正 gate1/3/6）；当日收盘后可降级到 akshare，历史补数仍需主源
- 缺失保持未知语义：门禁不足或部分交易日不参与权重类指标，前端显示 `—`/断线而不是 0
- 中英双语、深/浅主题、色盲配色、URL 状态、PNG/CSV 导出
- 支持导出单文件 HTML，离线打开

## 快速开始

要求：Python 3.12、Node 22.18+、Tushare Pro token（基础接口需 2000 积分，其他接口权限分别确认）。

### 一键启动（Windows）

双击 `start.bat`：自动选择带依赖的 Python、启动服务并打开 http://127.0.0.1:8000；若服务已在运行则直接打开。停止双击 `stop.bat`。首次缺少前端构建时会自动执行 `npm install && npm run build`；若只有离线单文件，脚本会提示「离线快照，非实时」。

```bash
git clone https://github.com/Old-Doggy/ashare-radar.git
cd ashare-radar
conda create -n ashare-radar python=3.12 -y
conda activate ashare-radar
pip install -r requirements.txt
cp .env.example .env        # 填入 TUSHARE_TOKEN
```

构建数据（二选一）：

```bash
# A. 直接从 Tushare API 构建
python -m pipeline.bootstrap_api --start 20240101

# B. 使用本地 parquet 快照，结构见 docs/data_setup.md
python -m pipeline.bootstrap
```

```bash
python -m pipeline.build_marts
python -m backend.main      # http://127.0.0.1:8000
```

前端与单文件导出：

```bash
cd frontend && npm ci && npm run check && cd ..
python -m pipeline.refresh_status
python -m pipeline.export_static
# 打开 frontend/dist/ashare-radar.html
```

后续每日发布使用 `python -m pipeline.release`；只重建用 `python -m pipeline.release --rebuild`。
从 v0.3.0 升级后，先构建新前端，再执行 `python -m pipeline.release --rebuild`，生成滚动表与新版离线包。
更新任务、API 按钮和 Windows 脚本共用发布链；失败保留旧 HTML，已打开的离线包不会自动收到新告警。
详见[发布说明](docs/release.md)。

## 数据与许可

- **软件许可**：代码以 [MIT](LICENSE) 发布。
- **数据许可**：行情数据来自 **Tushare Pro**，使用者必须自行持有账号与接口权限，并遵守其服务条款；
  本项目**不再分发任何原始行情数据**（`data/`、`frontend/dist/`、`.env` 均不入库）。
  仓库内截图仅为功能演示；离线单文件 HTML 由使用者自行用本地数据生成。详见 [NOTICE](NOTICE)。
- **免责声明**：本项目是本地分析工具，**不构成投资建议**；数据可能缺失、延迟或与交易所/上游不一致，
  按 MIT「as is」提供，不对准确性作担保。已知问题见 [docs/known_limitations.md](docs/known_limitations.md)。
- 第三方组件（DuckDB/Flask/React/ECharts/Tailwind/Vite/lucide 等）保留各自许可；
  内联字体（Inter、JetBrains Mono、Noto Sans/Serif SC）为 SIL OFL 1.1，声明见 [NOTICE](NOTICE)。

## 验证状态

| 项目 | 状态（2026-11-27，v0.4.3 集成后） |
|---|---|
| 单元/回归测试 | pytest **236 passed / 0 failed / 0 skipped**；前端 `node --test` **117 passed / 0 fail** |
| 静态检查 | `ruff check` All checks passed；`tsc --noEmit` 0 error |
| 质量门禁 | **18 条**；2026-11-26 `quality/latest` 18/18 通过、`blocking=[]` |
| 历史完整性 | 回补 **192/192** 个部分交易日（failed=0，`remaining_partial=[]`）；gate15 通过（`incomplete_dates`=0，最小日行数 2,768） |
| 核心数据量 | `core_stock_day` = **10,827,571** 行；`feat_stock` = 10,478,223；`mart_market_day` = 2,425 日（2016-12-01..2026-11-26） |
| 静态审计 | `scripts/audit_all.py --offline`：**60 通过 / 0 失败 / 3 跳过**（verdict=`pass_with_skips`，跳过不算通过） |
| 产物 | 单文件 HTML **63,231,201 B**（约 63.2 MB）；静态 payload **17,624,011 B**（约 17.6 MB） |
| payload 元信息 | `meta.version=0.4.3`；`meta.source=tushare`；`unavailable_datasets=["limit_list_d","margin"]`；`meta.data_quality.n_partial_days=0`、`repaired_days=192` |
| 已知限制 | 15 条逐项量化披露：[docs/known_limitations.md](docs/known_limitations.md) |

本次集成验证证据：[docs/validation/v0.4.3-final.json](docs/validation/v0.4.3-final.json)。
历史验收与修复报告（**历史文档，口径见文件顶部横幅**）：[最终交付报告](docs/release_completion_report.md)、
[修复报告](docs/release_fix_report.md)、[v0.4.0 终审](docs/release_review_v0.4.0.md)、[历史验收证据摘要](docs/validation/README.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [技术说明](docs/technical.md) | 架构、页面、质量门禁、并发、限制、Roadmap |
| [指标口径](docs/metric_contracts.md) | 每个指标的定义与分母 |
| [已知限制](docs/known_limitations.md) | 15 条数据事实、修复状态与复现命令 |
| [性能实测](docs/performance.md) | 测量时间/环境/方法、首屏与 API p50/p95 |
| [数据源](docs/data_sources.md) | 主源、备用源、降级规则、许可限制 |
| [数据准备](docs/data_setup.md) | 快照目录结构与建库步骤 |
| [数据审计（历史）](docs/audit_findings.md) | 正确性验证与已知偏差（历史记录） |
| [发布说明](docs/release.md) | 版本、发布检查清单、tag 流程 |
| [决策记录](docs/decisions.md) | ADR 列表 |

## 版本与许可

当前版本 **v0.4.3**（v0.4.2 之前的发布记录见 [release.md](docs/release.md)）。软件许可 [MIT](LICENSE)；
数据使用与免责声明见 [NOTICE](NOTICE)。
