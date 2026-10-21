from datetime import datetime, timezone


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, Text
from sqlalchemy.orm import relationship
from .database import Base


class Newsletter(Base):
    __tablename__ = "newsletters"

    id = Column(Integer, primary_key=True, index=True)
    imap_uid = Column(Text, unique=True, nullable=False)
    subject = Column(Text, nullable=False, default="(no subject)")
    subtitle = Column(Text, nullable=True)
    sender = Column(Text, nullable=False, default="")
    author = Column(Text, nullable=True)
    received_at = Column(DateTime, nullable=False, default=_utcnow, index=True)
    body_html = Column(Text, nullable=True)
    body_text = Column(Text, nullable=True)
    synced_at = Column(DateTime, nullable=False, default=_utcnow)
    source = Column(Text, nullable=False, default="imap")

    progress = relationship("ReadingProgress", back_populates="newsletter", uselist=False, cascade="all, delete-orphan")


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    id = Column(Integer, primary_key=True, index=True)
    newsletter_id = Column(Integer, ForeignKey("newsletters.id"), unique=True, nullable=False)
    is_read = Column(Boolean, default=False, nullable=False, index=True)
    scroll_position = Column(Integer, default=0, nullable=False)
    read_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False, index=True)

    newsletter = relationship("Newsletter", back_populates="progress")


class FeedPosition(Base):
    """Where the reader is in the continuous feed. Single-user app, so one row (id=1)."""
    __tablename__ = "feed_position"

    id = Column(Integer, primary_key=True)
    newsletter_id = Column(Integer, ForeignKey("newsletters.id", ondelete="SET NULL"), nullable=True)
    # Fraction (0–1) of the way through that newsletter, so it survives different screen widths
    offset = Column(Float, default=0.0, nullable=False)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow, nullable=False)
