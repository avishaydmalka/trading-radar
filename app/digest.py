"""Recommendation digest in Hebrew – sent automatically to Telegram (and shown in the app)
three times every trading day: morning, before Wall Street opens, and after the US close.
"""
from __future__ import annotations

import html
from datetime import datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Jerusalem")
# (slot id, Israel time HH:MM, title)
SLOTS = [("morning", "09:15", "☀️ סיכום בוקר"), ("us_open", "16:15", "🇺🇸 לפני פתיחת וול סטריט"), ("close", "23:15", "🌙 סיכום יום")]
ACTION_HE = {"BUY": "קנייה", "ADD": "הגדלה", "HOLD": "החזקה", "WATCH": "מעקב", "AVOID": "להימנע", "TRIM": "מימוש חלקי", "SELL": "מכירה"}
DOT = {"BUY": "🟢", "ADD": "🟢", "HOLD": "⚪", "WATCH": "🔵", "AVOID": "⚫", "TRIM": "🟡", "SELL": "🔴"}
ORDER = {"SELL": 0, "TRIM": 1, "ADD": 2, "BUY": 2, "WATCH": 3, "HOLD": 4, "AVOID": 5}


def due_slot(last_sent: dict, now: datetime | None = None) -> tuple[str, str] | None:
    """Return (slot_key, title) when a digest slot has passed today and wasn't sent yet. Weekdays only."""
    now = (now or datetime.now(TZ)).astimezone(TZ)
    if now.weekday() >= 5:  # Sat/Sun – markets closed
        return None
    due = None
    for sid, hhmm, title in SLOTS:
        h, m = map(int, hhmm.split(":"))
        slot_time = now.replace(hour=h, minute=m, second=0, microsecond=0)
        # send within 3 hours after the slot time, at most once per slot per day
        if slot_time <= now <= slot_time.replace(hour=min(23, h + 3)) or (sid == "close" and now >= slot_time):
            key = f"{now:%Y-%m-%d}:{sid}"
            if key not in (last_sent or {}):
                due = (key, title)
    return due


def _e(s) -> str:
    return html.escape(str(s or ""))


def _short(s: str, n: int = 90) -> str:
    s = " ".join(str(s or "").split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _f(v, d=2) -> str:
    try:
        return f"{float(v):,.{d}f}"
    except (TypeError, ValueError):
        return "—"


def build(dash: dict, title: str, discovery: list[dict] | None = None) -> tuple[str, dict]:
    """Returns (telegram_html, app_card). Recommendations for held stocks, the watchlist and new discoveries."""
    now = datetime.now(TZ)
    held = [h for h in dash.get("holdings", []) if not h.get("pending")]
    watch = [o for o in dash.get("opportunities", []) if not o.get("pending")]
    mine = {h["ticker"] for h in held} | {o["ticker"] for o in watch}
    disc = [d for d in (discovery or []) if d["ticker"] not in mine][:5]
    p = dash.get("portfolio") or {}
    sym = "₪" if p.get("base") == "ILS" else "$"
    brief = dash.get("brief") or {}

    lines = [f"<b>{_e(title)}</b> · {now:%d/%m %H:%M}"]
    if brief:
        lines.append(f"🧭 {_e(brief.get('title'))} · מצב רוח {brief.get('mood', 0):+.0f}")
        if brief.get("summary"):
            lines.append(f"<i>{_e(_short(brief['summary'], 260))}</i>")
    if p.get("total"):
        lines.append(f"💼 שווי {sym}{_f(p['total'], 0)} · היום {p.get('day_pnl_pct', 0):+.2f}% · כולל {p.get('total_pnl_pct', 0):+.1f}%")

    card = {"ts": now.timestamp(), "title": title, "brief": brief.get("title"), "sections": []}

    def row(s, plan=False):
        a = s.get("analysis") or {}
        act = s.get("action") or a.get("action") or "HOLD"
        txt = f"{DOT.get(act, '•')} <b>{_e(s['ticker'])}</b> · {ACTION_HE.get(act, act)} ({s.get('score', 0):+.0f})"
        ai = a.get("provider") and a.get("provider") != "rules"
        why = (a.get("headline") if ai else None) or s.get("top_signal") or a.get("headline")
        if why:
            txt += f" – {_e(_short(why))}"
        z = s.get("sizing") or {}
        if plan and z.get("entry"):
            txt += f"\n     כניסה {_f(z['entry'])} · סטופ {_f(z.get('stop'))} · יעד {_f(z.get('target'))}"
        return txt, {"ticker": s["ticker"], "action": act, "score": s.get("score"), "why": _short(why or "", 120),
                     "pnl_pct": s.get("pnl_pct"), "entry": z.get("entry") if plan else None, "stop": z.get("stop") if plan else None,
                     "target": z.get("target") if plan else None}

    if held:
        held.sort(key=lambda s: (ORDER.get(s.get("action"), 9), -(abs(s.get("score") or 0))))
        act_rows = [s for s in held if s.get("action") not in ("HOLD",)]
        quiet = [s for s in held if s.get("action") == "HOLD"]
        lines.append("\n💼 <b>התיק שלך</b>")
        sec = {"title": "התיק שלך", "rows": []}
        for s in act_rows[:8]:
            t, r = row(s)
            if s.get("pnl_pct") is not None:
                t += f" · {s['pnl_pct']:+.1f}%"
            lines.append(t)
            sec["rows"].append(r)
        if quiet:
            lines.append(f"⚪ להחזיק: {', '.join(_e(s['ticker']) for s in quiet[:12])}")
            sec["hold"] = [s["ticker"] for s in quiet]
        card["sections"].append(sec)

    if watch:
        ranked = sorted(watch, key=lambda s: -(s.get("score") or 0))
        top = [s for s in ranked if s.get("action") in ("BUY", "WATCH")][:5] or ranked[:3]
        lines.append("\n👁 <b>מרשימת המעקב</b>")
        sec = {"title": "מרשימת המעקב", "rows": []}
        for s in top:
            t, r = row(s, plan=s.get("action") == "BUY")
            lines.append(t)
            sec["rows"].append(r)
        card["sections"].append(sec)

    if disc:
        lines.append("\n🔭 <b>הזדמנויות חדשות (לא במעקב שלך)</b>")
        sec = {"title": "הזדמנויות חדשות", "rows": []}
        for i, s in enumerate(disc, 1):
            t, r = row(s, plan=True)
            lines.append(f"{i}. {t}")
            sec["rows"].append(r)
        card["sections"].append(sec)

    lines.append("\n<i>/stock TICKER לפרטים · /ask TICKER שאלה · אין לראות בכך ייעוץ השקעות</i>")
    return "\n".join(lines)[:4000], card
