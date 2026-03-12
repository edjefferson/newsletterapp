import logging
import threading

from fastapi import APIRouter, Depends

from ..auth import require_auth

router = APIRouter(prefix="/api", tags=["sync"], dependencies=[Depends(require_auth)])
logger = logging.getLogger(__name__)

_sync_lock = threading.Lock()
_sync_status = {"running": False, "last_inserted": None, "last_error": None}


def run_sync_background():
    """Run a sync in the current thread, guarded by _sync_lock. Returns False if already running."""
    from ..imap_sync import sync_newsletters
    with _sync_lock:
        if _sync_status["running"]:
            return False
        _sync_status["running"] = True
    try:
        count = sync_newsletters()
        _sync_status["last_inserted"] = count
        _sync_status["last_error"] = None
        return True
    except Exception as exc:
        logger.exception("Sync error: %s", exc)
        _sync_status["last_error"] = str(exc)
        return False
    finally:
        _sync_status["running"] = False


@router.post("/sync")
def manual_sync():
    with _sync_lock:
        if _sync_status["running"]:
            return {"status": "already_running"}
    threading.Thread(target=run_sync_background, daemon=True).start()
    return {"status": "started"}


@router.get("/sync/status")
def sync_status():
    return _sync_status
