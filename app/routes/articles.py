import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_auth
from ..database import get_db
from ..models import Newsletter

router = APIRouter(prefix="/api/articles", tags=["articles"], dependencies=[Depends(require_auth)])


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ArticleCreate(BaseModel):
    title: str
    subtitle: Optional[str] = None
    author: str
    sender: Optional[str] = None  # publication name; defaults to author if omitted
    body_html: Optional[str] = None
    body_text: Optional[str] = None
    received_at: Optional[datetime] = None


@router.post("", status_code=201)
def create_article(body: ArticleCreate, db: Session = Depends(get_db)):
    now = _utcnow()
    received_at = body.received_at
    if received_at is not None and received_at.tzinfo is not None:
        received_at = received_at.astimezone(timezone.utc).replace(tzinfo=None)

    article = Newsletter(
        imap_uid=f"manual-{uuid.uuid4()}",
        subject=body.title,
        subtitle=body.subtitle,
        sender=body.sender or body.author,
        author=body.author,
        received_at=received_at or now,
        body_html=body.body_html,
        body_text=body.body_text,
        synced_at=now,
        source="manual",
    )
    db.add(article)
    db.commit()
    db.refresh(article)
    return {"id": article.id, "ok": True}
