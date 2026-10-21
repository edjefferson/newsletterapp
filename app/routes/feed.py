from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from ..auth import require_auth
from ..database import get_db
from ..models import FeedPosition, Newsletter, ReadingProgress
from .newsletters import NewsletterDetail

router = APIRouter(prefix="/api/feed", tags=["feed"], dependencies=[Depends(require_auth)])


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _detail(n: Newsletter) -> NewsletterDetail:
    p = n.progress
    return NewsletterDetail(
        id=n.id,
        subject=n.subject,
        subtitle=n.subtitle,
        sender=n.sender,
        author=n.author,
        received_at=n.received_at,
        is_read=p.is_read if p else False,
        scroll_position=p.scroll_position if p else 0,
        source=n.source,
        body_html=n.body_html,
        body_text=n.body_text,
    )


@router.get("", response_model=list[NewsletterDetail])
def get_feed(
    anchor: Optional[int] = Query(None, description="Newsletter id to page from; omit to start at the oldest"),
    direction: Literal["forward", "backward"] = Query("forward"),
    include_anchor: bool = Query(False),
    limit: int = Query(5, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """Newsletters in chronological order (oldest first), with full bodies.

    `forward` returns items after the anchor; `backward` returns items before it.
    Either way the result is in chronological order.
    """
    q = db.query(Newsletter)
    if anchor is not None:
        a = db.query(Newsletter).filter(Newsletter.id == anchor).first()
        if not a:
            raise HTTPException(status_code=404, detail="Anchor newsletter not found")
        same_time = Newsletter.received_at == a.received_at
        if direction == "forward":
            id_cond = Newsletter.id >= a.id if include_anchor else Newsletter.id > a.id
            q = q.filter(or_(Newsletter.received_at > a.received_at, and_(same_time, id_cond)))
        else:
            id_cond = Newsletter.id <= a.id if include_anchor else Newsletter.id < a.id
            q = q.filter(or_(Newsletter.received_at < a.received_at, and_(same_time, id_cond)))

    if direction == "forward":
        rows = q.order_by(Newsletter.received_at.asc(), Newsletter.id.asc()).limit(limit).all()
    else:
        rows = q.order_by(Newsletter.received_at.desc(), Newsletter.id.desc()).limit(limit).all()
        rows.reverse()
    return [_detail(n) for n in rows]


class PositionUpdate(BaseModel):
    newsletter_id: int
    offset: float = Field(0.0, ge=0.0, le=1.0)
    # When the client recorded this position; lets offline devices sync without clobbering newer ones
    updated_at: Optional[datetime] = None


def _position_response(pos: Optional[FeedPosition], db: Session) -> dict:
    if pos and pos.newsletter_id is not None:
        return {
            "newsletter_id": pos.newsletter_id,
            "offset": pos.offset,
            "updated_at": pos.updated_at.isoformat() + "Z",
            "saved": True,
        }
    # No saved position yet: start at the oldest unread newsletter, else the newest one
    first_unread = (
        db.query(Newsletter)
        .outerjoin(Newsletter.progress)
        .filter((ReadingProgress.is_read == None) | (ReadingProgress.is_read == False))  # noqa: E711, E712
        .order_by(Newsletter.received_at.asc(), Newsletter.id.asc())
        .first()
    )
    start = first_unread or db.query(Newsletter).order_by(
        Newsletter.received_at.desc(), Newsletter.id.desc()
    ).first()
    return {
        "newsletter_id": start.id if start else None,
        "offset": 0.0,
        "updated_at": None,
        "saved": False,
    }


@router.get("/position")
def get_position(db: Session = Depends(get_db)):
    return _position_response(db.get(FeedPosition, 1), db)


@router.put("/position")
def put_position(update: PositionUpdate, db: Session = Depends(get_db)):
    if not db.get(Newsletter, update.newsletter_id):
        raise HTTPException(status_code=404, detail="Newsletter not found")

    updated_at = _naive_utc(update.updated_at) if update.updated_at else _utcnow()
    pos = db.get(FeedPosition, 1)
    if pos is None:
        pos = FeedPosition(id=1)
        db.add(pos)
    elif pos.newsletter_id is not None and pos.updated_at and updated_at < pos.updated_at:
        # Stale update from a device that was offline — keep the newer position
        return _position_response(pos, db)

    pos.newsletter_id = update.newsletter_id
    pos.offset = update.offset
    pos.updated_at = updated_at
    db.commit()
    return _position_response(pos, db)
