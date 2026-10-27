"""Opportunity discovery: scan a broad universe of liquid stocks nobody is tracking yet and
pick the strongest setups (technicals + news), then let the AI write a recommendation for the top ones.
"""
from __future__ import annotations

import logging
import time

from . import db
from .analysis import indicators, llm, risk, signals
from .analysis.sentiment import aggregate
from .data import news, prices

log = logging.getLogger("radar.discovery")

# ~150 liquid names across sectors (US large/mid caps + Tel Aviv blue chips).
UNIVERSE = [
    # tech & semis
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "AMD", "TSM", "ORCL", "CRM", "ADBE", "INTC", "QCOM",
    "MU", "AMAT", "LRCX", "KLAC", "ASML", "ARM", "MRVL", "SNPS", "CDNS", "NOW", "PANW", "CRWD", "ZS", "FTNT",
    "NET", "DDOG", "SNOW", "MDB", "PLTR", "SHOP", "UBER", "ABNB", "DASH", "SPOT", "NFLX", "TSLA", "SMCI", "DELL",
    "ANET", "APP", "IBM", "CSCO", "TXN", "ON", "MSTR", "COIN", "HOOD", "SOFI", "RBLX", "TTD",
    # financials
    "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "BLK", "V", "MA", "AXP", "PYPL", "BRK-B", "KKR", "BX",
    # healthcare
    "LLY", "NVO", "UNH", "JNJ", "ABBV", "MRK", "PFE", "TMO", "ABT", "ISRG", "VRTX", "REGN", "AMGN", "GILD", "DXCM",
    # consumer
    "WMT", "COST", "HD", "LOW", "MCD", "SBUX", "NKE", "KO", "PEP", "PG", "DIS", "CMG", "LULU", "TGT", "BKNG",
    # industrials, energy, materials
    "CAT", "DE", "GE", "HON", "BA", "LMT", "RTX", "NOC", "UPS", "XOM", "CVX", "COP", "OXY", "SLB", "FCX", "NEM",
    "LIN", "VST", "CEG", "NEE", "ETN", "PWR",
    # Tel Aviv (prices in shekels)
    "TEVA.TA", "NICE.TA", "ESLT.TA", "LUMI.TA", "POLI.TA", "DSCT.TA", "MZTF.TA", "ICL.TA", "TSEM.TA", "NVMI.TA",
    "CAMT.TA", "AZRG.TA", "BEZQ.TA", "PHOE.TA", "HARL.TA", "MGDL.TA", "ORL.TA", "ENLT.TA", "NWMD.TA", "SPEN.TA",
]

DISCOVERY_EVERY_SEC = 3 * 3600
TOP_KEEP = 10          # stored; each user sees the best 5 they don't already follow
AI_ANALYSES = 5
AI_REQUESTS = 9        # including fallbacks between models


def due(meta: dict | None) -> bool:
    return not meta or time.time() - meta.get("ts", 0) >= DISCOVERY_EVERY_SEC


def run(exclude_everywhere: set[str] | None = None, ai_budget: int = AI_REQUESTS) -> dict:
    """Returns {'ts', 'items': [...cards], 'stocks': {ticker: full snapshot}, 'ai_requests': n}."""
    exclude_everywhere = exclude_everywhere or set()
    t0 = time.time()
    hist = prices.get_history(UNIVERSE, refresh_latest=False)
    risk_cfg = dict(db.DEFAULT_RISK)
    usdils = prices.get_fx_usdils()
    candidates = []
    for t, df in hist.items():
        if t in exclude_everywhere or df is None or len(df) < 120:
            continue
        try:
            d = indicators.enrich(df)
            ind = indicators.latest(d)
            # liquidity: average daily turnover above ~$20M (₪20M for TASE)
            turnover = (ind.get("price") or 0) * float(d["VOL_AVG20"].iloc[-1] or 0)
            if turnover < 20e6 or (ind.get("price") or 0) < 3:
                continue
            sigs = signals.evaluate(d)
            score = signals.technical_score(sigs, ind)
            strong = [s for s in sigs if s["dir"] > 0 and s["strength"] >= 0.6]
            if score < 25 or not strong:
                continue
            candidates.append({"t": t, "d": d, "ind": ind, "sigs": sigs, "score": score})
        except Exception as exc:  # noqa: BLE001
            log.debug("discovery %s: %s", t, exc)
    candidates.sort(key=lambda c: -c["score"])
    shortlist = candidates[:TOP_KEEP + 4]

    # news sentiment for the shortlist only
    for c in shortlist:
        try:
            items = news.ticker_news(c["t"])
        except Exception:  # noqa: BLE001
            items = []
        c["news"] = items[:10]
        c["news_sent"] = aggregate(items[:15])
        c["final"] = round(max(-100.0, min(100.0, 0.8 * c["score"] + 25 * c["news_sent"])), 1)
    shortlist.sort(key=lambda c: -c["final"])
    top = shortlist[:TOP_KEEP]

    llm.reset(ai_budget)
    items, stocks = [], {}
    for i, c in enumerate(top):
        t, ind = c["t"], c["ind"]
        ccy = prices.currency_of(t)
        fund = {}
        if i < AI_ANALYSES:
            try:
                fund = prices.get_fundamentals(t) or {}
            except Exception:  # noqa: BLE001
                fund = {}
        name = fund.get("name") or prices.demo_name(t)
        sizing = risk.position_size(ind, risk_cfg, 100000, 0, ccy, "USD", usdils)
        ctx = {"ticker": t, "name": name, "currency": ccy, "ind": ind, "signals": c["sigs"], "score": c["final"],
               "holding": None, "news": c["news"], "social": {}, "fundamentals": fund, "congress": [], "sizing": sizing}
        analysis = llm.analyze_stock(ctx) if i < AI_ANALYSES and llm.has_budget() else llm.rule_based_stock(ctx)
        topsig = max(c["sigs"], key=lambda s: s["strength"])
        snap = {
            "ticker": t, "name": name, "currency": ccy, "basket": "גילוי", "is_holding": False, "discovered": True,
            "ind": ind, "signals": c["sigs"], "tech_score": c["score"], "news_sentiment": c["news_sent"], "social": {},
            "score": c["final"], "action": analysis["action"], "analysis": analysis, "analysis_ts": time.time(),
            "top_signal": topsig["title"], "sizing": sizing, "risk_issues": [], "fundamentals": fund, "congress": [],
            "holding": None, "position": None, "pnl_pct": None, "chart": indicators.chart_series(c["d"]),
            "news_items": c["news"], "alerts": [], "updated": time.time(), "rank": i + 1,
        }
        stocks[t] = snap
        items.append({k: v for k, v in snap.items() if k not in ("chart", "news_items", "alerts")}
                     | {"spark": snap["chart"]["c"][-40:]})
    log.info("discovery: %d scanned, %d candidates, top=%s in %.1fs", len(hist), len(candidates),
             [i["ticker"] for i in items[:5]], time.time() - t0)
    return {"ts": time.time(), "scanned": len(hist), "candidates": len(candidates), "items": items, "stocks": stocks,
            "ai_requests": llm.calls}
