from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, Text, UniqueConstraint
from sqlalchemy.orm import relationship
from .database import Base


class Newsletter(Base):
    __tablename__ = "newsletters"

    id = Column(Integer, primary_key=True, index=True)
    imap_uid = Column(Text, unique=True, nullable=False)
    subject = Column(Text, nullable=False, default="(no subject)")
    sender = Column(Text, nullable=False, default="")
    received_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    body_html = Column(Text, nullable=True)
    body_text = Column(Text, nullable=True)
    synced_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    progress = relationship("ReadingProgress", back_populates="newsletter", uselist=False, cascade="all, delete-orphan")


class ReadingProgress(Base):
    __tablename__ = "reading_progress"

    id = Column(Integer, primary_key=True, index=True)
    newsletter_id = Column(Integer, ForeignKey("newsletters.id"), unique=True, nullable=False)
    is_read = Column(Boolean, default=False, nullable=False)
    scroll_position = Column(Integer, default=0, nullable=False)
    read_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    newsletter = relationship("Newsletter", back_populates="progress")
