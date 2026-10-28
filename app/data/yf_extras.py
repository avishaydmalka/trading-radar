"""Extra company data from yfinance (Yahoo Finance), refreshed about twice a day per ticker:
analyst consensus & price targets, recent upgrades/downgrades, earnings date & past EPS surprises,
insider transactions, ownership, and yfinance's own news feed.
"""
from __future__ import annotations

import hashlib
import logging
import math
import random
import time
from datetime import datetime, timedelta, timezone

from ..config import settings

log = logging.getLogger("radar.yfx")


def _num(v):
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _date(v) -> str | None:
    if v is None:
        return None
    try:
        if hasattr(v, "strftime"):
            return v.strftime("%Y-%m-%d")
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(v, tz=timezone.utc).strftime("%Y-%m-%d")
        return str(v)[:10]
    except Exception:  # noqa: BLE001
        return None


def get_extras(ticker: str) -> dict:
    if settings.DEMO_MODE:
        return _demo(ticker)
    try:
        import yfinance as yf
    except ImportError:
        return {}
    tk = yf.Ticker(ticker)
    out: dict = {"source": "yfinance", "fetched": time.time()}
    agorot = ticker.upper().endswith(".TA")

    def safe(name, fn):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            log.debug("%s %s: %s", ticker, name, exc)

    def info():
        i = tk.info or {}
        div = 100.0 if agorot and i.get("currency") == "ILA" else 1.0
        out["analyst"] = {k: v for k, v in {
            "mean_rating": _num(i.get("recommendationMean")),       # 1 = strong buy … 5 = sell
            "rating_key": i.get("recommendationKey"),
            "analysts": i.get("numberOfAnalystOpinions"),
            "target_mean": _num(i.get("targetMeanPrice")) and _num(i.get("targetMeanPrice")) / div,
            "target_high": _num(i.get("targetHighPrice")) and _num(i.get("targetHighPrice")) / div,
            "target_low": _num(i.get("targetLowPrice")) and _num(i.get("targetLowPrice")) / div,
        }.items() if v is not None}
        out["ownership"] = {k: v for k, v in {
            "insiders_pct": _num(i.get("heldPercentInsiders")), "institutions_pct": _num(i.get("heldPercentInstitutions")),
            "short_pct_float": _num(i.get("shortPercentOfFloat")), "short_ratio_days": _num(i.get("shortRatio")),
        }.items() if v is not None}
        out["quality"] = {k: v for k, v in {
            "earnings_growth_q": _num(i.get("earningsQuarterlyGrowth")), "free_cashflow": _num(i.get("freeCashflow")),
            "operating_margin": _num(i.get("operatingMargins")), "current_ratio": _num(i.get("currentRatio")),
            "dividend_yield": _num(i.get("dividendYield")), "payout_ratio": _num(i.get("payoutRatio")),
        }.items() if v is not None}

    def recs():
        df = tk.recommendations
        if df is not None and len(df):
            row = df.iloc[0]
            out["ratings"] = {k: int(row.get(k, 0) or 0) for k in ("strongBuy", "buy", "hold", "sell", "strongSell")}

    def updown():
        df = tk.upgrades_downgrades
        if df is None or not len(df):
            return
        cutoff = datetime.now(timezone.utc) - timedelta(days=60)
        rows = []
        for idx, r in df.head(20).iterrows():
            d = idx.to_pydatetime() if hasattr(idx, "to_pydatetime") else None
            if d is not None and d.tzinfo is None:
                d = d.replace(tzinfo=timezone.utc)
            if d is not None and d < cutoff:
                continue
            rows.append({"date": _date(d), "firm": r.get("Firm"), "action": str(r.get("Action") or "").lower(),
                         "to": r.get("ToGrade"), "from": r.get("FromGrade"),
                         "target": _num(r.get("currentPriceTarget")), "prev_target": _num(r.get("priorPriceTarget"))})
        out["changes"] = rows[:8]

    def earnings():
        cal = tk.calendar
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if isinstance(ed, (list, tuple)) and ed:
                ed = ed[0]
            if ed:
                out["next_earnings"] = _date(ed)
            if cal.get("Earnings Average") is not None:
                out["eps_estimate"] = _num(cal.get("Earnings Average"))
        hist = tk.earnings_history
        if hist is not None and len(hist):
            rows = []
            for idx, r in hist.tail(4).iterrows():
                rows.append({"quarter": _date(idx), "estimate": _num(r.get("epsEstimate")), "actual": _num(r.get("epsActual")),
                             "surprise_pct": _num(r.get("surprisePercent")) and _num(r.get("surprisePercent")) * 100})
            out["eps_history"] = rows[::-1]

    def insiders():
        df = tk.insider_transactions
        if df is None or not len(df):
            return
        rows = []
        for _, r in df.head(8).iterrows():
            text = str(r.get("Text") or r.get("Transaction") or "")
            kind = "buy" if "purchase" in text.lower() or "buy" in text.lower() else "sell" if "sale" in text.lower() or "sell" in text.lower() else "other"
            rows.append({"date": _date(r.get("Start Date")), "who": r.get("Insider"), "role": r.get("Position"),
                         "kind": kind, "shares": _num(r.get("Shares")), "value": _num(r.get("Value"))})
        out["insiders"] = rows

    def news():
        items = []
        for n in (tk.news or [])[:10]:
            c = n.get("content") if isinstance(n.get("content"), dict) else n
            title = c.get("title")
            if not title:
                continue
            url = ((c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else None) or c.get("link") or ""
            prov = (c.get("provider") or {}).get("displayName") if isinstance(c.get("provider"), dict) else c.get("publisher")
            ts = c.get("pubDate") or c.get("providerPublishTime")
            if isinstance(ts, str):
                try:
                    ts = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
                except ValueError:
                    ts = time.time()
            items.append({"title": title, "url": url, "source": prov or "Yahoo Finance", "ts": float(ts or time.time())})
        out["news"] = items

    for name, fn in (("info", info), ("recs", recs), ("updown", updown), ("earnings", earnings), ("insiders", insiders), ("news", news)):
        safe(name, fn)
    return out


def signals_from(extras: dict, price: float | None) -> list[dict]:
    """Turn analyst/earnings/insider data into signals the scorer and alerts understand."""
    out = []
    if not extras:
        return out

    from ..translate import grade as _grade

    def sig(code, d, s, title, desc):
        out.append({"code": code, "cat": "analyst", "dir": d, "strength": round(s, 2), "title": title, "desc": desc})

    recent = [c for c in extras.get("changes", []) if c.get("date") and c["date"] >= (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d")]
    ups = [c for c in recent if c["action"] in ("up", "upgrade")]
    downs = [c for c in recent if c["action"] in ("down", "downgrade")]
    if ups:
        c = ups[0]
        sig("analyst_upgrade", 1, min(0.8, 0.5 + 0.1 * len(ups)), f"שדרוג אנליסט ({c.get('firm')})",
            f"{c.get('firm')} שדרג ל‑{_grade(c.get('to'))}" + (f", מחיר יעד {c['target']:.2f}" if c.get("target") else "") + f" ({c['date']}).")
    if downs:
        c = downs[0]
        sig("analyst_downgrade", -1, min(0.8, 0.5 + 0.1 * len(downs)), f"הורדת דירוג ({c.get('firm')})",
            f"{c.get('firm')} הוריד ל‑{_grade(c.get('to'))}" + (f", מחיר יעד {c['target']:.2f}" if c.get("target") else "") + f" ({c['date']}).")
    tm = (extras.get("analyst") or {}).get("target_mean")
    if tm and price:
        upside = (tm / price - 1) * 100
        if upside >= 20:
            sig("analyst_upside", 1, 0.35, f"פוטנציאל {upside:.0f}% ליעד האנליסטים", f"יעד ממוצע {tm:.2f} מול מחיר {price:.2f}.")
        elif upside <= -5:
            sig("above_target", -1, 0.35, "מעל יעד האנליסטים", f"המחיר {price:.2f} גבוה ב‑{-upside:.0f}% מהיעד הממוצע {tm:.2f}.")
    ne = extras.get("next_earnings")
    if ne:
        try:
            days = (datetime.strptime(ne, "%Y-%m-%d").date() - datetime.now().date()).days
            if 0 <= days <= 5:
                sig("earnings_soon", 0, 0.55, f"דוחות בעוד {days} ימים" if days else "דוחות היום",
                    f"פרסום דוחות {ne} – צפויה תנודתיות; שקול להקטין סיכון או להמתין.")
        except ValueError:
            pass
    buys = [i for i in extras.get("insiders", []) if i["kind"] == "buy" and i.get("date") and i["date"] >= (datetime.now() - timedelta(days=45)).strftime("%Y-%m-%d")]
    if buys:
        sig("insider_buy", 1, 0.45, "קניות בעלי עניין", f"{len(buys)} קניות של מנהלים/בעלי עניין ב‑45 הימים האחרונים.")
    return out


def summary_lines(extras: dict) -> list[str]:
    """Compact text for AI prompts."""
    if not extras:
        return []
    lines = []
    a, r = extras.get("analyst") or {}, extras.get("ratings") or {}
    if a or r:
        rr = " / ".join(f"{k} {v}" for k, v in r.items()) if r else ""
        lines.append(f"אנליסטים (Yahoo): דירוג ממוצע {a.get('mean_rating', 'n/a')} (1=קנייה חזקה, 5=מכירה), {a.get('analysts', '?')} אנליסטים"
                     + (f", יעד ממוצע {a['target_mean']:.2f} (טווח {a.get('target_low', 0):.2f}–{a.get('target_high', 0):.2f})" if a.get("target_mean") else "")
                     + (f" | התפלגות: {rr}" if rr else ""))
    ch = extras.get("changes") or []
    if ch:
        lines.append("שינויי דירוג אחרונים: " + "; ".join(f"{c['date']} {c.get('firm')} {c.get('action')} → {c.get('to')}" for c in ch[:4]))
    if extras.get("next_earnings"):
        lines.append(f"דוחות הבאים: {extras['next_earnings']}" + (f" (צפי EPS {extras['eps_estimate']:.2f})" if extras.get("eps_estimate") else ""))
    eh = extras.get("eps_history") or []
    if eh:
        lines.append("הפתעות EPS אחרונות: " + ", ".join(f"{e['quarter']} {e['surprise_pct']:+.1f}%" for e in eh if e.get("surprise_pct") is not None))
    ins = extras.get("insiders") or []
    if ins:
        b, s = sum(1 for i in ins if i["kind"] == "buy"), sum(1 for i in ins if i["kind"] == "sell")
        lines.append(f"בעלי עניין (עסקאות אחרונות): {b} קניות, {s} מכירות")
    o = extras.get("ownership") or {}
    if o:
        lines.append("אחזקות: " + ", ".join(f"{k}={v * 100:.1f}%" if k.endswith("pct") or k.endswith("float") else f"{k}={v}" for k, v in o.items()))
    return lines


# ------------------------------------------------------------------ demo
def _demo(ticker: str) -> dict:
    rng = random.Random(int(hashlib.md5(ticker.encode()).hexdigest()[:8], 16))
    from .prices import demo_history

    price = float(demo_history(ticker)["Close"].iloc[-1])
    today = datetime.now()
    firms = ["Morgan Stanley", "Goldman Sachs", "JPMorgan", "UBS", "Barclays", "Jefferies", "Wedbush"]
    changes = []
    for i in range(rng.randint(1, 4)):
        act = rng.choice(["up", "main", "main", "down", "init"])
        changes.append({"date": (today - timedelta(days=rng.randint(0, 40))).strftime("%Y-%m-%d"), "firm": rng.choice(firms),
                        "action": act, "to": rng.choice(["Buy", "Overweight", "Neutral", "Outperform", "Underweight"]),
                        "from": rng.choice(["Hold", "Neutral", "Buy"]), "target": round(price * rng.uniform(0.9, 1.35), 2), "prev_target": None})
    changes.sort(key=lambda c: c["date"], reverse=True)
    sb, b, h, s, ss = rng.randint(2, 15), rng.randint(5, 20), rng.randint(2, 15), rng.randint(0, 4), rng.randint(0, 2)
    return {
        "source": "yfinance (demo)", "fetched": time.time(),
        "analyst": {"mean_rating": round(rng.uniform(1.6, 3.2), 2), "rating_key": "buy", "analysts": sb + b + h + s + ss,
                    "target_mean": round(price * rng.uniform(0.95, 1.3), 2), "target_high": round(price * 1.5, 2), "target_low": round(price * 0.8, 2)},
        "ratings": {"strongBuy": sb, "buy": b, "hold": h, "sell": s, "strongSell": ss},
        "changes": changes,
        "next_earnings": (today + timedelta(days=rng.randint(2, 60))).strftime("%Y-%m-%d"), "eps_estimate": round(rng.uniform(0.3, 4), 2),
        "eps_history": [{"quarter": (today - timedelta(days=90 * q)).strftime("%Y-%m-%d"), "estimate": 1.0, "actual": 1.1,
                         "surprise_pct": round(rng.uniform(-8, 15), 1)} for q in range(1, 5)],
        "insiders": [{"date": (today - timedelta(days=rng.randint(1, 80))).strftime("%Y-%m-%d"), "who": "CFO", "role": "Officer",
                      "kind": rng.choice(["buy", "sell", "sell"]), "shares": rng.randint(1000, 50000), "value": None} for _ in range(3)],
        "ownership": {"insiders_pct": round(rng.uniform(0.001, 0.1), 4), "institutions_pct": round(rng.uniform(0.4, 0.9), 4)},
        "news": [],
    }
