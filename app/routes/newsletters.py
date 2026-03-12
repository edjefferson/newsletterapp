from datetime import datetime, timedelta, timezone


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session, contains_eager

from ..auth import require_auth
from ..database import get_db
from ..models import Newsletter, ReadingProgress

router = APIRouter(prefix="/api/newsletters", tags=["newsletters"], dependencies=[Depends(require_auth)])


class NewsletterSummary(BaseModel):
    id: int
    subject: str
    sender: str
    received_at: datetime
    is_read: bool
    scroll_position: int

    model_config = ConfigDict(from_attributes=True)


class NewsletterDetail(NewsletterSummary):
    body_html: Optional[str]
    body_text: Optional[str]


class ProgressUpdate(BaseModel):
    scroll_position: int = 0
    is_read: bool = False


@router.get("", response_model=list[NewsletterDetail])
def list_newsletters(
    unread: Optional[bool] = Query(None),
    full: bool = Query(False),
    after_id: int = Query(0, ge=0),
    since: Optional[datetime] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = (
        db.query(Newsletter)
        .outerjoin(Newsletter.progress)
        .options(contains_eager(Newsletter.progress))
    )
    if unread is True:
        q = q.filter(
            (ReadingProgress.is_read == None) | (ReadingProgress.is_read == False)
        )
    if after_id > 0:
        q = q.filter(Newsletter.id > after_id)
    if since is not None:
        q = q.filter(Newsletter.received_at >= since)
    q = q.order_by(Newsletter.received_at.desc())
    newsletters = q.offset((page - 1) * page_size).limit(page_size).all()

    result = []
    for n in newsletters:
        p = n.progress
        result.append(
            NewsletterDetail(
                id=n.id,
                subject=n.subject,
                sender=n.sender,
                received_at=n.received_at,
                is_read=p.is_read if p else False,
                scroll_position=p.scroll_position if p else 0,
                body_html=n.body_html if full else None,
                body_text=n.body_text if full else None,
            )
        )
    return result


@router.post("/mark-old-read")
def mark_old_read(db: Session = Depends(get_db)):
    """Mark all newsletters older than 7 days as read."""
    cutoff = _utcnow() - timedelta(days=7)
    now = _utcnow()

    # Count how many will actually change (unread → read)
    count = db.execute(text(
        "SELECT COUNT(*) FROM newsletters n WHERE n.received_at < :cutoff "
        "AND NOT EXISTS (SELECT 1 FROM reading_progress WHERE newsletter_id = n.id AND is_read = true)"
    ), {"cutoff": cutoff}).scalar()

    # Bulk upsert: insert or update progress for all old newsletters
    db.execute(text(
        "INSERT INTO reading_progress (newsletter_id, is_read, scroll_position, read_at, updated_at) "
        "SELECT id, true, 0, :now, :now FROM newsletters WHERE received_at < :cutoff "
        "ON CONFLICT (newsletter_id) DO UPDATE SET "
        "is_read = true, "
        "read_at = COALESCE(reading_progress.read_at, excluded.read_at), "
        "updated_at = excluded.updated_at"
    ), {"now": now, "cutoff": cutoff})

    db.commit()
    return {"ok": True, "marked": count}


@router.get("/progress")
def list_progress(
    since: Optional[datetime] = Query(None),
    db: Session = Depends(get_db),
):
    """Return read-state for all newsletters updated since `since` (for mobile sync)."""
    q = db.query(ReadingProgress)
    if since:
        q = q.filter(ReadingProgress.updated_at > since)
    rows = q.all()
    return [
        {
            "server_id": r.newsletter_id,
            "is_read": r.is_read,
            "scroll_position": r.scroll_position,
            "updated_at": r.updated_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/{newsletter_id}", response_model=NewsletterDetail)
def get_newsletter(newsletter_id: int, db: Session = Depends(get_db)):
    n = db.query(Newsletter).filter(Newsletter.id == newsletter_id).first()
    if not n:
        raise HTTPException(status_code=404, detail="Newsletter not found")
    p = n.progress
    return NewsletterDetail(
        id=n.id,
        subject=n.subject,
        sender=n.sender,
        received_at=n.received_at,
        is_read=p.is_read if p else False,
        scroll_position=p.scroll_position if p else 0,
        body_html=n.body_html,
        body_text=n.body_text,
    )


@router.post("/{newsletter_id}/progress")
def save_progress(newsletter_id: int, update: ProgressUpdate, db: Session = Depends(get_db)):
    n = db.query(Newsletter).filter(Newsletter.id == newsletter_id).first()
    if not n:
        raise HTTPException(status_code=404, detail="Newsletter not found")

    p = n.progress
    if not p:
        p = ReadingProgress(newsletter_id=newsletter_id)
        db.add(p)

    p.scroll_position = update.scroll_position
    p.updated_at = _utcnow()

    if update.is_read and not p.is_read:
        p.is_read = True
        p.read_at = _utcnow()
    elif not update.is_read:
        p.is_read = False
        p.read_at = None

    db.commit()
    return {"ok": True}
