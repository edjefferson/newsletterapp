from tests.conftest import make_newsletter


def test_create_article_requires_auth(client):
    resp = client.post("/api/articles", json={"title": "T", "author": "A"})
    assert resp.status_code == 401


def test_create_article_minimal(client, auth_headers):
    resp = client.post("/api/articles", json={"title": "My Article", "author": "Jane"}, headers=auth_headers)
    assert resp.status_code == 201
    assert resp.json()["ok"] is True
    assert "id" in resp.json()


def test_create_article_source_is_manual(client, auth_headers, db):
    resp = client.post("/api/articles", json={"title": "T", "author": "A"}, headers=auth_headers)
    article_id = resp.json()["id"]
    detail = client.get(f"/api/newsletters/{article_id}", headers=auth_headers).json()
    assert detail["source"] == "manual"


def test_create_article_author_stored_separately(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "author": "Jane Smith", "sender": "The Atlantic"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert detail["author"] == "Jane Smith"
    assert detail["sender"] == "The Atlantic"


def test_create_article_sender_defaults_to_author(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "author": "Jane Smith"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert detail["author"] == "Jane Smith"
    assert detail["sender"] == "Jane Smith"


def test_create_article_stores_subtitle(client, auth_headers, db):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "subtitle": "A subtitle", "author": "A"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert detail["subtitle"] == "A subtitle"


def test_create_article_stores_body_html(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "author": "A", "body_html": "<p>hello</p>"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert detail["body_html"] == "<p>hello</p>"


def test_create_article_stores_body_text(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "author": "A", "body_text": "plain text"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert detail["body_text"] == "plain text"


def test_create_article_custom_received_at(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "T", "author": "A", "received_at": "2024-06-01T12:00:00"},
        headers=auth_headers,
    )
    detail = client.get(f"/api/newsletters/{resp.json()['id']}", headers=auth_headers).json()
    assert "2024-06-01" in detail["received_at"]


def test_create_article_missing_title_422(client, auth_headers):
    resp = client.post("/api/articles", json={"author": "A"}, headers=auth_headers)
    assert resp.status_code == 422


def test_create_article_missing_author_422(client, auth_headers):
    resp = client.post("/api/articles", json={"title": "T"}, headers=auth_headers)
    assert resp.status_code == 422


def test_article_appears_in_newsletter_list(client, auth_headers):
    resp = client.post(
        "/api/articles",
        json={"title": "Listed Article", "author": "Author"},
        headers=auth_headers,
    )
    article_id = resp.json()["id"]
    listing = client.get("/api/newsletters", headers=auth_headers).json()
    ids = [n["id"] for n in listing]
    assert article_id in ids


def test_imap_newsletters_have_imap_source(client, auth_headers, db):
    n = make_newsletter(db, "uid-source-check")
    detail = client.get(f"/api/newsletters/{n.id}", headers=auth_headers).json()
    assert detail["source"] == "imap"


def test_imap_newsletters_have_null_subtitle(client, auth_headers, db):
    n = make_newsletter(db, "uid-subtitle-check")
    detail = client.get(f"/api/newsletters/{n.id}", headers=auth_headers).json()
    assert detail["subtitle"] is None
