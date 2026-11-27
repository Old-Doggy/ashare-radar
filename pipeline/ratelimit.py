"""Tushare Pro 请求节流与限频退避。

官方限制（2026-11-27 查阅 tushare.pro/document/2?doc_id=290 及各接口文档）：
- 5000 积分账号：整体 **500 次/分钟**；常规数据每天总量无上限
  （2000 积分为 200 次/分钟、单接口每天 10 万次）；
- `limit_list_d`（涨跌停列表）：**200 次/分钟且每天总量 1 万次**
  （8000 积分以上才是 500 次/分钟、无日总量限制）；
- `stock_basic`：**50 次/分钟**（文档明确建议拉一次后本地缓存）；
- daily / daily_basic / adj_factor / stk_limit / moneyflow / margin / index_daily /
  trade_cal：按积分表，5000 积分即 500 次/分钟。

这里的默认值在官方上限上留 20%–40% 余量（400 次/分钟、limit_list_d 160 次/分钟、
stock_basic 40 次/分钟、limit_list_d 每天 9000 次），并保证任意两次请求间隔 ≥0.15s，
避免“瞬时突发”触发风控。所有阈值都可用环境变量覆盖，见 docs/rate_limits.md。
"""
from __future__ import annotations

import json
import os
import random
import re
import threading
import time
from collections import defaultdict, deque

# ---------------------------------------------------------------- 默认限值
DEFAULT_GLOBAL_PER_MIN = 400        # 官方 500/min，留 20% 余量
DEFAULT_MIN_INTERVAL = 0.15         # 任意两次请求最小间隔（≈6.7 次/秒）
DEFAULT_PER_API_PER_MIN = {
    "limit_list_d": 160,            # 官方 200/min（且 1 万次/天）
    "stock_basic": 40,              # 官方 50/min
}
DEFAULT_DAILY_TOTAL = {
    "limit_list_d": 9000,           # 官方 1 万次/天
}
DEFAULT_MAX_ATTEMPTS = 6
DEFAULT_BASE_DELAY = 2.0            # 指数退避：2,4,8,16,32s（+ 抖动）

RATE_LIMIT_RE = re.compile(
    r"(每分钟|访问频率|频率限制|最多访问|请求过于频繁|rate[\s_-]?limit|"
    r"too many requests|限流|超过.{0,8}次)",
    re.IGNORECASE,
)
PERMISSION_RE = re.compile(
    r"(没有权限|权限不足|无权限|没有访问该接口的权限|积分不足|权限不够|not\s*permission)",
    re.IGNORECASE,
)
TRANSIENT_RE = re.compile(
    r"(timed?\s*out|timeout|connection\s*(reset|aborted|error)|"
    r"temporarily unavailable|502|503|504)",
    re.IGNORECASE,
)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(float(raw))
    except ValueError:
        return default
    return value if value > 0 else default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value >= 0 else default


def _env_mapping(name: str, default: dict[str, int]) -> dict[str, int]:
    raw = os.getenv(name)
    merged = dict(default)
    if not raw:
        return merged
    try:
        data = json.loads(raw)
    except ValueError:
        return merged
    if not isinstance(data, dict):
        return merged
    for key, value in data.items():
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            continue
        if number > 0:
            merged[str(key)] = number
    return merged


def is_rate_limit_error(exc: BaseException) -> bool:
    return bool(RATE_LIMIT_RE.search(str(exc)))


def is_permission_error(exc: BaseException) -> bool:
    """无权限/积分不足：重试没有意义，调用方应跳过该接口而不是反复烧请求。"""
    return bool(PERMISSION_RE.search(str(exc)))


def is_transient_error(exc: BaseException) -> bool:
    name = type(exc).__name__
    if name in {"Timeout", "ConnectTimeout", "ReadTimeout", "ConnectionError", "HTTPError"}:
        return True
    return bool(TRANSIENT_RE.search(str(exc)))


class RateLimiter:
    """滑动窗口限速器：全局限速 + 单接口限速 + 最小间隔 + 单接口日总量预算。"""

    def __init__(
        self,
        *,
        global_per_min: int | None = None,
        min_interval: float | None = None,
        per_api_per_min: dict[str, int] | None = None,
        daily_total: dict[str, int] | None = None,
        clock=time.monotonic,
        sleep=time.sleep,
    ) -> None:
        self.global_per_min = int(global_per_min or _env_int(
            "TUSHARE_RATE_GLOBAL_PER_MIN", DEFAULT_GLOBAL_PER_MIN))
        self.min_interval = float(
            _env_float("TUSHARE_RATE_MIN_INTERVAL", DEFAULT_MIN_INTERVAL)
            if min_interval is None else min_interval)
        self.per_api_per_min = dict(DEFAULT_PER_API_PER_MIN)
        self.per_api_per_min.update(
            _env_mapping("TUSHARE_RATE_LIMITS_JSON", DEFAULT_PER_API_PER_MIN)
            if per_api_per_min is None else per_api_per_min)
        self.daily_total = dict(
            _env_mapping("TUSHARE_RATE_DAILY_TOTAL_JSON", DEFAULT_DAILY_TOTAL)
            if daily_total is None else daily_total)
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._global_events: deque[float] = deque()
        self._api_events: dict[str, deque[float]] = defaultdict(deque)
        self._last_event: float | None = None
        self._daily_counts: dict[str, int] = defaultdict(int)
        self._day_start: float | None = None
        self._requests = 0
        self._waited = 0.0
        self._per_api_count: dict[str, int] = defaultdict(int)
        self._per_api_waited: dict[str, float] = defaultdict(float)

    # -------------------------------------------------------------- 内部
    def _roll_day(self, now: float) -> None:
        if self._day_start is None or now - self._day_start >= 86400:
            self._day_start = now
            self._daily_counts.clear()

    def _prune(self, events: deque[float], now: float) -> None:
        while events and now - events[0] >= 60.0:
            events.popleft()

    # -------------------------------------------------------------- 对外
    def acquire(self, api: str) -> float:
        """阻塞直到允许发一次 `api` 请求；返回实际等待秒数。"""
        with self._lock:
            now = self._clock()
            self._roll_day(now)
            self._prune(self._global_events, now)
            api_events = self._api_events[api]
            self._prune(api_events, now)

            waits = [0.0]
            if len(self._global_events) >= self.global_per_min:
                waits.append(60.0 - (now - self._global_events[0]))
            api_limit = self.per_api_per_min.get(api, self.global_per_min)
            if len(api_events) >= api_limit:
                waits.append(60.0 - (now - api_events[0]))
            if self._last_event is not None:
                waits.append(self.min_interval - (now - self._last_event))
            budget = self.daily_total.get(api)
            if budget is not None and self._daily_counts[api] >= budget:
                raise RuntimeError(
                    f"{api} 已达到每日请求预算 {budget} 次（Tushare 官方上限更低，"
                    "请明天继续或调低 TUSHARE_RATE_DAILY_TOTAL_JSON）")

            wait = max(0.0, max(waits))
            if wait > 0:
                self._sleep(wait)
                now = self._clock()

            self._global_events.append(now)
            api_events.append(now)
            self._last_event = now
            self._daily_counts[api] += 1
            self._requests += 1
            self._waited += wait
            self._per_api_count[api] += 1
            self._per_api_waited[api] += wait
            return wait

    def stats(self) -> dict:
        with self._lock:
            return {
                "requests": self._requests,
                "waited_sec": round(self._waited, 1),
                "per_api": {
                    api: {"requests": self._per_api_count[api],
                          "waited_sec": round(self._per_api_waited[api], 1)}
                    for api in sorted(self._per_api_count)
                },
                "limits": {
                    "global_per_min": self.global_per_min,
                    "min_interval_sec": self.min_interval,
                    "per_api_per_min": self.per_api_per_min,
                    "daily_total": self.daily_total,
                },
            }

    def reset(self) -> None:
        with self._lock:
            self._global_events.clear()
            self._api_events.clear()
            self._last_event = None
            self._daily_counts.clear()
            self._day_start = None


_default: RateLimiter | None = None
_default_lock = threading.Lock()


def default_limiter() -> RateLimiter:
    global _default
    with _default_lock:
        if _default is None:
            _default = RateLimiter()
        return _default


def reset_default_limiter() -> None:
    global _default
    with _default_lock:
        _default = None


def call(
    api: str,
    fn,
    *,
    limiter: RateLimiter | None = None,
    max_attempts: int | None = None,
    base_delay: float | None = None,
    sleep=None,
    on_retry=None,
):
    """节流后执行一次 Tushare 调用；限频/瞬时错误按指数退避重试，权限错误立即抛出。"""
    limiter = limiter or default_limiter()
    attempts = max_attempts if max_attempts is not None else _env_int(
        "TUSHARE_RATE_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS)
    delay = base_delay if base_delay is not None else _env_float(
        "TUSHARE_RATE_BASE_DELAY", DEFAULT_BASE_DELAY)
    sleeper = sleep or time.sleep
    last_exc: BaseException | None = None
    for attempt in range(1, max(1, attempts) + 1):
        limiter.acquire(api)
        try:
            return fn()
        except BaseException as exc:  # noqa: BLE001 - 需要按异常类型分类处理
            last_exc = exc
            if is_permission_error(exc):
                raise
            retryable = is_rate_limit_error(exc) or is_transient_error(exc)
            if not retryable or attempt >= attempts:
                raise
            backoff = delay * (2 ** (attempt - 1)) + random.uniform(0.0, 1.0)
            if on_retry is not None:
                on_retry(api, exc, attempt, backoff)
            sleeper(backoff)
    assert last_exc is not None  # pragma: no cover - 理论不可达
    raise last_exc  # pragma: no cover
