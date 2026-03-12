from app.auth import make_token


def test_login_correct_password(client):
    resp = client.post("/api/login", json={"password": "test-password"})
    assert resp.status_code == 200
    data = resp.json()
    assert "token" in data
    assert len(data["token"]) == 64


def test_login_wrong_password(client):
    resp = client.post("/api/login", json={"password": "wrong"})
    assert resp.status_code == 401


def test_login_empty_password(client):
    resp = client.post("/api/login", json={"password": ""})
    assert resp.status_code == 401


def test_login_missing_password_field(client):
    resp = client.post("/api/login", json={})
    assert resp.status_code == 422


def test_login_extra_fields_ignored(client):
    resp = client.post("/api/login", json={"password": "test-password", "extra": "x"})
    assert resp.status_code == 200


def test_login_token_is_usable(client):
    resp = client.post("/api/login", json={"password": "test-password"})
    token = resp.json()["token"]
    resp2 = client.get("/api/newsletters", headers={"Authorization": f"Bearer {token}"})
    assert resp2.status_code == 200


def test_login_wrong_then_correct(client):
    resp1 = client.post("/api/login", json={"password": "bad"})
    assert resp1.status_code == 401
    resp2 = client.post("/api/login", json={"password": "test-password"})
    assert resp2.status_code == 200
