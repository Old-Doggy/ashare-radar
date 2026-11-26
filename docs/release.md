# 发布说明（GitHub）

当前发布候选版本为 **v0.4.2**。`v0.4.0` 新增行业强度云，审核结果见 [v0.4.0 终审](release_review_v0.4.0.md)；`v0.4.1` 修交互光标（Tailwind v4 把 `<button>` 默认光标改成 `default`，全站按钮丢失手型）；`v0.4.2` 加市场结构页时间轴缩放/平移（滚轮、拖拽、滑杆、双击复位、键盘）、把涨跌停口径钉死为价格口径并让官方名单缺口可审计、放大今日盘面卡片小标题、同步换范围动画。均为向后兼容的小版本。上一版 `v0.3.0` 已发布。

## 1. 仓库名

**最终：`ashare-radar`（A股雷达）**

- 12 字符、全小写、连字符分隔；`ashare` + `radar` 一眼能读出用途
- 替代早期名称：不再只强调“广度/实验室”，产品覆盖广度、行业、个股、情绪与持仓
- 与 Python 包名 `ashare-radar`、单文件 `ashare-radar.html` 保持一致

## 2. 仓库描述

> A-share market breadth & structure terminal — DuckDB + Flask + React/ECharts. 8 pages, auto daily update, single-file offline build.

## 3. Topics

`a-share` `tushare` `market-breadth` `duckdb` `echarts` `dashboard` `quant` `data-visualization`

## 4. 推送与发布检查

1. 运行 `python -m pytest` 和 `ruff check --select E9,F63,F7,F82 .`，再在 `frontend` 执行 `npm ci` 与 `npm run check`。
2. 在数据库副本验证 `python -m pipeline.release --rebuild`。该入口依次验质、重建分析表和导出。运行 `python scripts/audit_all.py --lake <副本路径> --offline` 确认滚动表和静态包一致。
3. 检查变更清单，提交源代码、回归测试和文档。将验证产物保留在临时目录。
4. 推送源码后等待 GitHub Actions 通过，在已验证的提交上创建 `v0.4.0` tag 和 Release。

## 5. 部署已发布的版本

**构建会清空 `frontend/dist/`。** `npm run check` 也包含构建。请在最后一次构建之后导出，并确认 `frontend/dist/ashare-radar.html` 存在。

1. 更新代码和依赖，在 `frontend` 执行 `npm ci` 和 `npm run build`。
2. 回到仓库根目录执行 `python -m pipeline.release --rebuild`。旧库可继续浏览既有页面，行业强度云需本步生成 `mart_sector_roll`。如果存在未解决的行情更新失败，先完成 `python -m pipeline.release` 并检查门禁再发布。
3. 重启 Flask。检查 `/api/sectors/roll` 返回含数据的 200，并打开 `#/sectors?mode=rot` 与新导出的 `frontend/dist/ashare-radar.html`。
4. Windows 每日更新、周日重建继续使用原发布入口，本次无需调整任务时间。原有任务账号和解释器需能运行更新后的依赖。

## 6. 不随仓库分发的内容

- `data/`（DuckDB、parquet、快照、简报）——体积大且含行情数据
- `.env`（Tushare token）
- `frontend/dist/`（构建产物，可由 `npm run build` + `pipeline.export_static` 重建）

新用户按 README「快速开始」：建 conda 环境 → 填 token → `python -m pipeline.bootstrap` → `python -m backend.main` 或 `python -m pipeline.export_static`。
