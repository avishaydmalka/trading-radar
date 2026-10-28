"""Hebrew translation for everything the user reads (news, tweets, analyst grades, alerts).

Uses Google's free translate endpoint (no key, does not touch the AI budget), batched and cached.
If translation fails the original text is kept, so nothing is ever lost.
"""
from __future__ import annotations

import hashlib
import logging
import re

import requests

from . import db

log = logging.getLogger("translate")
URL = "https://translate.googleapis.com/translate_a/single"
_SEP = "\n"
_MAX_CHARS = 1800
_HEB = re.compile(r"[֐-׿]")
_LATIN_WORD = re.compile(r"[A-Za-z][a-z]{2,}")  # real words, not tickers like NVDA / TEVA.TA
_failed = False  # stop trying for the rest of the run after a network failure

GRADES = {
    "strong buy": "קנייה חזקה", "buy": "קנייה", "outperform": "תשואת יתר", "overweight": "משקל יתר",
    "market outperform": "תשואת יתר", "sector outperform": "תשואת יתר מהסקטור", "accumulate": "צבירה",
    "positive": "חיובי", "hold": "החזק", "neutral": "נייטרלי", "market perform": "ביצועי שוק",
    "sector perform": "ביצועי סקטור", "equal-weight": "משקל שוק", "equal weight": "משקל שוק", "peer perform": "ביצועי שוק",
    "in-line": "בקו השוק", "inline": "בקו השוק", "sector weight": "משקל סקטור", "mixed": "מעורב",
    "underperform": "תשואת חסר", "underweight": "משקל חסר", "reduce": "הקטנה", "negative": "שלילי",
    "sell": "מכירה", "strong sell": "מכירה חזקה", "speculative buy": "קנייה ספקולטיבית",
}
TRADE_TYPES = {"purchase": "קנייה", "buy": "קנייה", "sale": "מכירה", "sell": "מכירה", "sale (full)": "מכירה מלאה",
               "sale (partial)": "מכירה חלקית", "exchange": "החלפה"}


def grade(g: str | None) -> str:
    return GRADES.get(str(g or "").strip().lower(), g or "")


def trade_type(t: str | None) -> str:
    return TRADE_TYPES.get(str(t or "").strip().lower(), t or "")


def needs(text: str | None) -> bool:
    """True when the text is mostly foreign (e.g. English) and worth translating."""
    if not text:
        return False
    heb = len(_HEB.findall(text))
    words = len(_LATIN_WORD.findall(text))
    return words >= 2 and heb < words * 3


def _key(text: str) -> str:
    return "tr:" + hashlib.sha1(text.encode()).hexdigest()[:20]


def _google(chunk: list[str]) -> list[str] | None:
    global _failed
    if _failed:
        return None
    try:
        r = requests.get(URL, params={"client": "gtx", "sl": "auto", "tl": "iw", "dt": "t", "q": _SEP.join(chunk)}, timeout=12)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        out = "".join(seg[0] for seg in r.json()[0] if seg and seg[0])
        parts = [p.strip() for p in out.split(_SEP)]
        if len(parts) != len(chunk):  # lines got merged – translate one by one instead
            return None if len(chunk) == 1 else [(_google([c]) or [c])[0] for c in chunk]
        return parts
    except Exception as exc:  # noqa: BLE001
        log.warning("translate failed: %s", exc)
        _failed = True
        return None


def to_hebrew(texts: list[str]) -> list[str]:
    """Translate a batch of texts to Hebrew. Already-Hebrew texts are returned unchanged."""
    out = list(texts)
    todo: list[int] = []
    for i, t in enumerate(texts):
        if not needs(t):
            continue
        hit = db.cache_get(_key(t), 90 * 86400)
        if hit:
            out[i] = hit
        else:
            todo.append(i)
    chunk: list[int] = []
    size = 0

    def flush() -> None:
        if not chunk:
            return
        src = [texts[i].replace("\n", " ").strip() for i in chunk]
        res = _google(src)
        if res:
            for i, tr in zip(chunk, res):
                if tr:
                    out[i] = tr
                    db.cache_set(_key(texts[i]), tr)
        chunk.clear()

    for i in todo:
        if size + len(texts[i]) > _MAX_CHARS:
            flush()
            size = 0
        chunk.append(i)
        size += len(texts[i]) + 1
    flush()
    return out


def one(text: str | None) -> str:
    if not text or not needs(text):
        return text or ""
    return to_hebrew([text])[0]


def news_items(items: list[dict]) -> None:
    """Translate news/tweet titles in place (keeps the original in title_en)."""
    idx = [i for i, it in enumerate(items) if needs(it.get("title"))]
    if not idx:
        return
    tr = to_hebrew([items[i]["title"] for i in idx])
    for i, t in zip(idx, tr):
        if t and t != items[i]["title"]:
            items[i]["title_en"] = items[i]["title"]
            items[i]["title"] = t
