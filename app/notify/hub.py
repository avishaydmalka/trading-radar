"""Alert dispatcher (alerts skill): DB + live web feed (SSE) + Telegram + Web Push."""
from __future__ import annotations

import asyncio
import json
import logging
import threading

from .. import db
from ..config import settings
from . import telegram, webpush

log = logging.getLogger("radar.notify")

LEVEL_EMOJI = {"critical": "🔴", "warning": "🟡", "opportunity": "🟢", "info": "🔵"}
_loop: asyncio.AbstractEventLoop | None = None
_clients: set[asyncio.Queue] = set()
_clients_lock = threading.Lock()


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    with _clients_lock:
        _clients.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    with _clients_lock:
        _clients.discard(q)


def broadcast(event: str, payload: dict) -> None:
    """Thread-safe push of an event to every open dashboard tab."""
    if _loop is None:
        return
    msg = {"event": event, "data": json.dumps(payload, ensure_ascii=False, default=str)}

    def _put() -> None:
        with _clients_lock:
            for q in list(_clients):
                if q.full():
                    continue
                q.put_nowait(msg)

    _loop.call_soon_threadsafe(_put)


def send_alert(alert: dict, dedupe_key: str | None = None, cooldown_hours: float | None = None) -> dict | None:
    """alert: {ticker, kind, level, title, body, score, data}. Returns stored alert or None if deduped."""
    cooldown = settings.ALERT_COOLDOWN_HOURS if cooldown_hours is None else cooldown_hours
    if dedupe_key:
        if db.alert_recently_sent(dedupe_key, cooldown):
            return None
        db.mark_alert_key(dedupe_key)
    stored = db.insert_alert(alert)
    broadcast("alert", stored)
    try:
        telegram.send_alert(stored)
    except Exception as exc:  # noqa: BLE001
        log.warning("telegram failed: %s", exc)
    try:
        webpush.send_all({
            "title": f"{LEVEL_EMOJI.get(stored['level'], '')} {stored['title']}",
            "body": stored.get("body", "")[:180],
            "tag": f"{stored.get('ticker')}-{stored['kind']}",
            "url": f"/?ticker={stored.get('ticker') or ''}",
        })
    except Exception as exc:  # noqa: BLE001
        log.warning("webpush failed: %s", exc)
    return stored
