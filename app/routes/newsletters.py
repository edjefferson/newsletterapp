from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Newsletter, ReadingProgress

router = APIRouter(prefix="/api/newsletters", tags=["newsletters"])


class NewsletterSummary(BaseModel):
    id: int
    subject: str
    sender: str
    received_at: datetime
    is_read: bool
    scroll_position: int

    class Config:
        from_attributes = True


class NewsletterDetail(NewsletterSummary):
    body_html: Optional[str]
    body_text: Optional[str]


class ProgressUpdate(BaseModel):
    scroll_position: int = 0
    is_read: bool = False


@router.get("", response_model=list[NewsletterSummary])
def list_newsletters(
    unread: Optional[bool] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Newsletter)
    if unread is True:
        q = q.outerjoin(ReadingProgress).filter(
            (ReadingProgress.is_read == None) | (ReadingProgress.is_read == False)
        )
    q = q.order_by(Newsletter.received_at.desc())
    newsletters = q.offset((page - 1) * page_size).limit(page_size).all()

    result = []
    for n in newsletters:
        p = n.progress
        result.append(
            NewsletterSummary(
                id=n.id,
                subject=n.subject,
                sender=n.sender,
                received_at=n.received_at,
                is_read=p.is_read if p else False,
                scroll_position=p.scroll_position if p else 0,
            )
        )
    return result


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
    p.updated_at = datetime.utcnow()

    if update.is_read and not p.is_read:
        p.is_read = True
        p.read_at = datetime.utcnow()
    elif not update.is_read:
        p.is_read = False
        p.read_at = None

    db.commit()
    return {"ok": True}
