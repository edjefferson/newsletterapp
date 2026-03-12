import hashlib
import hmac
import os

import pytest

from app.auth import make_token


# ── Pure function tests ──────────────────────────────────────────────────────


def test_make_token_returns_64_char_hex():
    token = make_token()
    assert len(token) == 64
    assert all(c in "0123456789abcdef" for c in token)


def test_make_token_is_deterministic():
    assert make_token() == make_token()


def test_make_token_matches_hmac_sha256_formula():
    expected = hmac.new(
        os.environ["SECRET_KEY"].encode(),
        os.environ["APP_PASSWORD"].encode(),
        hashlib.sha256,
    ).hexdigest()
    assert make_token() == expected


def test_make_token_changes_with_different_password(monkeypatch):
    original = make_token()
    monkeypatch.setenv("APP_PASSWORD", "different-password")
    assert make_token() != original


def test_make_token_changes_with_different_secret(monkeypatch):
    original = make_token()
    monkeypatch.setenv("SECRET_KEY", "different-secret")
    assert make_token() != original


def test_secret_key_missing_raises_runtime_error(monkeypatch):
    monkeypatch.delenv("SECRET_KEY")
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        make_token()


# ── API auth tests ───────────────────────────────────────────────────────────


def test_authenticated_request_with_valid_token(client, auth_headers, db):
    resp = client.get("/api/newsletters", headers=auth_headers)
    assert resp.status_code == 200


def test_authenticated_request_with_wrong_token(client):
    resp = client.get("/api/newsletters", headers={"Authorization": "Bearer wrongtoken"})
    assert resp.status_code == 401


def test_authenticated_request_with_no_token(client):
    resp = client.get("/api/newsletters")
    assert resp.status_code == 401


def test_authenticated_request_with_malformed_header(client):
    resp = client.get("/api/newsletters", headers={"Authorization": "Bearer"})
    assert resp.status_code == 401


def test_login_token_matches_make_token(client):
    resp = client.post("/api/login", json={"password": "test-password"})
    assert resp.status_code == 200
    assert resp.json()["token"] == make_token()
