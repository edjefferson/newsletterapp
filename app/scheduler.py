import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


def start_scheduler():
    from .routes.sync import run_sync_background

    def run_sync():
        run_sync_background()

    scheduler.add_job(
        run_sync,
        trigger=IntervalTrigger(minutes=30),
        id="imap_sync",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler started — sync every 30 minutes.")


def stop_scheduler():
    if scheduler.running:
        scheduler.shutdown(wait=False)
