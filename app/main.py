import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from .database import Base, engine
from .models import Newsletter, ReadingProgress  # noqa: F401 — ensure models are registered
from .routes import login as login_router
from .routes import newsletters as newsletters_router
from .routes import sync as sync_router
from .scheduler import start_scheduler, stop_scheduler

logging.basicConfig(level=logging.INFO)

STATIC_DIR = Path(__file__).parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    start_scheduler()

    # Run initial sync in background so startup doesn't block
    def _startup_sync():
        try:
            from .imap_sync import sync_newsletters
            sync_newsletters()
        except Exception as exc:
            logging.getLogger(__name__).warning("Startup sync failed: %s", exc)

    threading.Thread(target=_startup_sync, daemon=True).start()

    yield

    stop_scheduler()


app = FastAPI(title="Newsletter Reader", lifespan=lifespan)

app.include_router(login_router.router)
app.include_router(newsletters_router.router)
app.include_router(sync_router.router)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/login")
def login_page():
    return FileResponse(str(STATIC_DIR / "login.html"))


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/reader/{newsletter_id}")
def reader(newsletter_id: int):
    return FileResponse(str(STATIC_DIR / "reader.html"))
