"""Telegram bot: push alerts + simple commands (/portfolio, /top, /stock, /brief, /scan)."""
from __future__ import annotations

import html
import logging
import threading
import time
from typing import Callable

import requests

from ..config import settings

log = logging.getLogger("radar.telegram")
API = "https://api.telegram.org/bot{token}/{method}"
LEVEL_EMOJI = {"critical": "🔴", "warning": "🟡", "opportunity": "🟢", "info": "🔵"}


def enabled() -> bool:
    return bool(settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID)


def _call(method: str, **payload) -> dict:
    r = requests.post(API.format(token=settings.TELEGRAM_BOT_TOKEN, method=method), json=payload, timeout=40)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not data.get("ok"):
        raise RuntimeError(f"telegram {method}: {r.status_code} {str(data)[:200]}")
    return data


def send_text(text: str, chat_id: str | None = None, buttons: list[list[dict]] | None = None) -> None:
    if not settings.TELEGRAM_BOT_TOKEN:
        return
    chat = chat_id or settings.TELEGRAM_CHAT_ID
    if not chat:
        return
    payload = {"chat_id": chat, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}
    if buttons:
        payload["reply_markup"] = {"inline_keyboard": buttons}
    _call("sendMessage", **payload)


def send_alert(a: dict) -> None:
    if not enabled():
        return
    e = html.escape
    lines = [f"{LEVEL_EMOJI.get(a['level'], '•')} <b>{e(a['title'])}</b>"]
    if a.get("ticker"):
        lines[0] = f"{LEVEL_EMOJI.get(a['level'], '•')} <b>{e(a['ticker'])}</b> · {e(a['title'])}"
    if a.get("body"):
        lines.append(e(a["body"]))
    data = a.get("data") or {}
    if data.get("sizing"):
        sz = data["sizing"]
        lines.append(f"📐 כניסה {sz['entry']:.2f} | סטופ {sz['stop']:.2f} | יעד {sz['target']:.2f} | {sz['shares']} יח'")
    if a.get("score") is not None:
        lines.append(f"ציון: <b>{a['score']:+.0f}</b>")
    buttons = None
    if settings.PUBLIC_URL.startswith("https://"):
        base = settings.PUBLIC_URL.rstrip('/')
        row = [{"text": "📊 פתח בדשבורד", "url": f"{base}/?ticker={a.get('ticker') or ''}"}]
        if data.get("url") and a.get("id") is not None:  # news: full article translated to Hebrew inside the app
            row.insert(0, {"text": "📰 הכתבה המלאה בעברית", "url": f"{base}/?alert={a['id']}"})
        buttons = [row]
    send_text("\n".join(lines), buttons=buttons)


# ------------------------------------------------------------------ command polling
HELP = (
    "<b>רדאר מסחר – פקודות</b>\n"
    "/portfolio – מצב התיק\n"
    "/top – הזדמנויות מובילות\n"
    "/stock TICKER – ניתוח מניה\n"
    "/brief – תדריך שוק\n"
    "/alerts – התראות אחרונות\n"
    "/scan – סריקה עכשיו"
)


def start_polling(handlers: dict[str, Callable[[str], str]]) -> None:
    if not settings.TELEGRAM_BOT_TOKEN:
        return
    threading.Thread(target=_poll_loop, args=(handlers,), daemon=True, name="telegram-poll").start()


def _poll_loop(handlers: dict[str, Callable[[str], str]]) -> None:
    offset = 0
    try:
        _call("setMyCommands", commands=[
            {"command": "portfolio", "description": "מצב התיק"},
            {"command": "top", "description": "הזדמנויות מובילות"},
            {"command": "stock", "description": "ניתוח מניה: /stock NVDA"},
            {"command": "brief", "description": "תדריך שוק"},
            {"command": "alerts", "description": "התראות אחרונות"},
            {"command": "scan", "description": "סריקה עכשיו"},
        ])
    except Exception as exc:  # noqa: BLE001
        log.info("setMyCommands: %s", exc)
    while True:
        try:
            data = _call("getUpdates", offset=offset, timeout=30, allowed_updates=["message"])
            for upd in data.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message") or {}
                chat_id = str((msg.get("chat") or {}).get("id", ""))
                text = (msg.get("text") or "").strip()
                if not text.startswith("/"):
                    continue
                cmd, _, arg = text[1:].partition(" ")
                cmd = cmd.split("@")[0].lower()
                if cmd == "start" or not settings.TELEGRAM_CHAT_ID:
                    send_text(f"שלום! ה-chat id שלך: <code>{chat_id}</code>\nהכנס אותו ל-TELEGRAM_CHAT_ID בקובץ .env\n\n{HELP}",
                              chat_id=chat_id)
                    continue
                if chat_id != str(settings.TELEGRAM_CHAT_ID):
                    continue  # ignore strangers
                if cmd == "help":
                    send_text(HELP, chat_id)
                elif cmd in handlers:
                    try:
                        send_text(handlers[cmd](arg.strip()), chat_id)
                    except Exception as exc:  # noqa: BLE001
                        send_text(f"שגיאה: {html.escape(str(exc))}", chat_id)
                else:
                    send_text(HELP, chat_id)
        except Exception as exc:  # noqa: BLE001
            log.info("telegram poll error: %s", exc)
            time.sleep(10)
