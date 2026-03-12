import email
import imaplib
import logging
import os
import re
from datetime import datetime, timezone


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)
from email.header import decode_header, make_header

from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import Newsletter

logger = logging.getLogger(__name__)

IMAP_TIMEOUT = 15  # seconds


def _imap_config():
    return {
        "host": os.environ.get("IMAP_HOST", "imap.gmail.com"),
        "port": int(os.environ.get("IMAP_PORT", "993")),
        "user": os.environ.get("IMAP_USER", ""),
        "password": os.environ.get("IMAP_PASSWORD", ""),
        "folder": os.environ.get("IMAP_FOLDER", "Newsletters"),
    }


def _decode_header_value(value: str) -> str:
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value or ""


def _get_body(msg) -> tuple[str | None, str | None]:
    """Extract (html_body, text_body) from an email.message.Message."""
    html_body = None
    text_body = None

    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            disp = str(part.get("Content-Disposition", ""))
            if "attachment" in disp:
                continue
            charset = part.get_content_charset() or "utf-8"
            try:
                payload = part.get_payload(decode=True).decode(charset, errors="replace")
            except Exception:
                continue
            if ct == "text/html" and html_body is None:
                html_body = payload
            elif ct == "text/plain" and text_body is None:
                text_body = payload
    else:
        charset = msg.get_content_charset() or "utf-8"
        try:
            payload = msg.get_payload(decode=True).decode(charset, errors="replace")
        except Exception:
            payload = ""
        if msg.get_content_type() == "text/html":
            html_body = payload
        else:
            text_body = payload

    return html_body, text_body


def _strip_dangerous_tags(html: str) -> str:
    """Remove script/form elements and inline event handlers."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all(["script", "form", "input", "button"]):
        tag.decompose()
    for tag in soup.find_all(True):
        for attr in list(tag.attrs):
            if attr.lower().startswith("on"):
                del tag[attr]
    return str(soup)


def sync_newsletters() -> int:
    """Sync new newsletters from IMAP. Returns count of new messages inserted."""
    cfg = _imap_config()
    if not cfg["user"] or not cfg["password"]:
        logger.warning("IMAP credentials not configured; skipping sync.")
        return 0

    logger.info("Sync starting — user=%s host=%s:%s folder=%s timeout=%ss",
                cfg["user"], cfg["host"], cfg["port"], cfg["folder"], IMAP_TIMEOUT)

    inserted = 0
    db: Session = SessionLocal()
    try:
        logger.info("Connecting to %s:%s …", cfg["host"], cfg["port"])
        imaplib.IMAP4_SSL.ssl_context = None  # use default
        import socket
        old_timeout = socket.getdefaulttimeout()
        socket.setdefaulttimeout(IMAP_TIMEOUT)
        try:
            imap_conn = imaplib.IMAP4_SSL(cfg["host"], cfg["port"])
        finally:
            socket.setdefaulttimeout(old_timeout)
        imap_conn.sock.settimeout(IMAP_TIMEOUT)
        logger.info("SSL connection established. Logging in …")

        with imap_conn as imap:
            imap.login(cfg["user"], cfg["password"])
            logger.info("Login OK. Selecting folder '%s' …", cfg["folder"])

            status, _ = imap.select(f'"{cfg["folder"]}"', readonly=True)
            if status != "OK":
                logger.error("Could not SELECT folder: %s", cfg["folder"])
                return 0
            logger.info("Folder selected. Searching for all UIDs …")

            _, data = imap.uid("search", None, "ALL")
            all_uids = data[0].split()
            logger.info("Found %d total messages in folder.", len(all_uids))

            if not all_uids:
                logger.info("Folder is empty — nothing to sync.")
                return 0

            existing = {row[0] for row in db.query(Newsletter.imap_uid).all()}
            new_uids = [uid for uid in all_uids if uid.decode() not in existing]
            logger.info("%d already in DB, %d new to fetch.", len(existing), len(new_uids))

            if not new_uids:
                logger.info("All messages already synced.")
                return 0

            # Fetch newest first, in batches to avoid huge single requests
            new_uids_ordered = list(reversed(new_uids))
            total = len(new_uids_ordered)
            BATCH_SIZE = 25

            for batch_start in range(0, total, BATCH_SIZE):
                batch = new_uids_ordered[batch_start: batch_start + BATCH_SIZE]
                logger.info("Fetching messages %d–%d of %d …",
                            batch_start + 1, min(batch_start + BATCH_SIZE, total), total)

                uid_list = b",".join(batch)
                _, fetch_data = imap.uid("fetch", uid_list, "(RFC822)")

                i = 0
                while i < len(fetch_data):
                    item = fetch_data[i]
                    if isinstance(item, tuple):
                        raw = item[1]
                        msg = email.message_from_bytes(raw)

                        meta = item[0].decode()
                        uid_match = re.search(r'\bUID\s+(\d+)', meta, re.IGNORECASE)
                        uid_str = uid_match.group(1) if uid_match else str(batch_start + i)

                        subject = _decode_header_value(msg.get("Subject", "(no subject)"))
                        sender = _decode_header_value(msg.get("From", ""))
                        date_str = msg.get("Date", "")
                        try:
                            received_at = email.utils.parsedate_to_datetime(date_str)
                            # Normalise to naive UTC so all rows are consistent
                            if received_at.tzinfo is not None:
                                from datetime import timezone
                                received_at = received_at.astimezone(timezone.utc).replace(tzinfo=None)
                        except Exception:
                            received_at = _utcnow()

                        html_body, text_body = _get_body(msg)
                        if html_body:
                            html_body = _strip_dangerous_tags(html_body)

                        logger.info("  [%d/%d] uid=%s  %s", inserted + 1, total, uid_str, subject[:60])

                        newsletter = Newsletter(
                            imap_uid=uid_str,
                            subject=subject,
                            sender=sender,
                            received_at=received_at,
                            body_html=html_body,
                            body_text=text_body,
                            synced_at=_utcnow(),
                        )
                        db.add(newsletter)
                        inserted += 1
                    i += 1

                db.commit()
                logger.info("Batch committed — %d total inserted so far.", inserted)

            logger.info("Sync complete: %d new newsletters inserted.", inserted)
    except Exception as exc:
        logger.exception("IMAP sync failed: %s", exc)
        db.rollback()
    finally:
        db.close()

    return inserted
