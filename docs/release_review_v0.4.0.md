# A股雷达 v0.4.0 发布终审

> **历史文档（2026-11-26，v0.4.0 终审），已被 v0.4.3（2026-11-27）取代。**
> 文中测试数（pytest 139 / 前端 node **49**）是 v0.4.0 基线：v0.4.1/v0.4.2 后 node 测试已 52，
> v0.4.3 集成后为 117；产物体积/行数也为历史值。
> 现行事实见 [known_limitations.md](known_limitations.md) 与 README 验证状态；v0.4.3 修复见 [release.md](release.md)。

2026-11-26，上海时间。基线为 `bec21f8`，即 GitHub 现有 `v0.3.0`。行情截至 2026-11-25。收尾审计在默认库上以只读连接执行，篡改回归和重建在副本上执行，全程关闭 `.env` 加载。

## 结论

**本地收尾完成。** 默认库的审计通过，副本上的一行篡改被检出，恢复后再次通过。静态包已在前端构建之后重新导出。变更保存在本地工作区。

## 收尾决策

选择方案 B。每个行业按最近 5、10 或 20 条日度观测计算。市场开市但该行业缺整行时，窗口向前取样，因此 10 条观测可能覆盖 11 个市场交易日。现有行的空收益或空广度仍会使对应指标为空。这样既保留默认库的历史值，也与 `mart_sector_rank.ret20` 的窗口一致。两者的极端复利因子边界见[指标契约](metric_contracts.md)。

## 7 项修复的验证

| 项 | 终审结果 | 证据 |
|---|---|---|
| 1. 既有分析表 | 十个对象的结构和行数一致。`v_stock`、`feat_stock`、`mart_limit_quality`、`mart_rotation_day`、`mart_stock_latest` 双向 `EXCEPT ALL` 均为零。其余五表逐键复核，所有非浮点值和空值位置一致。日等权收益最大绝对差为 `2.71e-16`，行业日成交额差低于 `0.001` 元，月市场成交额最大差约 `0.086` 元 | 复制同一数据库，运行 `python -m pipeline.build_marts`，对前后结果做双向 `EXCEPT ALL`。对含浮点差的表按日期和行业等主键做 `FULL JOIN`，阈值为 `1e-10 × max(1, abs(a), abs(b))`。所有差异值都在阈值内 |
| 2. 缺表仍可导出 | 通过。缺表写 `sector_roll: null`，静态客户端明确提示重建后重新导出。旧包没有该字段时行为一致 | `pipeline/export_static.py:135`、`frontend/src/lib/api.ts:417`、`tests/test_sector_roll_export.py:67` |
| 3. 当日图例 | 通过。轮动模式隐藏，切回当日恢复。`quadCounts` 仍供旁边的当日广度榜使用，保留计算 | `frontend/src/pages/Sectors.tsx:138`、`:215`；API 和断网浏览器均实际切换 |
| 4. 并列领跑 | 已修复。原遍历只保留遇到的第一个最优名次；现在同时显示所有并列领先行业。排名继续读取原始 `rank_rN` | `frontend/src/components/RotationPanel.tsx:347`、`frontend/src/lib/rotation.ts:261`；回归输入 `[null, 1, 1, 3]` |
| 5. 成交额 | 已修复。缺行、非有限或不可转整数的金额返回 `null`，前端显示未知金额及空心菱形；已知金额用窗口内统一比例缩放 | `pipeline/sector_roll.py:3`、`frontend/src/lib/charts6.ts:262`；真实离线最近 250 日共 7,750 行，字段逐项核对差异为零 |
| 6. 轨迹缺口 | 已修复。反例 `[A, null, B]`，旧版在 `1` 和 `1.25` 都返回 `B`，将未来坐标提前显示。对位于同一段的 `1.1`、`1.4`，旧 `ceil(min)..floor(max)` 扫描区间为空。终审版在缺失整数帧及接壤的两个区间返回 `null`，折线和位移虚线都按缺口断开 | `frontend/src/lib/rotation.ts:158`、`:174`，`frontend/src/components/RotationPanel.tsx:202`；`node --experimental-strip-types --test tests/rotation.test.mjs` |
| 7. 实验页降级 | 已修复。未完成请求显示加载，`[]` 显示暂无数据，缺表或缺离线数据时显示相应操作。实验页轮动无需市场日序列成功后才进入 | `frontend/src/pages/ChartLab.tsx:485`、`:549`；`frontend/src/components/RotationDataState.tsx:5`；浏览器单独验证延迟、409、空数组 |

## 项目级问题

### 阻断项（已修复）

- 上轮按连续市场交易日构建并核对了副本。默认库仍使用行业观测窗口，同一审计在默认库上报收益、广度各 2,733 个空值位置不一致。此次统一使用行业观测窗口，SQL、审计、契约和图表标签已对齐。缺整行向前取样，现有行空值仍保留。`pipeline/build_marts.py:321`，`tests/test_sector_roll.py:134`。
- 新审计逐行独立重算 74,913 行的三档收益和广度，逐键核对行集合、名次及空值位置。任何单边空值计为差异，数值容差仍为 `1e-12`。`--lake` 同时定位该副本的 `static-data.json` 与报告目录。`scripts/audit_all.py:443`，`tests/test_sector_roll.py:161`。
- 旧库直调用新接口会返回 500，且前端会把永久缺表描述成临时更新。现在返回 409，客户端明确提示重建。只有 `end` 的历史查询也改为取截止该日最近 250 个有滚动行的交易日。`backend/main.py:501`、`pipeline/sector_roll.py:3`，`tests/test_api.py:137`、`:146`。

### 建议提交前修（已处理）

- 播放时重播先执行暂停，导致停在首帧；普通气泡原先按整数帧跳动而选中轨迹按小数帧插值；稀有极值可能被分位数轴裁掉。已统一插值和窗口轴范围，改为明确的重播状态转换，并将窗口最大成交额移出逐帧计算。导出 PNG 文件名使用图中的交易日。`frontend/src/components/RotationPanel.tsx:140`、`:295`、`:390`，`frontend/src/lib/rotation.ts:231`。
- 官方 npm 审计检出 i18next 公告 `GHSA-6jcc-5g8w-32mx`。锁定已修复的 `26.3.4` 后审计为零，已复测中英文页面。`frontend/package.json`、`frontend/package-lock.json`。
- GitHub 现有 `v0.3.0` 指向改名前后的上一版发布基线，复用它会让两个版本难以区分。行业强度云是向后兼容的功能新增，采用 `0.4.0`，同步 Python、前端锁文件、显示版本及发布说明。`git ls-remote --tags https://github.com/Old-Doggy/ashare-radar.git 'v0.3*'`。
- `README`、技术说明、状态页和发布清单已补新模块、单位、缺表状态及正确的构建顺序。旧 `docs/audit_report.md` 标明修复前记录。新版报告由 `scripts/audit_all.py` 写到当前库的 `meta/`。

### 可后续确认

- 先前提供的 `0.28%`、`0.23%` 像素差可以是抗锯齿，但百分比本身无法确认差异成因。本次用真实副本检查 API 与离线的十个页面、行业模式切换及导出，未复跑原截图像素基线。A4 简报用 Edge 分别输出单页 A4 PDF，`Briefing.tsx` 仍明确关闭两张图表的动画。`frontend/src/pages/Briefing.tsx:101`、`:108`。
- 未改动通用 `EChart.tsx`、`quality_gates.py::run_gates()`、`mart_sector_rank` 的 SQL。完整发布仍为验质、重建、导出。副本新增表耗时约 0.1 秒，整批分析表约 45 秒。任务脚本仍调用既有发布入口，未等待真实 17:35 或周日 02:00 触发。`pipeline/release.py:43`、`:47`，`scripts/update.ps1:14`、`scripts/rebuild.ps1:14`。
- API 日期由全局校验器解析，再用绑定参数查询。静态滚动行业名用 `_script_json` 转义，包含 `</script>` 的测试字符串可安全往返。图表 tooltip 另对行业名做 HTML 转义。静态包约 59.6 MiB，其中 JSON 约 16.1 MiB。新字段只来自行业分析表和当日汇总成交额，导出结构不读取个人持仓表或凭据。`backend/main.py:54`、`pipeline/sector_roll.py:3`、`pipeline/export_static.py:370`、`frontend/src/lib/charts6.ts:94`。

## 验收记录

| 检查 | 结果 |
|---|---|
| `python -m pytest` 与 Ruff | 139 通过，Ruff 通过 |
| 前端 | 收尾重跑 `npm run check`，49 通过，类型检查和生产构建成功 |
| `python -m pipeline.build_marts --only sector_roll` | 收尾在副本重建 74,913 行，随后审计 55 通过、0 失败、3 跳过 |
| 默认库 `python scripts/audit_all.py --offline` | 重导出后复跑，55 通过、0 失败、3 跳过，退出码 0。跳过两项独立联网对账和最新日缺失的涨跌停事件检查 |
| 滚动独立验算 | 收益最大绝对差 `1.11e-15`，广度 `3.33e-16`，排名及逐行空值零差异 |
| 收尾离线浏览器检查 | 断网打开新导出的行业轮动页，图表正常显示，读到 7,750 条记录，浏览器错误和外部请求均为零 |
| 上轮浏览器验收 | API 和断网 `file://` 各十个路由，播放、重播、步进、Esc 暂停、PNG、运行中切换中英文、恢复当日图例和简报打印通过 |

### 收尾实测输出

默认库在重新导出后执行 `audit_all.py --offline`：

```text
== 结果：55 通过 / 0 失败 / 3 跳过（共 58）==
EXIT=0
```

副本中只将 2026-11-25 交通运输行业的 `ret_r10` 加 `0.01`，审计结束后恢复原值：

```text
POISON 2026-11-25 交通运输: ret_r10 -0.087534029908 -> -0.077534029908
poisoned
== 结果：52 通过 / 3 失败 / 3 跳过（共 58）==
  FAIL payload sector_roll field mismatches expected 0 actual 1 diff 1.0
  FAIL rolling return mismatches, including NULL expected 0 actual 1 diff 1.0 max abs diff=0.01
  FAIL rolling rank mismatches, including ties and NULL expected 0 actual 2 diff 2.0
EXIT=1
restored
== 结果：55 通过 / 0 失败 / 3 跳过（共 58）==
EXIT=0
```

```text
139 passed in 16.00s
All checks passed!
ℹ tests 49
ℹ pass 49
ℹ fail 0
ℹ skipped 0
✓ built in 1.22s
EXIT=0
ashare-radar.html: 62485758 bytes | 2026-11-26 09:25:27 +08:00
```

## 本地交付

修改保存在工作区，`HEAD` 仍为 `bec21f8`。离线文件使用原项目默认的 `frontend/dist/ashare-radar.html`。`data/`、`frontend/dist/`、日志和 `.env` 由 Git 忽略。默认库无需重建，写入测试在副本上完成。

## 我不同意你的判断

1. 既有表行数相同只能说明行数相同。实际精确比较发现浮点尾差，逐键容差比较才支持既有结果在业务精度内等价。
2. 原 `63 通过` 不能证明全部窗口和静态字段正确。原抽样跳过单边空值，并从默认目录读静态数据。新审计记录覆盖范围不同，独立联网对账没有重跑。
3. 两个采样点落在同一整数区间时，扫描不到中间整数是预期。原问题是允许从缺失端借坐标，导致在无有效坐标的时段仍然绘图。修复从插值入口保留空值。

## 发布后必须做的操作

1. 确认推送分支的 GitHub Actions 通过，再创建 `v0.4.0` tag 和 Release。（历史：v0.4.0 已发布；当前发布请创建 `v0.4.3` tag，步骤见 [release.md](release.md)）
2. 部署机更新依赖并构建前端，运行 `python -m pipeline.release --rebuild` 后重启服务。
3. 检查滚动 API、行业轮动页和新离线包，确认下一次计划任务完成。详细顺序见 [发布说明](release.md)。
