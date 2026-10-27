import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

from sqlalchemy import text

from .database import Base, engine
from .models import FeedPosition, Newsletter, ReadingProgress  # noqa: F401 — ensure models are registered
from .routes import articles as articles_router
from .routes import feed as feed_router
from .routes import login as login_router
from .routes import newsletters as newsletters_router
from .routes import sync as sync_router
from .scheduler import start_scheduler, stop_scheduler

logging.basicConfig(level=logging.INFO)

STATIC_DIR = Path(__file__).parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    with engine.connect() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_newsletters_received_at ON newsletters (received_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_reading_progress_is_read ON reading_progress (is_read)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_reading_progress_updated_at ON reading_progress (updated_at)"))
        for migration in [
            "ALTER TABLE newsletters ADD COLUMN subtitle TEXT",
            "ALTER TABLE newsletters ADD COLUMN source TEXT NOT NULL DEFAULT 'imap'",
            "ALTER TABLE newsletters ADD COLUMN author TEXT",
            "ALTER TABLE feed_position ADD COLUMN anchor TEXT",
        ]:
            try:
                conn.execute(text(migration))
            except Exception:
                pass  # column already exists
        conn.commit()
    start_scheduler()

    # Run initial sync in background so startup doesn't block
    from .routes.sync import run_sync_background
    threading.Thread(target=run_sync_background, daemon=True).start()

    yield

    stop_scheduler()


app = FastAPI(title="Newsletter Reader", lifespan=lifespan)

_base_origins = [
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",
]
_extra = os.environ.get("CORS_ORIGINS", "")
_allowed_origins = _base_origins + [o.strip() for o in _extra.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(login_router.router)
app.include_router(newsletters_router.router)
app.include_router(sync_router.router)
app.include_router(articles_router.router)
app.include_router(feed_router.router)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.middleware("http")
async def no_cache_static(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/login")
def login_page():
    return FileResponse(str(STATIC_DIR / "login.html"))


@app.get("/")
def feed_page():
    return FileResponse(str(STATIC_DIR / "feed.html"))


@app.get("/list")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/reader/{newsletter_id}")
def reader(newsletter_id: int):
    return FileResponse(str(STATIC_DIR / "reader.html"))
