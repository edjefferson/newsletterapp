import time

import pytest

import app.routes.sync as sync_module


@pytest.fixture()
def sync_idle():
    """Wait for the lifespan-triggered initial sync to finish, then yield."""
    # The lifespan fires a background sync thread on startup; poll until it settles.
    for _ in range(50):
        if not sync_module._sync_status["running"]:
            break
        time.sleep(0.05)
    yield


def test_sync_requires_auth(client):
    resp = client.post("/api/sync")
    assert resp.status_code == 401


def test_sync_status_requires_auth(client):
    resp = client.get("/api/sync/status")
    assert resp.status_code == 401


def test_sync_status_shape(client, auth_headers):
    resp = client.get("/api/sync/status", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "running" in data
    assert "last_inserted" in data
    assert "last_error" in data


def test_sync_status_initially_not_running(client, auth_headers, sync_idle):
    resp = client.get("/api/sync/status", headers=auth_headers)
    assert resp.json()["running"] is False


def test_sync_starts_background_thread(client, auth_headers, sync_idle):
    resp = client.post("/api/sync", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["status"] == "started"


def test_sync_already_running_returns_status(client, auth_headers):
    original = sync_module._sync_status["running"]
    sync_module._sync_status["running"] = True
    try:
        resp = client.post("/api/sync", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["status"] == "already_running"
    finally:
        sync_module._sync_status["running"] = original
