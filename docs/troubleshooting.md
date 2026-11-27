# 常见问题与排查（Troubleshooting）

> 从零建库/启动/导出时最容易卡住的问题都收在这里；README 只保留最短说明。

## 1. 命令瞬间返回、没有任何输出/进度

**通常不是程序卡住，而是 `python` 不是装了依赖的那个解释器**（Windows 上 `python` 常指向
Microsoft Store 占位程序或另一个 Python，命令会静默退出，连报错都没有）。先自检：

```powershell
where.exe python
python -c "import sys, duckdb, tushare, flask; print(sys.executable, 'deps ok')"
```

- 第二条失败 → 先 `conda activate ashare-radar`（或 `pip install -r requirements.txt`）；
- `where.exe python` 指向 `WindowsApps` 或路径不对 → 用项目自带的解释器选择器：

```powershell
$py = powershell -NoProfile -ExecutionPolicy Bypass -File scripts\python.ps1
& $py -u -m pipeline.bootstrap_api --start 20240101
```

其它技巧：

- 加 `-u` 让输出不缓冲：`python -u -m pipeline.bootstrap_api ...`
- 长区间可放后台并记日志，另开窗口看进度：
  ```powershell
  python -u -m pipeline.bootstrap_api --start 20160101 *> bootstrap.log
  Get-Content bootstrap.log -Wait -Tail 20
  ```
- 建库中断（Ctrl+C/关窗口）后，**重跑同一条命令会从检查点续跑**，不需要从头再来。

## 2. 页面没有数据 / 图表空白

- 只跑了 `bootstrap_api` 而没跑 `build_marts`：页面用的是分析表，必须先
  `python -m pipeline.build_marts`；
- `data/lake.duckdb` 不存在或路径不对：确认在仓库根目录执行、`.env` 没配错 `ASHARE_RADAR_DATA_DIR`；
- 前端未构建：`start.bat` 会自动构建，手动模式需 `cd frontend && npm ci && npm run build`。

## 3. `export_static` 报错/拒绝导出

导出前会校验最新交易日的 18 条门禁与 `quality/latest.json` 日期：

```powershell
python -m pipeline.refresh_status   # 重跑最新交易日门禁并刷新 status/quality
python -m pipeline.export_static
```

`pipeline.release` 会自动包含这两步；`--allow-failed` 只是诊断出口，不要用于正式发布。

## 4. `limit_list_d unavailable` / `margin empty` / 炸板率显示 `—`

- `limit_list_d`（官方涨停名单）需要额外积分/权限；无权限时本项目自动跳过，炸板率、封单额显示 `—`，
  其它指标不受影响；
- `margin` 是 T+1 数据，最新交易日为空属正常；
- 完整已知限制见 [known_limitations.md](known_limitations.md)。

## 5. 端口被占用

- `start.bat` 会在 8000–8010 自动找空闲端口并打印实际 URL；
- 手动运行 `python -m backend.main` 可用环境变量指定端口：
  ```powershell
  $env:ASHARE_RADAR_PORT = "8010"
  python -m backend.main
  ```

## 6. 限速相关（限频警告、想加速/保守）

- 默认 450 次/分钟 + 建库 3 并发；限频错误自动指数退避；
- 想更快：`--workers` 可调到 4–6（实测服务端可承受），但不要超过官方 500 次/分钟太多；
- 想更保守：`--workers 1`，并参考 [rate_limits.md](rate_limits.md) 调低 `TUSHARE_RATE_GLOBAL_PER_MIN`；
- 账号还有其它脚本在跑时，请先停掉它们，避免叠加超限。

## 7. token 未配置 / 配置在哪里

- 只填 **`.env`**（不是 `.env.example`）：`cp .env.example .env` 后编辑 `TUSHARE_TOKEN=...`；
- `.env` 不会进 git；没有 token 只能查看现成离线快照，不能拉取/更新数据。
