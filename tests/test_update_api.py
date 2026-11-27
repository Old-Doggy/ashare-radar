"""更新接口契约：自定义头鉴权、状态形状、并发 409、超时可配置。"""
from __future__ import annotations

import backend.main as api

HEADERS = {"X-Ashare-Radar": "1"}


def test_update_requires_custom_header():
    """跨站请求无法带自定义头，避免任意网页触发本地更新。"""
    with api.app.test_client() as c:
        r = c.post("/api/update")
    assert r.status_code == 403


def test_update_status_shape():
    with api.app.test_client() as c:
        r = c.get("/api/update/status")
    assert r.status_code == 200
    data = r.get_json()
    assert data["state"] in {"idle", "running", "done", "failed"}
    assert "progress" in data


def test_update_rejects_second_start_while_running(monkeypatch):
    """运行中再次 POST 必须返回 409 JSON，调用方能区分“已接受/未入队”。"""
    monkeypatch.setattr(api, "_run_update_job", lambda: None)
    with api.app.test_client() as c:
        first = c.post("/api/update", headers=HEADERS)
        second = c.post("/api/update", headers=HEADERS)
    assert first.status_code == 202
    assert second.status_code == 409
    body = second.get_json()
    assert body["error"] == "update already running"
    assert body["job"]["state"] == "running"


def test_update_timeout_is_configurable(monkeypatch):
    monkeypatch.delenv("ASHARE_RADAR_UPDATE_TIMEOUT", raising=False)
    assert api._update_timeout() == api.DEFAULT_UPDATE_TIMEOUT
    monkeypatch.setenv("ASHARE_RADAR_UPDATE_TIMEOUT", "120")
    assert api._update_timeout() == 120
    # 非法/非正值回退默认，避免误配把超时归零
    monkeypatch.setenv("ASHARE_RADAR_UPDATE_TIMEOUT", "0")
    assert api._update_timeout() == api.DEFAULT_UPDATE_TIMEOUT
    monkeypatch.setenv("ASHARE_RADAR_UPDATE_TIMEOUT", "not-a-number")
    assert api._update_timeout() == api.DEFAULT_UPDATE_TIMEOUT
