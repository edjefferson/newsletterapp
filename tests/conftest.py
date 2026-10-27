import os

# Must set env vars before any app import — database.py reads DATABASE_URL at module load time
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("APP_PASSWORD", "test-password")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
# app.main loads .env, which on a dev machine holds real IMAP credentials, and every test's
# startup would then sync the real mailbox. Setting them (even empty) stops load_dotenv
# overriding them, so the startup sync is a no-op.
for _key in ("IMAP_USER", "IMAP_PASSWORD"):
    os.environ[_key] = ""

import hmac
import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone

# Register a replacement for the deprecated default sqlite3 datetime adapter
# (Python 3.12+ warns when SQLAlchemy passes datetime params to sqlite3 without one)
sqlite3.register_adapter(datetime, lambda d: d.isoformat(sep=" "))


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.database import Base, get_db
from app.models import Newsletter, ReadingProgress

engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture(scope="session", autouse=True)
def create_tables():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def db():
    connection = engine.connect()
    transaction = connection.begin()
    session = TestingSessionLocal(bind=connection)
    yield session
    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture()
def client(db):
    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture()
def auth_headers():
    token = hmac.new(b"test-secret", b"test-password", hashlib.sha256).hexdigest()
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def sample_newsletter(db):
    n = Newsletter(
        imap_uid="uid-001",
        subject="Test Newsletter",
        sender="sender@example.com",
        received_at=datetime(2025, 1, 15, 10, 0, 0),
        body_html="<p>Hello world</p>",
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


def make_newsletter(db, uid, subject="Subject", days_old=0, body_html=None, body_text=None):
    n = Newsletter(
        imap_uid=uid,
        subject=subject,
        sender="sender@example.com",
        received_at=_utcnow() - timedelta(days=days_old),
        body_html=body_html or "<p>body</p>",
        body_text=body_text,
    )
    db.add(n)
    db.commit()
    db.refresh(n)
    return n


def mark_read(db, newsletter, scroll=500):
    p = ReadingProgress(
        newsletter_id=newsletter.id,
        is_read=True,
        scroll_position=scroll,
        read_at=_utcnow(),
        updated_at=_utcnow(),
    )
    db.add(p)
    db.commit()
    return p
