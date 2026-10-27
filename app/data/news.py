"""News, social and political-trade collectors (all free).

- Google News RSS + Yahoo Finance RSS per ticker
- Market feeds (CNBC, MarketWatch, Globes, ...) – configurable in portfolio.yaml
- "Influencer" feeds: any RSS (Substack, YouTube, rss.app/RSSHub mirrors of X accounts)
- StockTwits public stream (bull/bear tags) and Reddit search
- Finnhub company news (optional free key)
- Congress trades (optional, configurable endpoint)
"""
from __future__ import annotations

import hashlib
import logging
import random
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

import requests

from ..analysis.sentiment import score_text
from ..config import settings

log = logging.getLogger("radar.news")
UA = {"User-Agent": "Mozilla/5.0 (TradingRadar; personal dashboard)"}
TIMEOUT = 12

DEFAULT_MARKET_FEEDS = {
    "CNBC": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    "MarketWatch": "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    "Yahoo Finance": "https://finance.yahoo.com/news/rssindex",
    "Investing.com": "https://www.investing.com/rss/news_25.rss",
    "גלובס – שוק ההון": "https://www.globes.co.il/webservice/rss/rssfeeder.asmx/FeederNode?iID=585",
}


def _id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:20]


def _base_symbol(ticker: str) -> str:
    return ticker.split(".")[0].replace("^", "")


# ------------------------------------------------------------------ RSS
def parse_rss(xml_text: str) -> list[dict]:
    """Parse RSS 2.0 or Atom into [{title, url, ts}]."""
    items: list[dict] = []
    try:
        root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)
    except ET.ParseError:
        return items
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        ts = _parse_date(it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date"))
        if title:
            items.append({"title": title, "url": link, "ts": ts})
    for it in root.iter("{http://www.w3.org/2005/Atom}entry"):
        title = (it.findtext("a:title", namespaces=ns) or "").strip()
        link_el = it.find("a:link", ns)
        link = link_el.get("href") if link_el is not None else ""
        ts = _parse_date(it.findtext("a:published", namespaces=ns) or it.findtext("a:updated", namespaces=ns))
        if title:
            items.append({"title": title, "url": link, "ts": ts})
    return items


def _parse_date(s: str | None) -> float:
    if not s:
        return time.time()
    try:
        return parsedate_to_datetime(s).timestamp()
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return time.time()


def fetch_rss(url: str) -> list[dict]:
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT)
        r.raise_for_status()
        return parse_rss(r.text)
    except Exception as exc:  # noqa: BLE001
        log.info("RSS failed %s: %s", url[:80], exc)
        return []


# ------------------------------------------------------------------ collectors
def ticker_news(ticker: str, name: str | None = None) -> list[dict]:
    if settings.DEMO_MODE:
        return _demo_news(ticker)
    sym = _base_symbol(ticker)
    out: list[dict] = []
    if ticker.endswith(".TA"):
        q = quote_plus(f'"{name or sym}" מניה')
        gurl = f"https://news.google.com/rss/search?q={q}&hl=iw&gl=IL&ceid=IL:he"
    else:
        q = quote_plus(f"{sym} stock" + (f' OR "{name}"' if name else ""))
        gurl = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    for it in fetch_rss(gurl)[:20]:
        src = "Google News"
        title = it["title"]
        if " - " in title:  # Google appends " - Publisher"
            title, src = title.rsplit(" - ", 1)
        out.append(_item(ticker, src, "news", title, it["url"], it["ts"]))
    if not ticker.endswith(".TA"):
        yurl = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US"
        for it in fetch_rss(yurl)[:15]:
            out.append(_item(ticker, "Yahoo Finance", "news", it["title"], it["url"], it["ts"]))
    if settings.FINNHUB_API_KEY and not ticker.endswith(".TA"):
        out.extend(_finnhub_news(ticker))
    return _dedupe(out)


def market_news(feeds: dict | None = None) -> list[dict]:
    if settings.DEMO_MODE:
        return _demo_market_news()
    feeds = feeds or DEFAULT_MARKET_FEEDS
    out = []
    for src, url in feeds.items():
        for it in fetch_rss(url)[:15]:
            out.append(_item("MARKET", src, "news", it["title"], it["url"], it["ts"]))
    return _dedupe(out)


def influencer_news(feeds: dict, tickers: list[str]) -> list[dict]:
    """Custom RSS sources. Items are tagged to a ticker when they mention $TICKER or the symbol."""
    if settings.DEMO_MODE or not feeds:
        return []
    out = []
    syms = {_base_symbol(t).upper(): t for t in tickers}
    for src, url in feeds.items():
        for it in fetch_rss(url)[:20]:
            text = it["title"].upper()
            tagged = [t for s, t in syms.items() if f"${s}" in text or f" {s} " in f" {text} "]
            for t in tagged or ["MARKET"]:
                out.append(_item(t, src, "influencer", it["title"], it["url"], it["ts"]))
    return _dedupe(out)


def social(ticker: str) -> dict:
    """StockTwits bull/bear ratio + recent messages (+ Reddit mentions)."""
    if settings.DEMO_MODE:
        return _demo_social(ticker)
    sym = _base_symbol(ticker)
    res = {"bull": 0, "bear": 0, "messages": 0, "items": [], "reddit_mentions": 0}
    if ticker.endswith(".TA"):
        return res
    try:
        r = requests.get(f"https://api.stocktwits.com/api/2/streams/symbol/{sym}.json", headers=UA, timeout=TIMEOUT)
        if r.ok:
            for m in r.json().get("messages", [])[:30]:
                tag = ((m.get("entities") or {}).get("sentiment") or {}).get("basic")
                res["messages"] += 1
                if tag == "Bullish":
                    res["bull"] += 1
                elif tag == "Bearish":
                    res["bear"] += 1
                body = (m.get("body") or "")[:200]
                ts = _parse_date(m.get("created_at"))
                sent = 0.6 if tag == "Bullish" else -0.6 if tag == "Bearish" else score_text(body)
                res["items"].append({**_item(ticker, "StockTwits", "social", body,
                                             f"https://stocktwits.com/symbol/{sym}", ts), "sentiment": sent})
    except Exception as exc:  # noqa: BLE001
        log.info("stocktwits %s: %s", sym, exc)
    try:
        r = requests.get("https://www.reddit.com/search.json",
                         params={"q": f"${sym} OR {sym} stock", "sort": "new", "t": "day", "limit": 25},
                         headers=UA, timeout=TIMEOUT)
        if r.ok:
            posts = r.json().get("data", {}).get("children", [])
            res["reddit_mentions"] = len(posts)
            for p in posts[:8]:
                d = p.get("data", {})
                res["items"].append(_item(ticker, f"Reddit r/{d.get('subreddit', '')}", "social",
                                          d.get("title", ""), "https://reddit.com" + d.get("permalink", ""),
                                          float(d.get("created_utc") or time.time())))
    except Exception as exc:  # noqa: BLE001
        log.info("reddit %s: %s", sym, exc)
    return res


def congress_trades(ticker: str) -> list[dict]:
    """Recent US Congress trades in this ticker (STOCK Act disclosures). Best-effort."""
    if settings.DEMO_MODE:
        return _demo_congress(ticker)
    if ticker.endswith(".TA") or not settings.CONGRESS_API_URL:
        return []
    headers = dict(UA)
    if settings.CONGRESS_API_KEY:
        headers["Authorization"] = f"Bearer {settings.CONGRESS_API_KEY}"
        headers["X-API-Key"] = settings.CONGRESS_API_KEY
    try:
        r = requests.get(settings.CONGRESS_API_URL, params={"ticker": _base_symbol(ticker), "limit": 20},
                         headers=headers, timeout=TIMEOUT)
        if not r.ok:
            return []
        data = r.json()
    except Exception as exc:  # noqa: BLE001
        log.info("congress %s: %s", ticker, exc)
        return []
    rows = data if isinstance(data, list) else data.get("trades") or data.get("data") or data.get("results") or []
    out = []
    for row in rows[:20]:
        g = lambda *keys: next((row.get(k) for k in keys if row.get(k)), None)  # noqa: E731
        sym = (g("ticker", "symbol") or "").upper()
        if sym and sym != _base_symbol(ticker).upper():
            continue
        out.append({
            "member": g("member", "representative", "senator", "name", "politician") or "?",
            "party": g("party") or "",
            "type": str(g("transactionType", "transaction_type", "type") or "").lower(),
            "date": g("transactionDate", "transaction_date", "date") or "",
            "disclosed": g("disclosureDate", "disclosure_date") or "",
            "amount": g("amountRange", "amount", "range") or "",
        })
    return out


# ------------------------------------------------------------------ helpers
def _item(ticker: str, source: str, kind: str, title: str, url: str, ts: float) -> dict:
    return {"id": _id(ticker, title[:120]), "ticker": ticker, "source": source, "kind": kind,
            "title": title.strip(), "url": url, "ts": ts, "sentiment": score_text(title)}


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in sorted(items, key=lambda x: -x["ts"]):
        if it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append(it)
    return out


def _finnhub_news(ticker: str) -> list[dict]:
    today = datetime.utcnow().date()
    try:
        r = requests.get("https://finnhub.io/api/v1/company-news", timeout=TIMEOUT, params={
            "symbol": ticker, "from": str(today - timedelta(days=3)), "to": str(today), "token": settings.FINNHUB_API_KEY})
        r.raise_for_status()
        return [_item(ticker, n.get("source", "Finnhub"), "news", n.get("headline", ""), n.get("url", ""),
                      float(n.get("datetime") or time.time())) for n in r.json()[:15] if n.get("headline")]
    except Exception as exc:  # noqa: BLE001
        log.info("finnhub %s: %s", ticker, exc)
        return []


# ------------------------------------------------------------------ demo data
_DEMO_HEADLINES = [
    ("{s} beats earnings estimates, raises full-year guidance", "Reuters"),
    ("Analyst upgrades {s} to outperform on strong AI demand", "Barron's"),
    ("{s} shares slump after regulator opens probe", "Bloomberg"),
    ("{s} announces $5B buyback program", "CNBC"),
    ("Why {s} stock is trading lower today", "Motley Fool"),
    ("{s} wins multi-year government contract", "MarketWatch"),
    ("Short sellers pile into {s} ahead of earnings", "Yahoo Finance"),
    ("{s} expands partnership, shares jump", "Reuters"),
    ("{s} warns of weak demand in Europe", "Financial Times"),
    ("Is {s} still a buy after its record run?", "Seeking Alpha"),
]
_DEMO_HE = [
    ("{s} מזנקת לאחר דוחות חזקים מהצפי", "גלובס"),
    ("שדרוג: בית ההשקעות מעלה את מחיר היעד ל-{s}", "כלכליסט"),
    ("{s} יורדת על רקע אזהרת רווח", "TheMarker"),
    ("{s} חתמה על הסכם אסטרטגי בהיקף מאות מיליונים", "ביזפורטל"),
]


def _demo_news(ticker: str) -> list[dict]:
    rng = random.Random(f"{ticker}-{int(time.time() // 900)}")
    sym = _base_symbol(ticker)
    pool = _DEMO_HE + _DEMO_HEADLINES[:4] if ticker.endswith(".TA") else _DEMO_HEADLINES
    picks = rng.sample(pool, k=min(5, len(pool)))
    now = time.time()
    return [_item(ticker, src, "news", tpl.format(s=sym), f"https://example.com/{sym}/{i}",
                  now - rng.uniform(0.2, 40) * 3600) for i, (tpl, src) in enumerate(picks)]


def _demo_market_news() -> list[dict]:
    now = time.time()
    rows = [
        ("Fed signals patience on rate cuts as inflation cools", "Reuters"),
        ("Tech stocks rally as chipmakers extend gains", "CNBC"),
        ("Oil slides on rising inventories", "MarketWatch"),
        ("Treasury yields fall after soft jobs data", "Bloomberg"),
        ("מדדי תל אביב עולים בהובלת הבנקים", "גלובס – שוק ההון"),
        ("Earnings season: 78% of S&P 500 companies beat estimates so far", "FactSet"),
    ]
    return [_item("MARKET", s, "news", t, "https://example.com/m", now - i * 2400) for i, (t, s) in enumerate(rows)]


def _demo_social(ticker: str) -> dict:
    rng = random.Random(f"s-{ticker}-{int(time.time() // 900)}")
    bull, bear = rng.randint(3, 22), rng.randint(2, 14)
    sym = _base_symbol(ticker)
    items = [_item(ticker, "StockTwits", "social", f"${sym} {'loading more, chart looks great' if i % 2 else 'taking profits here'}",
                   f"https://stocktwits.com/symbol/{sym}", time.time() - i * 900) for i in range(3)]
    for i, it in enumerate(items):
        it["sentiment"] = 0.6 if i % 2 else -0.4
    return {"bull": bull, "bear": bear, "messages": bull + bear + rng.randint(0, 10), "items": items,
            "reddit_mentions": rng.randint(0, 30)}


def _demo_congress(ticker: str) -> list[dict]:
    if ticker not in ("NVDA", "MSFT", "AAPL", "PLTR", "AVGO"):
        return []
    return [
        {"member": "Nancy Pelosi", "party": "D", "type": "purchase", "date": "2026-09-18", "disclosed": "2026-10-02",
         "amount": "$1,000,001 - $5,000,000"},
        {"member": "Dan Crenshaw", "party": "R", "type": "sale", "date": "2026-09-02", "disclosed": "2026-09-30",
         "amount": "$15,001 - $50,000"},
    ][: 1 + (len(ticker) % 2)]
