from datetime import datetime, timedelta, timezone


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)

import pytest

from app.models import Newsletter, ReadingProgress
from tests.conftest import make_newsletter, mark_read


# ── Authentication guards ────────────────────────────────────────────────────


def test_list_requires_auth(client):
    assert client.get("/api/newsletters").status_code == 401


def test_get_requires_auth(client, db):
    n = make_newsletter(db, "uid-auth-get")
    assert client.get(f"/api/newsletters/{n.id}").status_code == 401


def test_progress_post_requires_auth(client, db):
    n = make_newsletter(db, "uid-auth-post")
    assert client.post(f"/api/newsletters/{n.id}/progress", json={"scroll_position": 0}).status_code == 401


def test_progress_get_requires_auth(client):
    assert client.get("/api/newsletters/progress").status_code == 401


def test_mark_old_read_requires_auth(client):
    assert client.post("/api/newsletters/mark-old-read").status_code == 401


# ── GET /api/newsletters ─────────────────────────────────────────────────────


def test_list_empty(client, auth_headers):
    resp = client.get("/api/newsletters", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_returns_correct_count(client, auth_headers, db):
    make_newsletter(db, "uid-count-1")
    make_newsletter(db, "uid-count-2")
    make_newsletter(db, "uid-count-3")
    resp = client.get("/api/newsletters", headers=auth_headers)
    assert len(resp.json()) == 3


def test_list_unread_filter_excludes_read(client, auth_headers, db):
    n1 = make_newsletter(db, "uid-unread-1")
    n2 = make_newsletter(db, "uid-unread-2")
    mark_read(db, n2)
    resp = client.get("/api/newsletters?unread=true", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert n1.id in ids
    assert n2.id not in ids


def test_list_unread_filter_includes_no_progress_rows(client, auth_headers, db):
    n = make_newsletter(db, "uid-no-progress")
    resp = client.get("/api/newsletters?unread=true", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert n.id in ids


def test_list_all_filter_includes_read_and_unread(client, auth_headers, db):
    n1 = make_newsletter(db, "uid-all-1")
    n2 = make_newsletter(db, "uid-all-2")
    mark_read(db, n2)
    resp = client.get("/api/newsletters?unread=false", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert n1.id in ids
    assert n2.id in ids


def test_list_default_hides_body_html(client, auth_headers, db):
    make_newsletter(db, "uid-hide-html", body_html="<p>secret</p>")
    resp = client.get("/api/newsletters", headers=auth_headers)
    for item in resp.json():
        assert item["body_html"] is None


def test_list_default_hides_body_text(client, auth_headers, db):
    make_newsletter(db, "uid-hide-text", body_text="secret text")
    resp = client.get("/api/newsletters", headers=auth_headers)
    for item in resp.json():
        assert item["body_text"] is None


def test_list_full_true_returns_body_html(client, auth_headers, db):
    make_newsletter(db, "uid-full", body_html="<p>visible</p>")
    resp = client.get("/api/newsletters?full=true", headers=auth_headers)
    bodies = [item["body_html"] for item in resp.json()]
    assert any(b is not None for b in bodies)


def test_list_sorted_newest_first(client, auth_headers, db):
    old = make_newsletter(db, "uid-old", days_old=10)
    new = make_newsletter(db, "uid-new", days_old=0)
    resp = client.get("/api/newsletters", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert ids.index(new.id) < ids.index(old.id)


def test_list_pagination_page1(client, auth_headers, db):
    for i in range(5):
        make_newsletter(db, f"uid-page-{i}")
    resp = client.get("/api/newsletters?page=1&page_size=3", headers=auth_headers)
    assert len(resp.json()) == 3


def test_list_pagination_page2(client, auth_headers, db):
    for i in range(5):
        make_newsletter(db, f"uid-page2-{i}")
    resp = client.get("/api/newsletters?page=2&page_size=3", headers=auth_headers)
    assert len(resp.json()) == 2


def test_list_pagination_last_page_partial(client, auth_headers, db):
    for i in range(7):
        make_newsletter(db, f"uid-ppart-{i}")
    resp = client.get("/api/newsletters?page=3&page_size=3", headers=auth_headers)
    assert len(resp.json()) == 1


def test_list_after_id_only_returns_newer(client, auth_headers, db):
    n1 = make_newsletter(db, "uid-afterid-1", days_old=5)
    n2 = make_newsletter(db, "uid-afterid-2", days_old=3)
    n3 = make_newsletter(db, "uid-afterid-3", days_old=1)
    resp = client.get(f"/api/newsletters?after_id={n1.id}", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert n1.id not in ids
    assert n2.id in ids
    assert n3.id in ids


def test_list_since_filter(client, auth_headers, db):
    old = make_newsletter(db, "uid-since-old", days_old=10)
    recent = make_newsletter(db, "uid-since-recent", days_old=0)
    since = (_utcnow() - timedelta(days=5)).isoformat()
    resp = client.get(f"/api/newsletters?since={since}", headers=auth_headers)
    ids = [item["id"] for item in resp.json()]
    assert recent.id in ids
    assert old.id not in ids


# ── GET /api/newsletters/{id} ────────────────────────────────────────────────


def test_get_found_includes_body(client, auth_headers, db):
    n = make_newsletter(db, "uid-get-body", body_html="<p>full body</p>")
    resp = client.get(f"/api/newsletters/{n.id}", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json()["body_html"] is not None


def test_get_not_found_404(client, auth_headers):
    resp = client.get("/api/newsletters/999999", headers=auth_headers)
    assert resp.status_code == 404


def test_get_defaults_is_read_false(client, auth_headers, db):
    n = make_newsletter(db, "uid-get-unread")
    resp = client.get(f"/api/newsletters/{n.id}", headers=auth_headers)
    assert resp.json()["is_read"] is False


def test_get_defaults_scroll_position_zero(client, auth_headers, db):
    n = make_newsletter(db, "uid-get-scroll")
    resp = client.get(f"/api/newsletters/{n.id}", headers=auth_headers)
    assert resp.json()["scroll_position"] == 0


def test_get_reflects_saved_progress(client, auth_headers, db):
    n = make_newsletter(db, "uid-get-progress")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 300, "is_read": True},
        headers=auth_headers,
    )
    resp = client.get(f"/api/newsletters/{n.id}", headers=auth_headers)
    data = resp.json()
    assert data["is_read"] is True
    assert data["scroll_position"] == 300


# ── POST /api/newsletters/{id}/progress ─────────────────────────────────────


def test_save_progress_creates_new_row(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-create")
    resp = client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 100, "is_read": False},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    db.expire_all()
    db.refresh(n)
    assert n.progress is not None


def test_save_progress_sets_scroll_position(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-scroll")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 750, "is_read": False},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.scroll_position == 750


def test_save_progress_sets_is_read_false(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-unread")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": False},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.is_read is False


def test_save_progress_updates_existing_scroll(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-update")
    client.post(f"/api/newsletters/{n.id}/progress", json={"scroll_position": 100}, headers=auth_headers)
    client.post(f"/api/newsletters/{n.id}/progress", json={"scroll_position": 500}, headers=auth_headers)
    db.expire_all()
    db.refresh(n)
    assert n.progress.scroll_position == 500


def test_save_progress_marks_as_read(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-read")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": True},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.is_read is True


def test_save_progress_marks_as_unread(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-unmark")
    mark_read(db, n)
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": False},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.is_read is False


def test_save_progress_sets_read_at_on_first_read(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-readat")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": True},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.read_at is not None


def test_save_progress_does_not_update_read_at_on_second_read(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-readat2")
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": True},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    first_read_at = n.progress.read_at

    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 100, "is_read": True},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    # read_at should not be updated on the second read (code only sets it when transitioning to read)
    assert n.progress.read_at == first_read_at


def test_save_progress_clears_read_at_when_unmarked(client, auth_headers, db):
    n = make_newsletter(db, "uid-prog-clearreadAt")
    mark_read(db, n)
    client.post(
        f"/api/newsletters/{n.id}/progress",
        json={"scroll_position": 0, "is_read": False},
        headers=auth_headers,
    )
    db.expire_all()
    db.refresh(n)
    assert n.progress.read_at is None


def test_save_progress_404_for_missing(client, auth_headers):
    resp = client.post(
        "/api/newsletters/999999/progress",
        json={"scroll_position": 0},
        headers=auth_headers,
    )
    assert resp.status_code == 404


# ── GET /api/newsletters/progress ───────────────────────────────────────────


def test_list_progress_empty(client, auth_headers):
    resp = client.get("/api/newsletters/progress", headers=auth_headers)
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_progress_returns_all_rows(client, auth_headers, db):
    n1 = make_newsletter(db, "uid-lp-1")
    n2 = make_newsletter(db, "uid-lp-2")
    n3 = make_newsletter(db, "uid-lp-3")
    mark_read(db, n1)
    mark_read(db, n2)
    mark_read(db, n3)
    resp = client.get("/api/newsletters/progress", headers=auth_headers)
    assert len(resp.json()) == 3


def test_list_progress_shape(client, auth_headers, db):
    n = make_newsletter(db, "uid-lp-shape")
    mark_read(db, n, scroll=200)
    resp = client.get("/api/newsletters/progress", headers=auth_headers)
    item = resp.json()[0]
    assert "server_id" in item
    assert "is_read" in item
    assert "scroll_position" in item
    assert "updated_at" in item


def test_list_progress_since_filter(client, auth_headers, db):
    n1 = make_newsletter(db, "uid-lp-since-1")
    n2 = make_newsletter(db, "uid-lp-since-2")

    # Create old progress row
    old_time = _utcnow() - timedelta(days=5)
    p_old = ReadingProgress(
        newsletter_id=n1.id,
        is_read=True,
        scroll_position=0,
        read_at=old_time,
        updated_at=old_time,
    )
    db.add(p_old)

    # Create recent progress row
    recent_time = _utcnow()
    p_recent = ReadingProgress(
        newsletter_id=n2.id,
        is_read=True,
        scroll_position=0,
        read_at=recent_time,
        updated_at=recent_time,
    )
    db.add(p_recent)
    db.commit()

    since = (_utcnow() - timedelta(days=1)).isoformat()
    resp = client.get(f"/api/newsletters/progress?since={since}", headers=auth_headers)
    server_ids = [item["server_id"] for item in resp.json()]
    assert n2.id in server_ids
    assert n1.id not in server_ids


def test_list_progress_since_excludes_older(client, auth_headers, db):
    n = make_newsletter(db, "uid-lp-since-excl")
    old_time = _utcnow() - timedelta(days=10)
    p = ReadingProgress(
        newsletter_id=n.id,
        is_read=True,
        scroll_position=0,
        read_at=old_time,
        updated_at=old_time,
    )
    db.add(p)
    db.commit()

    since = (_utcnow() - timedelta(days=1)).isoformat()
    resp = client.get(f"/api/newsletters/progress?since={since}", headers=auth_headers)
    server_ids = [item["server_id"] for item in resp.json()]
    assert n.id not in server_ids


# ── POST /api/newsletters/mark-old-read ─────────────────────────────────────


def test_mark_old_read_marks_old_unread(client, auth_headers, db):
    n = make_newsletter(db, "uid-mor-old", days_old=10)
    resp = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp.status_code == 200
    db.expire_all()
    db.refresh(n)
    assert n.progress is not None
    assert n.progress.is_read is True


def test_mark_old_read_leaves_recent_alone(client, auth_headers, db):
    n = make_newsletter(db, "uid-mor-recent", days_old=2)
    resp = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp.status_code == 200
    db.expire_all()
    db.refresh(n)
    assert n.progress is None or n.progress.is_read is False


def test_mark_old_read_skips_already_read(client, auth_headers, db):
    n = make_newsletter(db, "uid-mor-already", days_old=10)
    mark_read(db, n)
    resp = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp.json()["marked"] == 0


def test_mark_old_read_returns_correct_count(client, auth_headers, db):
    make_newsletter(db, "uid-mor-cnt-1", days_old=10)
    make_newsletter(db, "uid-mor-cnt-2", days_old=15)
    make_newsletter(db, "uid-mor-cnt-3", days_old=20)
    resp = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp.json()["marked"] == 3


def test_mark_old_read_idempotent(client, auth_headers, db):
    make_newsletter(db, "uid-mor-idem", days_old=10)
    client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    resp2 = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp2.json()["marked"] == 0


def test_mark_old_read_zero_when_nothing_old(client, auth_headers, db):
    make_newsletter(db, "uid-mor-zero", days_old=1)
    resp = client.post("/api/newsletters/mark-old-read", headers=auth_headers)
    assert resp.json()["marked"] == 0
