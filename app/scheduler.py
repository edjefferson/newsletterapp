import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


def start_scheduler():
    from .imap_sync import sync_newsletters

    def run_sync():
        try:
            count = sync_newsletters()
            logger.info("Scheduled sync: %d new newsletters.", count)
        except Exception as exc:
            logger.exception("Scheduled sync error: %s", exc)

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
