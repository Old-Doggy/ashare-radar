PY ?= python
.PHONY: bootstrap update marts status export briefing test test-web typecheck verify lint build-web perf dev start stop all

bootstrap:
	$(PY) -m pipeline.bootstrap

update:
	$(PY) -m pipeline.release

marts:
	$(PY) -m pipeline.build_marts

status:
	$(PY) -m pipeline.refresh_status

# 生成单文件离线 dashboard（frontend/dist/ashare-radar.html + data/static-data.json）；
# 要求最新交易日质量门禁通过，可用 --allow-failed 以告警模式重导旧数据。
export:
	$(PY) -m pipeline.export_static

briefing:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/briefing.ps1

# 后端全量测试（tests/conftest.py 自带网络隔离与临时数据目录）。
test:
	$(PY) -m pytest -q

# 前端数据层/图表单元测试（node --test tests/*.test.mjs，含 fix-*.test.mjs）。
test-web:
	npm --prefix frontend test

# 前端 TypeScript 类型检查（tsc --noEmit，不产出 dist）。
typecheck:
	npm --prefix frontend run typecheck

# 集成收口：后端测试 + lint + 前端测试 + 类型检查（不构建 dist，避免打断已发布单文件）。
verify: lint test test-web typecheck

lint:
	$(PY) -m ruff check .

# 前端生产构建（写 frontend/dist；只在发布集成时手动执行，禁止与正在运行的更新并发）。
build-web:
	npm --prefix frontend run build

# API 延迟基准（只读 test_client / 本地服务；结果写入临时文件，不写生产数据）。
perf:
	$(PY) scripts/perf_api.py --repeat 20

dev:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev.ps1

start:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1

stop:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop.ps1

all: update briefing
