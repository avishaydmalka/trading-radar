"""Browser / phone push notifications (works even when the dashboard tab is closed).

Requires HTTPS and VAPID keys (generate once with: python -m app.tools.gen_vapid).
"""
from __future__ import annotations

import json
import logging

from .. import db
from ..config import settings

log = logging.getLogger("radar.webpush")


def enabled() -> bool:
    return bool(settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY)


def send_all(payload: dict) -> int:
    if not enabled():
        return 0
    subs = db.list_push_subs()
    if not subs:
        return 0
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        log.warning("pywebpush not installed")
        return 0
    sent = 0
    for sub in subs:
        try:
            webpush(
                subscription_info=sub,
                data=json.dumps(payload, ensure_ascii=False),
                vapid_private_key=settings.VAPID_PRIVATE_KEY,
                vapid_claims={"sub": settings.VAPID_EMAIL},
                ttl=3600,
            )
            sent += 1
        except WebPushException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                db.delete_push_sub(sub["endpoint"])
            else:
                log.info("push failed: %s", exc)
        except Exception as exc:  # noqa: BLE001
            log.info("push failed: %s", exc)
    return sent
