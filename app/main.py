"""Trading Radar – web server, API, live stream and scheduler.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import math
import secrets
import threading
import time
from pathlib import Path

from sse_starlette.sse import EventSourceResponse
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from . import broker, db, engine
from .analysis import backtest, risk
from .config import settings
from .data import prices
from .notify import hub, telegram, webpush

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("radar")
STATIC = Path(__file__).parent / "static"


# ------------------------------------------------------------------ helpers
def _clean(o):
    if isinstance(o, float):
        return None if math.isnan(o) or math.isinf(o) else round(o, 6)
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


class J(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(_clean(content), ensure_ascii=False, default=str).encode("utf-8")


async def body(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


def _rescan_soon() -> None:
    threading.Thread(target=engine.run_scan, daemon=True).start()


# ------------------------------------------------------------------ auth
class BasicAuth(BaseHTTPMiddleware):
    OPEN = ("/api/health", "/sw.js", "/manifest.webmanifest", "/static/icon")

    async def dispatch(self, request: Request, call_next):
        if not settings.DASHBOARD_PASSWORD or request.url.path.startswith(self.OPEN):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                user, _, pwd = base64.b64decode(header[6:]).decode().partition(":")
                if secrets.compare_digest(user, settings.DASHBOARD_USER) and secrets.compare_digest(pwd, settings.DASHBOARD_PASSWORD):
                    return await call_next(request)
            except Exception:  # noqa: BLE001
                pass
        return Response("Authentication required", status_code=401, headers={"WWW-Authenticate": 'Basic realm="Trading Radar"'})


# ------------------------------------------------------------------ pages
async def index(_: Request):
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


async def service_worker(_: Request):
    return FileResponse(STATIC / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


async def manifest(_: Request):
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


async def health(_: Request):
    return J({"ok": True, "last_scan": engine.state["last_scan"]})


# ------------------------------------------------------------------ dashboard data
def _card(s: dict) -> dict:
    """Snapshot without the heavy chart, plus a sparkline."""
    c = {k: v for k, v in s.items() if k != "chart"}
    c["spark"] = (s.get("chart") or {}).get("c", [])[-40:]
    return c


def dashboard_payload() -> dict:
    snaps = db.all_snapshots()
    hmap = engine.aggregated_holdings()
    risk_cfg = db.get_risk()
    usdils = engine.get_usdils()
    pm = risk.portfolio_metrics(list(hmap.values()), snaps, risk_cfg, settings.BASE_CURRENCY, usdils)
    holdings = [_card(snaps[t]) for t in hmap if t in snaps]
    for t in hmap:
        if t not in snaps:
            holdings.append({"ticker": t, "name": t, "pending": True, "is_holding": True, "basket": hmap[t]["basket"]})
    watch_t = {w["ticker"] for w in db.list_watch()}
    opps = sorted([_card(s) for t, s in snaps.items() if t in watch_t and t not in hmap], key=lambda s: -s.get("score", 0))
    brief = db.get_summary("market_brief")
    tickers = list(hmap) + list(watch_t)
    news_rows = [n for n in db.list_news(limit=120, since_hours=72) if n["ticker"] in tickers or n["ticker"] == "MARKET"][:60]
    alerts = db.list_alerts(40)
    return {
        "status": engine.status_payload(),
        "demo": settings.DEMO_MODE,
        "features": {
            "llm": settings.llm_enabled(), "llm_providers": [p for p in settings.LLM_PROVIDERS],
            "telegram": telegram.enabled(), "webpush": webpush.enabled(), "broker": broker.enabled(),
        },
        "portfolio": pm,
        "risk": risk_cfg,
        "holdings": holdings,
        "lots": db.list_holdings(),
        "watchlist": db.list_watch(),
        "opportunities": opps,
        "indices": db.cache_get("indices", 10 ** 9) or {},
        "brief": brief[1] if brief else None,
        "alerts": alerts,
        "unread": sum(1 for a in alerts if not a["read"]),
        "news": news_rows,
        "equity": db.equity_series(90),
        "equity_backfill": equity_backfill(hmap, snaps, risk_cfg, usdils),
    }


def equity_backfill(hmap: dict, snaps: dict, risk_cfg: dict, usdils: float) -> dict:
    """Value of the CURRENT holdings over the last ~160 sessions (until real history accumulates)."""
    import pandas as pd

    frames = []
    for t, h in hmap.items():
        ch = (snaps.get(t) or {}).get("chart")
        if not ch:
            continue
        s = pd.Series(ch["c"], index=pd.to_datetime(ch["t"]), dtype="float64")
        frames.append(s.map(lambda v, h=h, t=t: risk.to_base(v * h["shares"], prices.currency_of(t), settings.BASE_CURRENCY, usdils)))
    if not frames:
        return {"t": [], "v": []}
    df = pd.concat(frames, axis=1).sort_index().ffill().dropna()
    total = df.sum(axis=1) + float(risk_cfg.get("cash", 0))
    return {"t": [d.strftime("%Y-%m-%d") for d in total.index], "v": [round(float(v), 2) for v in total]}


async def api_dashboard(_: Request):
    return J(await run_in_threadpool(dashboard_payload))


async def api_stock(request: Request):
    t = request.path_params["ticker"].upper()
    s = db.get_snapshot(t)
    if not s:
        return J({"error": "not tracked"}, status_code=404)
    s["news_items"] = db.list_news(t, limit=25)
    s["alerts"] = db.list_alerts(15, ticker=t)
    return J(s)


async def api_alerts_read(_: Request):
    db.mark_alerts_read()
    return J({"ok": True})


# ------------------------------------------------------------------ portfolio editing
async def api_holdings(request: Request):
    if request.method == "POST":
        b = await body(request)
        if not b.get("ticker") or not b.get("shares") or not b.get("avg_price"):
            return J({"error": "ticker, shares, avg_price are required"}, status_code=400)
        hid = db.add_holding(b)
        db.delete_watch(b["ticker"])
        _rescan_soon()
        return J({"id": hid})
    return J(db.list_holdings())


async def api_holding(request: Request):
    hid = int(request.path_params["hid"])
    if request.method == "DELETE":
        db.delete_holding(hid)
    else:
        db.update_holding(hid, await body(request))
    _rescan_soon()
    return J({"ok": True})


async def api_watch(request: Request):
    if request.method == "POST":
        b = await body(request)
        if not b.get("ticker"):
            return J({"error": "ticker required"}, status_code=400)
        db.add_watch(b["ticker"], b.get("basket") or "מעקב")
        _rescan_soon()
        return J({"ok": True})
    if request.method == "DELETE":
        db.delete_watch(request.path_params.get("ticker", ""))
        return J({"ok": True})
    return J(db.list_watch())


async def api_risk(request: Request):
    if request.method == "PUT":
        return J(db.set_risk(await body(request)))
    return J(db.get_risk())


async def api_scan(request: Request):
    force = request.query_params.get("llm") == "1"
    if engine.state["running"]:
        return J({"status": "busy"})
    threading.Thread(target=engine.run_scan, kwargs={"force_llm": force}, daemon=True).start()
    return J({"status": "started"})


async def api_backtest(request: Request):
    t = request.query_params.get("ticker", "").upper()
    strategy = request.query_params.get("strategy", "bb_reversion")
    years = max(1, min(10, int(request.query_params.get("years", "3"))))
    try:
        df = await run_in_threadpool(prices.get_long_history, t, years)
        if df is None or df.empty:
            return J({"error": "אין נתונים היסטוריים"}, status_code=400)
        res = await run_in_threadpool(backtest.run, df, strategy)
        res["ticker"] = t
        return J(res)
    except ValueError as exc:
        return J({"error": str(exc)}, status_code=400)


async def api_strategies(_: Request):
    return J(backtest.STRATEGIES)


# ------------------------------------------------------------------ notifications
async def api_stream(request: Request):
    q = hub.subscribe()

    async def gen():
        try:
            yield {"event": "status", "data": json.dumps(engine.status_payload(), default=str)}
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25)
                    yield msg
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": str(int(time.time()))}
        finally:
            hub.unsubscribe(q)

    return EventSourceResponse(gen())


async def api_push_key(_: Request):
    return J({"publicKey": settings.VAPID_PUBLIC_KEY or None})


async def api_push_subscribe(request: Request):
    sub = await body(request)
    if not sub.get("endpoint"):
        return J({"error": "bad subscription"}, status_code=400)
    db.add_push_sub(sub)
    return J({"ok": True})


async def api_notify_test(_: Request):
    a = await run_in_threadpool(hub.send_alert, {
        "ticker": None, "kind": "test", "level": "info", "title": "בדיקת התראות",
        "body": "אם אתה רואה את זה – ההתראות עובדות ✔", "score": None, "data": {}})
    return J({"ok": True, "alert": a, "telegram": telegram.enabled(), "webpush": webpush.enabled()})


# ------------------------------------------------------------------ broker
async def api_broker_account(_: Request):
    if not broker.enabled():
        return J({"enabled": False})
    try:
        acc = await run_in_threadpool(broker.account)
        pos = await run_in_threadpool(broker.positions)
        return J({"enabled": True, "account": acc, "positions": pos})
    except Exception as exc:  # noqa: BLE001
        return J({"enabled": True, "error": str(exc)}, status_code=502)


async def api_broker_order(request: Request):
    if not broker.enabled():
        return J({"error": "broker not configured"}, status_code=400)
    b = await body(request)
    if b.get("confirm") is not True:
        return J({"error": "explicit confirmation required"}, status_code=400)
    try:
        res = await run_in_threadpool(broker.bracket_order, b["ticker"].upper(), int(b["qty"]), b.get("side", "buy"),
                                      b.get("stop"), b.get("target"), b.get("limit"))
        hub.send_alert({"ticker": b["ticker"].upper(), "kind": "order", "level": "info",
                        "title": f"פקודה נשלחה ({'Paper' if 'paper' in settings.ALPACA_BASE_URL else 'LIVE'})",
                        "body": f"{b.get('side', 'buy')} {b['qty']} · סטטוס {res.get('status')}", "score": None, "data": res})
        return J(res)
    except Exception as exc:  # noqa: BLE001
        return J({"error": str(exc)}, status_code=400)


# ------------------------------------------------------------------ lifecycle
async def scheduler() -> None:
    await asyncio.sleep(1)
    while True:
        await run_in_threadpool(engine.run_scan)
        mins = engine.next_interval_min()
        engine.state["next_scan"] = time.time() + mins * 60
        hub.broadcast("status", engine.status_payload())
        await asyncio.sleep(mins * 60)


@contextlib.asynccontextmanager
async def lifespan(_app):
    db.init()
    hub.bind_loop(asyncio.get_running_loop())
    telegram.start_polling(engine.TELEGRAM_HANDLERS)
    task = asyncio.create_task(scheduler())
    log.info("Trading Radar started (demo=%s, llm=%s, telegram=%s, webpush=%s)",
             settings.DEMO_MODE, settings.llm_enabled(), telegram.enabled(), webpush.enabled())
    if telegram.enabled():
        threading.Thread(target=telegram.send_text, args=("🟢 רדאר המסחר עלה ופועל.",), daemon=True).start()
    yield
    task.cancel()


routes = [
    Route("/", index),
    Route("/sw.js", service_worker),
    Route("/manifest.webmanifest", manifest),
    Route("/api/health", health),
    Route("/api/dashboard", api_dashboard),
    Route("/api/stock/{ticker}", api_stock),
    Route("/api/alerts/read", api_alerts_read, methods=["POST"]),
    Route("/api/holdings", api_holdings, methods=["GET", "POST"]),
    Route("/api/holdings/{hid:int}", api_holding, methods=["PUT", "DELETE"]),
    Route("/api/watchlist", api_watch, methods=["GET", "POST"]),
    Route("/api/watchlist/{ticker}", api_watch, methods=["DELETE"]),
    Route("/api/risk", api_risk, methods=["GET", "PUT"]),
    Route("/api/scan", api_scan, methods=["POST"]),
    Route("/api/backtest", api_backtest),
    Route("/api/strategies", api_strategies),
    Route("/api/stream", api_stream),
    Route("/api/push/key", api_push_key),
    Route("/api/push/subscribe", api_push_subscribe, methods=["POST"]),
    Route("/api/notify/test", api_notify_test, methods=["POST"]),
    Route("/api/broker/account", api_broker_account),
    Route("/api/broker/order", api_broker_order, methods=["POST"]),
    Mount("/static", StaticFiles(directory=STATIC), name="static"),
]

app = Starlette(routes=routes, lifespan=lifespan,
                middleware=[Middleware(GZipMiddleware, minimum_size=1000), Middleware(BasicAuth)])
