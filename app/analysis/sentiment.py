"""Fast, free headline sentiment (finance lexicon, English + Hebrew).

Every headline gets a score in -1..1 instantly; the LLM later reads the
headlines too and can override the overall view.
"""
from __future__ import annotations

import re

POS = {
    "beat": 1.0, "beats": 1.0, "surge": 1.0, "surges": 1.0, "soar": 1.0, "soars": 1.0, "jump": 0.8, "jumps": 0.8,
    "rally": 0.8, "rallies": 0.8, "record": 0.6, "upgrade": 1.0, "upgraded": 1.0, "outperform": 0.8, "buy": 0.4,
    "raises": 0.7, "raised": 0.6, "boost": 0.6, "growth": 0.5, "strong": 0.6, "profit": 0.4, "approval": 0.9,
    "approved": 0.9, "wins": 0.7, "win": 0.5, "partnership": 0.6, "contract": 0.5, "expands": 0.5, "bullish": 0.9,
    "gain": 0.6, "gains": 0.6, "higher": 0.4, "tops": 0.8, "exceeds": 0.8, "buyback": 0.7, "dividend": 0.3,
    "breakthrough": 0.8, "optimistic": 0.6, "rebound": 0.6, "acquire": 0.3, "deal": 0.4,
    "זינוק": 1.0, "מזנקת": 1.0, "מזנקות": 1.0, "עלייה": 0.6, "עולה": 0.5, "עולות": 0.5, "שיא": 0.6, "רווח": 0.4,
    "שדרוג": 1.0, "המלצת קנייה": 1.0, "צמיחה": 0.5, "חוזה": 0.5, "הסכם": 0.4, "אישור": 0.8, "מכה את התחזיות": 1.0,
}
NEG = {
    "miss": 1.0, "misses": 1.0, "plunge": 1.0, "plunges": 1.0, "tumble": 0.9, "tumbles": 0.9, "drop": 0.6,
    "drops": 0.6, "fall": 0.6, "falls": 0.6, "slump": 0.9, "downgrade": 1.0, "downgraded": 1.0, "underperform": 0.8,
    "sell": 0.4, "cuts": 0.7, "cut": 0.5, "lawsuit": 0.8, "probe": 0.8, "investigation": 0.8, "recall": 0.8,
    "fraud": 1.0, "warning": 0.7, "warns": 0.8, "weak": 0.6, "loss": 0.6, "losses": 0.6, "layoffs": 0.6,
    "bearish": 0.9, "lower": 0.4, "decline": 0.6, "declines": 0.6, "crash": 1.0, "bankruptcy": 1.0, "delay": 0.5,
    "fine": 0.5, "fined": 0.7, "sanctions": 0.7, "tariff": 0.5, "tariffs": 0.5, "short": 0.3, "halt": 0.7, "sinks": 0.9,
    "קריסה": 1.0, "צונחת": 1.0, "צונחות": 1.0, "נפילה": 0.8, "ירידה": 0.6, "יורדת": 0.5, "יורדות": 0.5, "הפסד": 0.6,
    "הורדת דירוג": 1.0, "חקירה": 0.8, "תביעה": 0.8, "אזהרת רווח": 1.0, "פיטורים": 0.6, "מכס": 0.5, "מכסים": 0.5,
}
NEGATORS = {"not", "no", "never", "without", "fails", "לא", "אין"}
_WORD = re.compile(r"[\w֐-׿']+", re.UNICODE)


def score_text(text: str) -> float:
    if not text:
        return 0.0
    t = text.lower()
    total, hits = 0.0, 0
    # multi-word phrases first
    for lex, sign in ((POS, 1), (NEG, -1)):
        for phrase, w in lex.items():
            if " " in phrase and phrase in t:
                total += sign * w
                hits += 1
    words = _WORD.findall(t)
    for i, w in enumerate(words):
        sign = 0
        weight = 0.0
        if w in POS:
            sign, weight = 1, POS[w]
        elif w in NEG:
            sign, weight = -1, NEG[w]
        if sign:
            if i > 0 and words[i - 1] in NEGATORS:
                sign = -sign
            total += sign * weight
            hits += 1
    if not hits:
        return 0.0
    return max(-1.0, min(1.0, total / (hits ** 0.5) / 1.5))


def aggregate(items: list[dict]) -> float:
    """Recency-weighted mean of item sentiment (-1..1)."""
    if not items:
        return 0.0
    import time

    now = time.time()
    num = den = 0.0
    for it in items:
        age_h = max(0.0, (now - it.get("ts", now)) / 3600)
        w = 1 / (1 + age_h / 12)
        if it.get("kind") == "social":
            w *= 0.6
        num += it.get("sentiment", 0.0) * w
        den += w
    return round(num / den, 3) if den else 0.0
