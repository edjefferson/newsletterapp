import logging
import threading

from fastapi import APIRouter, Depends

from ..auth import require_auth

router = APIRouter(prefix="/api", tags=["sync"], dependencies=[Depends(require_auth)])
logger = logging.getLogger(__name__)

_sync_lock = threading.Lock()
_sync_status = {"running": False, "last_inserted": None, "last_error": None}


def _run_sync_background():
    from ..imap_sync import sync_newsletters
    try:
        count = sync_newsletters()
        _sync_status["last_inserted"] = count
        _sync_status["last_error"] = None
    except Exception as exc:
        logger.exception("Background sync error: %s", exc)
        _sync_status["last_error"] = str(exc)
    finally:
        _sync_status["running"] = False


@router.post("/sync")
def manual_sync():
    if _sync_status["running"]:
        return {"status": "already_running"}
    _sync_status["running"] = True
    threading.Thread(target=_run_sync_background, daemon=True).start()
    return {"status": "started"}


@router.get("/sync/status")
def sync_status():
    return _sync_status
