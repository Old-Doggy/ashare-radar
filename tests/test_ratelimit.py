"""Tushare 限速器单元测试（无网络、无真实 sleep）。"""

import pytest

from pipeline.ratelimit import (
    RateLimiter,
    call,
    is_permission_error,
    is_rate_limit_error,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_limiter(clock: FakeClock, **kwargs) -> RateLimiter:
    options = dict(
        global_per_min=1000,
        min_interval=0.0,
        per_api_per_min={},
        daily_total={},
        clock=clock.clock,
        sleep=clock.sleep,
    )
    options.update(kwargs)
    return RateLimiter(**options)


def test_global_sliding_window_blocks_third_request() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock, global_per_min=2)
    assert limiter.acquire("daily") == 0.0
    assert limiter.acquire("daily_basic") == 0.0
    waited = limiter.acquire("adj_factor")
    assert waited == pytest.approx(60.0)
    assert clock.now == pytest.approx(60.0)
    stats = limiter.stats()
    assert stats["requests"] == 3
    assert stats["per_api"]["adj_factor"]["requests"] == 1


def test_per_api_limit_is_stricter_than_global() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock, global_per_min=1000, per_api_per_min={"limit_list_d": 1})
    assert limiter.acquire("limit_list_d") == 0.0
    assert limiter.acquire("limit_list_d") == pytest.approx(60.0)
    # 其它接口不受 limit_list_d 的单独限制影响
    assert limiter.acquire("daily") == 0.0


def test_min_interval_keeps_requests_apart() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock, min_interval=0.2)
    limiter.acquire("daily")
    assert limiter.acquire("daily") == pytest.approx(0.2)
    assert clock.sleeps == [pytest.approx(0.2)]


def test_daily_total_budget_raises_clear_error() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock, daily_total={"limit_list_d": 2})
    limiter.acquire("limit_list_d")
    limiter.acquire("limit_list_d")
    with pytest.raises(RuntimeError) as excinfo:
        limiter.acquire("limit_list_d")
    assert "每日请求预算" in str(excinfo.value)
    # 预算只作用于该接口
    assert limiter.acquire("daily") == 0.0


def test_call_retries_rate_limit_error_with_backoff() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock)
    attempts: list[int] = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise Exception("抱歉，您每分钟最多访问该接口200次")
        return "ok"

    result = call("limit_list_d", flaky, limiter=limiter, max_attempts=5,
                  base_delay=1.0, sleep=clock.sleep)
    assert result == "ok"
    assert len(attempts) == 3
    assert len(clock.sleeps) == 2
    assert clock.sleeps[1] > clock.sleeps[0]


def test_call_does_not_retry_permission_errors() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock)
    calls: list[int] = []

    def denied():
        calls.append(1)
        raise Exception("抱歉，您没有访问该接口的权限")

    with pytest.raises(Exception):
        call("limit_list_d", denied, limiter=limiter, sleep=clock.sleep)
    assert len(calls) == 1
    assert clock.sleeps == []


def test_call_does_not_retry_plain_errors() -> None:
    clock = FakeClock()
    limiter = make_limiter(clock)
    calls: list[int] = []

    def broken():
        calls.append(1)
        raise ValueError("bad payload")

    with pytest.raises(ValueError):
        call("daily", broken, limiter=limiter, sleep=clock.sleep)
    assert len(calls) == 1


def test_error_classification() -> None:
    assert is_rate_limit_error(Exception("您每分钟最多访问该接口200次"))
    assert is_rate_limit_error(Exception("rate limit exceeded"))
    assert not is_rate_limit_error(Exception("invalid ts_code"))
    assert is_permission_error(Exception("抱歉，您没有访问该接口的权限"))
    assert is_permission_error(Exception("积分不足"))
    assert not is_permission_error(Exception("每分钟最多访问该接口200次"))


def test_rate_limiter_uses_environment_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = FakeClock()
    monkeypatch.setenv("TUSHARE_RATE_GLOBAL_PER_MIN", "2")
    monkeypatch.setenv("TUSHARE_RATE_MIN_INTERVAL", "0")
    monkeypatch.setenv("TUSHARE_RATE_LIMITS_JSON", '{"limit_list_d": 1}')
    monkeypatch.setenv("TUSHARE_RATE_DAILY_TOTAL_JSON", '{"limit_list_d": 5}')
    limiter = RateLimiter(clock=clock.clock, sleep=clock.sleep)
    assert limiter.global_per_min == 2
    assert limiter.min_interval == 0
    assert limiter.per_api_per_min["limit_list_d"] == 1
    assert limiter.daily_total["limit_list_d"] == 5
