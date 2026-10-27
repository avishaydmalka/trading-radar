"""The scan cycle: data → indicators → signals → sentiment → risk/budget → LLM → alerts."""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

from . import db
from .analysis import indicators, llm, risk, signals
from .analysis.sentiment import aggregate
from .config import settings
from .data import news, prices
from .notify import hub

log = logging.getLogger("radar.engine")

INDEX_TICKERS = {"SPY": "S&P 500", "QQQ": "נאסד\"ק 100", "^VIX": "VIX פחד", "^TA125.TA": "ת\"א 125"}
BRIEF_RESERVE = 4  # AI requests kept for the market brief in every scan

ACTION_HE = {"BUY": "קנייה", "ADD": "הגדלה", "HOLD": "החזקה", "WATCH": "מעקב", "TRIM": "מימוש חלקי", "SELL": "מכירה"}

state = {
    "running": False, "last_scan": None, "last_duration": None, "next_scan": None, "scans": 0,
    "last_news": 0.0, "last_brief": 0.0, "last_error": "", "markets": {},
}
_scan_lock = threading.Lock()


# ------------------------------------------------------------------ market hours
def market_status(now: datetime | None = None) -> dict:
    now = now or datetime.now(ZoneInfo("UTC"))
    ny = now.astimezone(ZoneInfo("America/New_York"))
    tlv = now.astimezone(ZoneInfo("Asia/Jerusalem"))
    us_min = ny.hour * 60 + ny.minute
    us_open = ny.weekday() < 5 and 9 * 60 + 30 <= us_min < 16 * 60
    us_ext = ny.weekday() < 5 and (4 * 60 <= us_min < 9 * 60 + 30 or 16 * 60 <= us_min < 20 * 60)
    ta_min = tlv.hour * 60 + tlv.minute
    # TASE trades Monday–Friday since January 2026 (Friday is a shorter session)
    if tlv.weekday() <= 3:
        ta_open = 9 * 60 + 59 <= ta_min < 17 * 60 + 25
    elif tlv.weekday() == 4:
        ta_open = 9 * 60 + 59 <= ta_min < 14 * 60
    else:
        ta_open = False
    return {"us": "open" if us_open else "extended" if us_ext else "closed", "tase": "open" if ta_open else "closed"}


def next_interval_min() -> int:
    m = market_status()
    if m["us"] == "open" or m["tase"] == "open":
        return settings.SCAN_INTERVAL_MIN
    if m["us"] == "extended":
        return max(settings.SCAN_INTERVAL_MIN, 15)
    return settings.OFFHOURS_INTERVAL_MIN


# ------------------------------------------------------------------ helpers
def aggregated_holdings() -> dict[str, dict]:
    """Merge multiple lots of the same ticker into one position."""
    out: dict[str, dict] = {}
    for h in db.list_holdings():
        t = h["ticker"]
        if t not in out:
            out[t] = {**h, "lots": [h["id"]]}
            continue
        a = out[t]
        total = a["shares"] + h["shares"]
        a["avg_price"] = (a["avg_price"] * a["shares"] + h["avg_price"] * h["shares"]) / total if total else a["avg_price"]
        a["shares"] = total
        a["stop_loss"] = max(filter(None, [a.get("stop_loss"), h.get("stop_loss")]), default=None)
        a["take_profit"] = a.get("take_profit") or h.get("take_profit")
        a["trailing_pct"] = a.get("trailing_pct") or h.get("trailing_pct")
        a["opened_at"] = min(filter(None, [a.get("opened_at"), h.get("opened_at")]), default=None)
        a["lots"].append(h["id"])
    return out


def get_usdils() -> float:
    cached = db.cache_get("fx:usdils", 3600)
    if cached:
        return float(cached)
    v = prices.get_fx_usdils()
    db.cache_set("fx:usdils", v)
    return v


def _cached(key: str, max_age: float, fn, *args):
    v = db.cache_get(key, max_age)
    if v is not None:
        return v
    try:
        v = fn(*args)
    except Exception as exc:  # noqa: BLE001
        log.info("%s failed: %s", key, exc)
        v = None
    if v is not None:
        db.cache_set(key, v)
    return v


def _social_score(soc: dict | None) -> float:
    if not soc:
        return 0.0
    b, r = soc.get("bull", 0), soc.get("bear", 0)
    return (b - r) / (b + r) if b + r >= 4 else 0.0


# ------------------------------------------------------------------ news cycle
def collect_news(tickers: list[str], names: dict[str, str]) -> list[dict]:
    """Fetch and store news/social for all tickers. Returns the NEW items."""
    new_items: list[dict] = []
    feeds = db.get_feeds()
    with ThreadPoolExecutor(max_workers=6) as pool:
        news_res = dict(zip(tickers, pool.map(lambda t: news.ticker_news(t, names.get(t)), tickers)))
        social_res = dict(zip(tickers, pool.map(news.social, tickers)))
    for t, items in news_res.items():
        for it in items:
            if db.upsert_news(it):
                new_items.append(it)
    for t, soc in social_res.items():
        db.cache_set(f"social:{t}", {k: v for k, v in soc.items() if k != "items"})
        for it in soc.get("items", []):
            db.upsert_news(it)
    for it in news.market_news(feeds.get("market") or None):
        db.upsert_news(it)
    for it in news.influencer_news(feeds.get("influencers") or {}, tickers):
        if db.upsert_news(it):
            new_items.append(it)
    return new_items


# ------------------------------------------------------------------ main scan
def run_scan(force_llm: bool = False) -> dict:
    if not _scan_lock.acquire(blocking=False):
        return {"status": "busy"}
    t0 = time.time()
    state["running"] = True
    hub.broadcast("status", {"running": True})
    try:
        result = _scan(force_llm)
        state["last_error"] = ""
        db.log_run(time.time() - t0, "ok", f"{result.get('tickers', 0)} tickers, {result.get('alerts', 0)} alerts")
        return result
    except Exception as exc:  # noqa: BLE001
        log.exception("scan failed")
        state["last_error"] = str(exc)
        db.log_run(time.time() - t0, "error", str(exc))
        return {"status": "error", "error": str(exc)}
    finally:
        state["running"] = False
        state["last_scan"] = time.time()
        state["last_duration"] = round(time.time() - t0, 1)
        state["scans"] += 1
        state["markets"] = market_status()
        _scan_lock.release()
        hub.broadcast("scan", status_payload())


def _scan(force_llm: bool) -> dict:
    hmap = aggregated_holdings()
    watch = {w["ticker"]: w for w in db.list_watch() if w["ticker"] not in hmap}
    tickers = list(hmap) + list(watch)
    hist = prices.get_history(tickers + list(INDEX_TICKERS))
    risk_cfg = db.get_risk()
    usdils = get_usdils()
    base = settings.BASE_CURRENCY
    prev_snaps = db.all_snapshots()

    # fundamentals / congress (daily cache, at most a few fresh fetches per scan)
    funds, congress = {}, {}
    fresh_budget = 6
    for t in tickers:
        if db.cache_get(f"fund:{t}", 86400) is None and fresh_budget <= 0:
            funds[t] = (prev_snaps.get(t) or {}).get("fundamentals") or {}
        else:
            if db.cache_get(f"fund:{t}", 86400) is None:
                fresh_budget -= 1
            funds[t] = _cached(f"fund:{t}", 86400, prices.get_fundamentals, t) or {}
        congress[t] = _cached(f"congress:{t}", 6 * 3600, news.congress_trades, t) or []
    names = {t: funds[t].get("name") or prices.demo_name(t) for t in tickers}

    new_news: list[dict] = []
    if time.time() - state["last_news"] >= settings.NEWS_INTERVAL_MIN * 60 or state["scans"] == 0:
        new_news = collect_news(tickers, names)
        state["last_news"] = time.time()

    # ---- pass 1: technicals + sentiment
    rows: dict[str, dict] = {}
    for t in tickers:
        df = hist.get(t)
        if df is None or len(df) < 30:
            log.info("no data for %s", t)
            continue
        d = indicators.enrich(df)
        ind = indicators.latest(d)
        h = hmap.get(t)
        sigs = signals.evaluate(d, h)
        tech = signals.technical_score(sigs, ind)
        recent = db.list_news(t, limit=40, since_hours=48)
        news_sent = aggregate(recent)
        soc = db.cache_get(f"social:{t}", 6 * 3600) or {}
        soc_score = _social_score(soc)
        score = round(max(-100.0, min(100.0, 0.65 * tech + 25 * news_sent + 10 * soc_score)), 1)
        rows[t] = {"d": d, "ind": ind, "signals": sigs, "tech": tech, "news_sent": news_sent, "social": soc,
                   "score": score, "news": recent[:10], "holding": h}

    # ---- portfolio + budget
    prelim = {t: {"ind": r["ind"]} for t, r in rows.items()}
    pm = risk.portfolio_metrics(list(hmap.values()), prelim, risk_cfg, base, usdils)
    for t, r in rows.items():
        ccy = prices.currency_of(t)
        r["sizing"] = risk.position_size(r["ind"], risk_cfg, pm["total"], pm["cash"], ccy, base, usdils)
        r["risk_issues"] = risk.check_trade(r["sizing"], risk_cfg, pm["total"])
        h = r["holding"]
        if h:
            row = next((x for x in pm["rows"] if x["ticker"] == t), None)
            r["position"] = row
            r["pnl_pct"] = (r["ind"]["price"] / h["avg_price"] - 1) * 100

    # ---- LLM (rate-limited, prioritised)
    def priority(t: str) -> float:
        r = rows[t]
        p = abs(r["score"])
        if any(s["cat"] == "exit" for s in r["signals"]):
            p += 200
        if r["holding"]:
            p += 30
        prev_codes = {s["code"] for s in (prev_snaps.get(t) or {}).get("signals", [])}
        if {s["code"] for s in r["signals"] if s["strength"] >= 0.6} - prev_codes:
            p += 100
        return p

    llm_calls = 0
    # set aside requests for the market brief before the stock analyses can use them up
    held_back = 0
    if llm.budget is not None:
        held_back = min(BRIEF_RESERVE, llm.budget)
        llm.budget -= held_back
    for t in sorted(rows, key=priority, reverse=True):
        r = rows[t]
        prev = prev_snaps.get(t) or {}
        age = time.time() - (prev.get("analysis_ts") or 0)
        prev_codes = {s["code"] for s in prev.get("signals", [])}
        new_strong = bool({s["code"] for s in r["signals"] if s["strength"] >= 0.6} - prev_codes)
        due = force_llm or age >= settings.LLM_INTERVAL_MIN * 60 or (new_strong and age >= 600)
        ctx = {"ticker": t, "name": names.get(t), "currency": prices.currency_of(t), "ind": r["ind"],
               "signals": r["signals"], "score": r["score"], "holding": r["holding"], "pnl_pct": r.get("pnl_pct"),
               "news": r["news"], "social": r["social"], "fundamentals": funds.get(t), "congress": congress.get(t),
               "sizing": None if r["holding"] else r["sizing"]}
        # keep a few requests for the market brief: one analysis can take up to 3 requests when a
        # provider is busy and the next one is tried
        if settings.llm_enabled() and due and llm_calls < settings.LLM_MAX_CALLS_PER_SCAN and llm.has_budget():
            r["analysis"] = llm.analyze_stock(ctx)
            r["analysis_ts"] = time.time()
            rb = llm.rule_based_stock(ctx)  # hard exit rules (stop/target/trailing) always win
            if rb["action"] in ("SELL", "TRIM") and any(s["cat"] == "exit" and s["strength"] >= 0.85 for s in r["signals"]):
                r["analysis"]["action"] = rb["action"]
            if r["analysis"].get("provider") != "rules":
                llm_calls += 1
        elif settings.llm_enabled() and prev.get("analysis") and prev["analysis"].get("provider") != "rules":
            r["analysis"], r["analysis_ts"] = prev["analysis"], prev.get("analysis_ts")
            # exit rules always override a stale LLM view
            rb = llm.rule_based_stock(ctx)
            if rb["action"] in ("SELL", "TRIM") and any(s["cat"] == "exit" for s in r["signals"]):
                r["analysis"] = {**r["analysis"], "action": rb["action"]}
        else:
            r["analysis"] = llm.rule_based_stock(ctx)
            r["analysis_ts"] = time.time()

    if llm.budget is not None:
        llm.budget += held_back  # now available for the market brief

    # ---- save snapshots
    for t, r in rows.items():
        h = r["holding"]
        top = max(r["signals"], key=lambda s: s["strength"]) if r["signals"] else None
        snap = {
            "ticker": t, "name": names.get(t) or t, "currency": prices.currency_of(t),
            "basket": (h or watch.get(t) or {}).get("basket"), "is_holding": bool(h),
            "ind": r["ind"], "signals": r["signals"], "tech_score": r["tech"], "news_sentiment": r["news_sent"],
            "social": r["social"], "score": r["score"], "action": r["analysis"]["action"],
            "prev_action": (prev_snaps.get(t) or {}).get("action"),
            "analysis": r["analysis"], "analysis_ts": r.get("analysis_ts"),
            "top_signal": top["title"] if top else "", "sizing": r["sizing"], "risk_issues": r["risk_issues"],
            "fundamentals": funds.get(t) or {}, "congress": congress.get(t) or [],
            "holding": {k: h[k] for k in ("shares", "avg_price", "stop_loss", "take_profit", "trailing_pct", "opened_at")} if h else None,
            "position": r.get("position"), "pnl_pct": r.get("pnl_pct"),
            "chart": indicators.chart_series(r["d"]), "updated": time.time(),
        }
        db.save_snapshot(t, snap)

    # indices
    idx = {}
    for t, label in INDEX_TICKERS.items():
        df = hist.get(t)
        if df is not None and len(df) > 2:
            closes = df["Close"].dropna()
            idx[t] = {"label": label, "price": float(closes.iloc[-1]),
                      "change_pct": float((closes.iloc[-1] / closes.iloc[-2] - 1) * 100),
                      "spark": [round(float(x), 2) for x in closes.tail(30)]}
    db.cache_set("indices", idx)

    # portfolio value history (one point per ~15 min)
    last_eq = db.cache_get("equity:last", 900)
    pm_final = risk.portfolio_metrics(list(hmap.values()), db.all_snapshots(), risk_cfg, base, usdils)
    if last_eq is None and pm_final["value"] > 0:
        db.add_equity_point(pm_final["total"], pm_final["cost"] + pm_final["cash"])
        db.cache_set("equity:last", 1)

    n_alerts = generate_alerts(rows, prev_snaps, new_news, congress, names)

    # market brief
    prev_brief = db.get_summary("market_brief")
    brief_is_rules = not prev_brief or prev_brief[1].get("provider", "rules") == "rules"
    if (time.time() - state["last_brief"] >= settings.BRIEF_INTERVAL_MIN * 60 or force_llm
            or (brief_is_rules and settings.llm_enabled() and llm.has_budget())):  # retry until the brief is AI-written
        build_brief(idx, pm_final)
        state["last_brief"] = time.time()

    if state["scans"] % 50 == 0:
        db.prune()
    return {"status": "ok", "tickers": len(rows), "alerts": n_alerts, "llm_calls": llm_calls}


# ------------------------------------------------------------------ alerts
def generate_alerts(rows: dict, prev_snaps: dict, new_news: list[dict], congress: dict, names: dict) -> int:
    sent = 0

    def fire(key, cooldown=None, **a):
        nonlocal sent
        if hub.send_alert(a, dedupe_key=key, cooldown_hours=cooldown):
            sent += 1

    for t, r in rows.items():
        h = r["holding"]
        sigs = {s["code"]: s for s in r["signals"]}
        price = r["ind"]["price"]
        action = r["analysis"]["action"]
        prev_action = (prev_snaps.get(t) or {}).get("action")
        if h:
            for code in ("stop_hit", "trailing_hit"):
                if code in sigs:
                    fire(f"{t}:{code}", 24, ticker=t, kind="exit", level="critical", title=sigs[code]["title"],
                         body=sigs[code]["desc"], score=r["score"], data={"price": price})
            if "target_hit" in sigs:
                fire(f"{t}:target_hit", 24, ticker=t, kind="exit", level="warning", title=sigs["target_hit"]["title"],
                     body=sigs["target_hit"]["desc"], score=r["score"], data={"price": price})
            if "near_stop" in sigs:
                fire(f"{t}:near_stop", 12, ticker=t, kind="risk", level="warning", title="מתקרב לסטופ",
                     body=sigs["near_stop"]["desc"], score=r["score"], data={"price": price})
            if action in ("SELL", "TRIM") and prev_action not in ("SELL", "TRIM"):
                bear = r["analysis"].get("bear") or [s["title"] for s in r["signals"] if s["dir"] < 0]
                pnl = r.get("pnl_pct")
                fire(f"{t}:action:{action}", None, ticker=t, kind="sell", level="warning",
                     title=f"המלצה: {ACTION_HE[action]}",
                     body=(f"רווח/הפסד בפוזיציה {pnl:+.1f}%. " if pnl is not None else "") + "סיבות: " + ", ".join(bear[:3]),
                     score=r["score"], data={"price": price, "pnl_pct": r.get("pnl_pct")})
            elif action == "ADD" and prev_action != "ADD" and not r["risk_issues"]:
                fire(f"{t}:action:ADD", None, ticker=t, kind="add", level="opportunity", title="הזדמנות להגדלת פוזיציה",
                     body=r["analysis"].get("headline", ""), score=r["score"], data={"price": price, "sizing": r["sizing"]})
        else:
            strong_bull = [s for s in r["signals"] if s["dir"] > 0 and s["strength"] >= 0.6]
            if r["score"] >= settings.MIN_OPPORTUNITY_SCORE and strong_bull and not r["risk_issues"]:
                fire(f"{t}:opportunity", None, ticker=t, kind="opportunity", level="opportunity",
                     title=f"הזדמנות: {strong_bull[0]['title']}",
                     body=r["analysis"].get("headline") or strong_bull[0]["desc"], score=r["score"],
                     data={"price": price, "sizing": r["sizing"]})
        if "bb_squeeze" in sigs and (h or r["score"] > 0):
            fire(f"{t}:squeeze", 48, ticker=t, kind="squeeze", level="info", title="סחיטת בולינגר",
                 body=sigs["bb_squeeze"]["desc"], score=r["score"], data={"price": price})
        for code in ("bb_squeeze_break_up", "bb_squeeze_break_down"):
            if code in sigs:
                fire(f"{t}:{code}", 24, ticker=t, kind="bollinger",
                     level=("opportunity" if code.endswith("up") else "critical" if h else "warning"),
                     title=sigs[code]["title"], body=sigs[code]["desc"], score=r["score"], data={"price": price})

    holdings = {t for t, r in rows.items() if r["holding"]}
    for it in new_news:
        if it["ticker"] in holdings and abs(it.get("sentiment", 0)) >= 0.6 and time.time() - it["ts"] < 6 * 3600:
            fire(f"news:{it['id']}", 72, ticker=it["ticker"], kind="news",
                 level="warning" if it["sentiment"] < 0 else "info",
                 title=("חדשות שליליות" if it["sentiment"] < 0 else "חדשות חיוביות") + f" · {it['source']}",
                 body=it["title"], score=round(it["sentiment"] * 100), data={"url": it.get("url")})

    # political trades: only for tickers you hold, recently disclosed, max 2 per scan
    from datetime import datetime as _dt, timedelta as _td
    recent_cut = (_dt.now() - _td(days=30)).strftime("%Y-%m-%d")
    congress_sent = 0
    for t, trades in congress.items():
        if t not in holdings:
            continue
        for c in trades[:3]:
            if str(c.get("disclosed") or c.get("date") or "") < recent_cut or congress_sent >= 2:
                continue
            congress_sent += 1
            fire(f"congress:{t}:{c['member']}:{c['date']}", 24 * 30, ticker=t, kind="congress", level="info",
                 title=f"עסקת קונגרס: {c['member']}",
                 body=f"{c['type']} {c['amount']} · בוצע {c['date']} · דווח {c.get('disclosed', '')}",
                 score=None, data=c)
    return sent


# ------------------------------------------------------------------ brief
def build_brief(idx: dict, pm: dict) -> dict:
    snaps = db.all_snapshots()
    holdings = [{"ticker": t, "score": s["score"], "action": s["action"]} for t, s in snaps.items() if s.get("is_holding")]
    opps = sorted([s for s in snaps.values() if not s.get("is_holding")], key=lambda s: -s["score"])
    mnews = db.list_news("MARKET", limit=15, since_hours=24)
    ctx = {"indices": idx, "portfolio": pm, "holdings": holdings,
           "opportunities": [{"ticker": s["ticker"], "score": s["score"], "top_signal": s.get("top_signal")} for s in opps],
           "news": mnews, "news_sentiment": aggregate(mnews)}
    if settings.llm_enabled() and llm.has_budget():
        brief = llm.market_brief(ctx)
    else:
        prev = db.get_summary("market_brief")
        # out of AI budget: keep a recent AI brief instead of downgrading it
        if prev and prev[1].get("provider", "rules") != "rules" and time.time() - prev[0] < 12 * 3600:
            return prev[1]
        brief = llm.rule_based_brief(ctx)
    brief["ts"] = time.time()
    db.save_summary("market_brief", brief)
    hub.broadcast("brief", brief)
    return brief


def status_payload() -> dict:
    return {
        "running": state["running"], "last_scan": state["last_scan"], "last_duration": state["last_duration"],
        "next_scan": state["next_scan"], "scans": state["scans"], "last_error": state["last_error"],
        "markets": market_status(), "interval_min": next_interval_min(),
    }


# ------------------------------------------------------------------ telegram command handlers
def tg_portfolio(_: str) -> str:
    snaps = db.all_snapshots()
    pm = risk.portfolio_metrics(list(aggregated_holdings().values()), snaps, db.get_risk(), settings.BASE_CURRENCY, get_usdils())
    sym = "₪" if pm["base"] == "ILS" else "$"
    lines = [f"💼 <b>שווי תיק</b> {sym}{pm['total']:,.0f}",
             f"יומי: {pm['day_pnl']:+,.0f} ({pm['day_pnl_pct']:+.2f}%) | כולל: {pm['pnl']:+,.0f} ({pm['total_pnl_pct']:+.1f}%)", ""]
    for r in sorted(pm["rows"], key=lambda x: -x["value"]):
        s = snaps.get(r["ticker"]) or {}
        dot = "🟢" if s.get("score", 0) > 20 else "🔴" if s.get("score", 0) < -20 else "⚪"
        lines.append(f"{dot} <b>{r['ticker']}</b> {r['pnl_pct']:+.1f}% · {ACTION_HE.get(s.get('action'), '')} ({s.get('score', 0):+.0f})")
    for w in pm["warnings"][:5]:
        lines.append(f"⚠️ {w['text']}")
    return "\n".join(lines)


def tg_top(_: str) -> str:
    snaps = [s for s in db.all_snapshots().values() if not s.get("is_holding")]
    snaps.sort(key=lambda s: -s["score"])
    lines = ["🚀 <b>הזדמנויות מובילות</b>"]
    for s in snaps[:8]:
        sz = s.get("sizing") or {}
        lines.append(f"<b>{s['ticker']}</b> {s['score']:+.0f} · {s.get('top_signal', '')}\n   כניסה {sz.get('entry', 0):.2f} סטופ {sz.get('stop', 0):.2f} יעד {sz.get('target', 0):.2f}")
    return "\n".join(lines)


def tg_stock(arg: str) -> str:
    t = arg.upper().strip()
    if not t:
        return "שימוש: /stock NVDA"
    s = db.get_snapshot(t)
    if not s:
        return f"{t} לא במעקב. הוסף אותה לרשימת המעקב בדשבורד."
    a, ind = s["analysis"], s["ind"]
    lines = [f"📈 <b>{t}</b> {s.get('name', '')}",
             f"מחיר {ind['price']:.2f} ({ind['change_pct']:+.2f}%) · RSI {ind.get('rsi') or 0:.0f} · %B {ind.get('bb_pctb') or 0:.2f}",
             f"ציון <b>{s['score']:+.0f}</b> · {ACTION_HE.get(s['action'], '')} ({a.get('confidence', 0)}%)",
             f"<i>{a.get('headline', '')}</i>", a.get("summary", "")]
    if a.get("bull"):
        lines.append("✅ " + " | ".join(a["bull"][:3]))
    if a.get("bear"):
        lines.append("⚠️ " + " | ".join(a["bear"][:3]))
    return "\n".join(lines)


def tg_brief(_: str) -> str:
    b = db.get_summary("market_brief")
    if not b:
        return "אין עדיין תדריך."
    b = b[1]
    lines = [f"🧭 <b>{b.get('title', '')}</b> (מצב רוח {b.get('mood', 0):+.0f})", b.get("summary", "")]
    if b.get("focus"):
        lines.append("🎯 " + " | ".join(b["focus"][:4]))
    if b.get("risks"):
        lines.append("⚠️ " + " | ".join(b["risks"][:3]))
    return "\n".join(lines)


def tg_alerts(_: str) -> str:
    rows = db.list_alerts(8)
    if not rows:
        return "אין התראות."
    emo = {"critical": "🔴", "warning": "🟡", "opportunity": "🟢", "info": "🔵"}
    return "\n".join(f"{emo.get(a['level'], '•')} {datetime.fromtimestamp(a['ts']).strftime('%d/%m %H:%M')} <b>{a.get('ticker') or ''}</b> {a['title']}" for a in rows)


def tg_scan(_: str) -> str:
    threading.Thread(target=run_scan, kwargs={"force_llm": False}, daemon=True).start()
    return "🔄 סריקה התחילה – התראות יישלחו אם יימצא משהו."


TELEGRAM_HANDLERS = {"portfolio": tg_portfolio, "top": tg_top, "stock": tg_stock, "brief": tg_brief,
                     "alerts": tg_alerts, "scan": tg_scan}
