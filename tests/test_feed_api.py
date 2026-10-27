from datetime import datetime, timedelta

from app.models import FeedPosition, Newsletter
from tests.conftest import mark_read


def make_at(db, uid, received_at, subject=None):
    n = Newsletter(
        imap_uid=uid,
        subject=subject or uid,
        sender="sender@example.com",
        received_at=received_at,
        body_html=f"<p>{uid}</p>",
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


BASE = datetime(2026, 1, 1, 9, 0, 0)


def make_series(db, count=5):
    return [make_at(db, f"feed-{i}", BASE + timedelta(days=i)) for i in range(count)]


# ── Authentication guards ────────────────────────────────────────────────────


def test_feed_requires_auth(client):
    assert client.get("/api/feed").status_code == 401


def test_position_get_requires_auth(client):
    assert client.get("/api/feed/position").status_code == 401


def test_position_put_requires_auth(client):
    assert client.put("/api/feed/position", json={"newsletter_id": 1}).status_code == 401


# ── GET /api/feed ────────────────────────────────────────────────────────────


def test_feed_without_anchor_starts_at_oldest(client, auth_headers, db):
    items = make_series(db)
    data = client.get("/api/feed?limit=3", headers=auth_headers).json()
    assert [d["id"] for d in data] == [n.id for n in items[:3]]


def test_feed_includes_bodies(client, auth_headers, db):
    make_series(db, 1)
    data = client.get("/api/feed", headers=auth_headers).json()
    assert data[0]["body_html"] == "<p>feed-0</p>"


def test_feed_forward_excludes_anchor_by_default(client, auth_headers, db):
    items = make_series(db)
    data = client.get(f"/api/feed?anchor={items[1].id}&limit=2", headers=auth_headers).json()
    assert [d["id"] for d in data] == [items[2].id, items[3].id]


def test_feed_forward_include_anchor(client, auth_headers, db):
    items = make_series(db)
    data = client.get(
        f"/api/feed?anchor={items[1].id}&include_anchor=true&limit=2", headers=auth_headers
    ).json()
    assert [d["id"] for d in data] == [items[1].id, items[2].id]


def test_feed_backward_is_chronological(client, auth_headers, db):
    items = make_series(db)
    data = client.get(
        f"/api/feed?anchor={items[4].id}&direction=backward&limit=3", headers=auth_headers
    ).json()
    assert [d["id"] for d in data] == [items[1].id, items[2].id, items[3].id]


def test_feed_backward_at_start_is_empty(client, auth_headers, db):
    items = make_series(db)
    data = client.get(
        f"/api/feed?anchor={items[0].id}&direction=backward", headers=auth_headers
    ).json()
    assert data == []


def test_feed_orders_ties_by_id(client, auth_headers, db):
    a = make_at(db, "tie-a", BASE)
    b = make_at(db, "tie-b", BASE)
    c = make_at(db, "tie-c", BASE)
    fwd = client.get(f"/api/feed?anchor={a.id}", headers=auth_headers).json()
    assert [d["id"] for d in fwd] == [b.id, c.id]
    back = client.get(f"/api/feed?anchor={c.id}&direction=backward", headers=auth_headers).json()
    assert [d["id"] for d in back] == [a.id, b.id]


def test_feed_since_starts_at_first_on_or_after(client, auth_headers, db):
    items = make_series(db)
    data = client.get("/api/feed?since=2026-01-02T12:00:00Z&limit=1", headers=auth_headers).json()
    assert [d["id"] for d in data] == [items[2].id]


def test_feed_backward_without_anchor_is_newest(client, auth_headers, db):
    items = make_series(db)
    data = client.get("/api/feed?direction=backward&limit=1", headers=auth_headers).json()
    assert [d["id"] for d in data] == [items[-1].id]


def test_feed_since_in_future_is_empty(client, auth_headers, db):
    make_series(db)
    assert client.get("/api/feed?since=2099-01-01T00:00:00Z", headers=auth_headers).json() == []


def test_feed_unknown_anchor_404(client, auth_headers):
    assert client.get("/api/feed?anchor=999999", headers=auth_headers).status_code == 404


def test_feed_reports_read_state(client, auth_headers, db):
    items = make_series(db, 2)
    mark_read(db, items[0])
    data = client.get("/api/feed", headers=auth_headers).json()
    assert [d["is_read"] for d in data] == [True, False]


# ── GET /api/feed/position ───────────────────────────────────────────────────


def test_position_defaults_to_oldest_unread(client, auth_headers, db):
    items = make_series(db)
    mark_read(db, items[0])
    mark_read(db, items[1])
    data = client.get("/api/feed/position", headers=auth_headers).json()
    assert data == {"newsletter_id": items[2].id, "offset": 0.0, "anchor": None, "updated_at": None, "saved": False}


def test_position_defaults_to_newest_when_all_read(client, auth_headers, db):
    items = make_series(db, 3)
    for n in items:
        mark_read(db, n)
    data = client.get("/api/feed/position", headers=auth_headers).json()
    assert data["newsletter_id"] == items[2].id
    assert data["saved"] is False


def test_position_empty_db(client, auth_headers):
    data = client.get("/api/feed/position", headers=auth_headers).json()
    assert data["newsletter_id"] is None


# ── PUT /api/feed/position ───────────────────────────────────────────────────


def test_put_position_round_trip(client, auth_headers, db):
    items = make_series(db)
    r = client.put(
        "/api/feed/position", json={"newsletter_id": items[3].id, "offset": 0.42}, headers=auth_headers
    )
    assert r.status_code == 200
    data = client.get("/api/feed/position", headers=auth_headers).json()
    assert data["newsletter_id"] == items[3].id
    assert data["offset"] == 0.42
    assert data["saved"] is True


def test_put_position_overwrites(client, auth_headers, db):
    items = make_series(db)
    client.put("/api/feed/position", json={"newsletter_id": items[1].id}, headers=auth_headers)
    client.put("/api/feed/position", json={"newsletter_id": items[2].id, "offset": 0.1}, headers=auth_headers)
    assert db.query(FeedPosition).count() == 1
    assert client.get("/api/feed/position", headers=auth_headers).json()["newsletter_id"] == items[2].id


def test_put_position_ignores_stale_update(client, auth_headers, db):
    items = make_series(db)
    client.put(
        "/api/feed/position",
        json={"newsletter_id": items[3].id, "updated_at": "2026-05-02T12:00:00Z"},
        headers=auth_headers,
    )
    r = client.put(
        "/api/feed/position",
        json={"newsletter_id": items[1].id, "updated_at": "2026-05-01T12:00:00Z"},
        headers=auth_headers,
    )
    assert r.json()["newsletter_id"] == items[3].id


def test_put_position_rejects_bad_offset(client, auth_headers, db):
    items = make_series(db, 1)
    r = client.put(
        "/api/feed/position", json={"newsletter_id": items[0].id, "offset": 1.5}, headers=auth_headers
    )
    assert r.status_code == 422


def test_put_position_unknown_newsletter_404(client, auth_headers):
    r = client.put("/api/feed/position", json={"newsletter_id": 999999}, headers=auth_headers)
    assert r.status_code == 404


def test_put_position_stores_anchor(client, auth_headers, db):
    items = make_series(db)
    client.put(
        "/api/feed/position",
        json={"newsletter_id": items[1].id, "offset": 0.3, "anchor": "The quick brown fox"},
        headers=auth_headers,
    )
    data = client.get("/api/feed/position", headers=auth_headers).json()
    assert data["anchor"] == "The quick brown fox"


def test_put_position_without_anchor_clears_it(client, auth_headers, db):
    items = make_series(db)
    client.put("/api/feed/position", json={"newsletter_id": items[1].id, "anchor": "old text here"}, headers=auth_headers)
    client.put("/api/feed/position", json={"newsletter_id": items[1].id, "offset": 0.5}, headers=auth_headers)
    assert client.get("/api/feed/position", headers=auth_headers).json()["anchor"] is None
