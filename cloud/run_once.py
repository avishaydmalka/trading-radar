"""One scan cycle for GitHub Actions, with all state kept in Cloudflare KV.

Flow: download state (SQLite + portfolio config) from KV → scan → upload the
dashboard, per-stock data, backtests and the updated SQLite back to KV.
The Cloudflare Worker serves the dashboard from those KV keys.

Env (GitHub secrets): CF_API_TOKEN, CF_ACCOUNT_ID, KV_NAMESPACE_ID + the usual app keys.
Local testing: KV_BACKEND=file KV_DIR=/some/dir python -m cloud.run_once
"""
from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

# ---- must happen before importing the app (settings are read at import time)
WORK = Path(os.environ.get("RADAR_WORKDIR") or tempfile.mkdtemp(prefix="radar-"))
os.environ["DB_PATH"] = str(WORK / "radar.db")

import warnings  # noqa: E402

import requests  # noqa: E402

warnings.filterwarnings("ignore")  # library deprecation noise hides the useful lines in the Actions log

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("radar.cloud")
log.setLevel(logging.INFO)

STRATEGIES = ["bb_reversion", "bb_breakout", "sma_cross", "rsi_reversion"]


# ------------------------------------------------------------------ KV access
class KV:
    def __init__(self) -> None:
        self.backend = os.environ.get("KV_BACKEND", "cloudflare")
        if self.backend == "file":
            self.dir = Path(os.environ["KV_DIR"])
            self.dir.mkdir(parents=True, exist_ok=True)
            return
        acc, ns, tok = ("".join(os.environ[k].split()) for k in ("CF_ACCOUNT_ID", "KV_NAMESPACE_ID", "CF_API_TOKEN"))
        self.base = f"https://api.cloudflare.com/client/v4/accounts/{acc}/storage/kv/namespaces/{ns}"
        self.h = {"Authorization": f"Bearer {tok}"}

    def get(self, key: str) -> bytes | None:
        if self.backend == "file":
            p = self.dir / key.replace(":", "__")
            return p.read_bytes() if p.exists() else None
        r = requests.get(f"{self.base}/values/{key}", headers=self.h, timeout=60)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content

    def get_json(self, key: str):
        raw = self.get(key)
        return json.loads(raw) if raw else None

    def put(self, key: str, value: bytes | str) -> None:
        data = value.encode() if isinstance(value, str) else value
        if self.backend == "file":
            (self.dir / key.replace(":", "__")).write_bytes(data)
            return
        for attempt in range(3):
            r = requests.put(f"{self.base}/values/{key}", headers={**self.h, "Content-Type": "application/octet-stream"},
                             data=data, timeout=120)
            if r.ok:
                return
            log.warning("KV put %s failed (%s), retry", key, r.status_code)
            time.sleep(2 + attempt * 3)
        r.raise_for_status()

    def put_json(self, key: str, obj) -> None:
        from app.main import _clean
        self.put(key, json.dumps(_clean(obj), ensure_ascii=False, separators=(",", ":"), default=str))


def bundle(parts: dict[str, object]) -> str:
    """'\\n@@TICKER\\n{json}' blocks – the Worker slices one ticker out without parsing the rest."""
    from app.main import _clean
    return "".join(f"\n@@{k}\n" + json.dumps(_clean(v), ensure_ascii=False, separators=(",", ":"), default=str)
                   for k, v in parts.items()) + "\n@@END\n"


# ------------------------------------------------------------------ config sync
def config_from_db(db) -> dict:
    return {"holdings": db.list_holdings(), "watchlist": db.list_watch(), "risk": db.get_risk(), "feeds": db.get_feeds()}


def apply_config(db, cfg: dict) -> None:
    """KV config (edited from the dashboard) is the source of truth."""
    db.execute("DELETE FROM holdings")
    for h in cfg.get("holdings") or []:
        db.execute(
            "INSERT INTO holdings(id,ticker,basket,shares,avg_price,stop_loss,take_profit,trailing_pct,notes,opened_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (int(h["id"]), db.norm_ticker(h["ticker"]), h.get("basket") or "כללי", float(h["shares"]), float(h["avg_price"]),
             db._f(h.get("stop_loss")), db._f(h.get("take_profit")), db._f(h.get("trailing_pct")),
             h.get("notes") or "", h.get("opened_at")),
        )
    db.execute("DELETE FROM watchlist")
    for w in cfg.get("watchlist") or []:
        db.add_watch(w["ticker"], w.get("basket") or "מעקב")
    if cfg.get("risk"):
        db.kv_set("risk", json.dumps({**db.DEFAULT_RISK, **cfg["risk"]}))
    if cfg.get("feeds") is not None:
        db.kv_set("feeds", json.dumps(cfg["feeds"]))


def ensure_vapid(kv: KV) -> dict:
    keys = kv.get_json("vapid")
    if keys and keys.get("public") and keys.get("private"):
        return keys
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    import base64

    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
    k = ec.generate_private_key(ec.SECP256R1())
    keys = {
        "public": b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
        "private": b64(k.private_numbers().private_value.to_bytes(32, "big")),
    }
    kv.put_json("vapid", keys)
    log.info("generated VAPID keys")
    return keys


# ------------------------------------------------------------------ users
def load_users(kv: KV) -> list[dict]:
    """Users live in KV (managed from the dashboard). First run: migrate the single-user keys to 'admin'."""
    users = kv.get_json("users")
    if users:
        return users
    users = [{"id": "admin", "name": "מנהל", "is_admin": True, "color": 0}]
    for key in ("config", "dashboard", "stocks", "db", "push_subs"):
        raw = kv.get(key)
        if raw and kv.get(f"{key}:admin") is None:
            kv.put(f"{key}:admin", raw)
    kv.put_json("users", users)
    log.info("created users list (admin)")
    return users


def share_fetches(all_tickers: list[str]) -> None:
    """Fetch prices/news/social once per run and reuse them for every user."""
    from app.data import news, prices

    hist = prices.get_history(sorted(set(all_tickers)))
    orig_get_history = prices.get_history
    prices.get_history = lambda tickers, *a, **k: (
        {t: hist[t] for t in tickers if t in hist} if set(tickers) <= set(hist) else orig_get_history(tickers, *a, **k))

    def memo(fn):
        cache = {}

        def wrapper(*args):
            key = json.dumps(args, sort_keys=True, default=str)
            if key not in cache:
                cache[key] = fn(*args)
            return cache[key]
        return wrapper

    for name in ("ticker_news", "social", "market_news", "influencer_news", "congress_trades"):
        setattr(news, name, memo(getattr(news, name)))
    prices.get_fundamentals = memo(prices.get_fundamentals)


# ------------------------------------------------------------------ AI keys & free-tier budget
SHARED_KEYS = {k: os.environ.get(k, "").strip() for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY")}
# Requests per day the shared (admin's) keys may make, split between everyone without their own key.
# Kept far below the free tiers (Gemini Flash ~1,500/day, Groq ~1,000/day) so the shared key stays free.
SHARED_DAILY = int(os.environ.get("SHARED_LLM_DAILY_CALLS", "300") or 300)
PER_SCAN = int(os.environ.get("LLM_MAX_CALLS_PER_SCAN", "6") or 6)


def own_keys(kv: KV, uid: str) -> dict:
    keys = kv.get_json(f"llm_keys:{uid}") or {}
    return {k: v.strip() for k, v in keys.items() if isinstance(v, str) and v.strip()}


def setup_llm(user: dict, own: dict, usage: dict, n_shared: int) -> dict:
    """Point the LLM layer at the user's own keys, or at the shared keys with a fair daily budget."""
    from app.analysis import llm
    from app.config import settings

    uid = user["id"]
    if own:
        settings.GEMINI_API_KEY = own.get("gemini", "")
        settings.GROQ_API_KEY = own.get("groq", "")
        settings.OPENROUTER_API_KEY = own.get("openrouter", "")
        settings.LLM_MAX_CALLS_PER_SCAN = PER_SCAN
        llm.reset(PER_SCAN * 3 + 4)  # own key: generous, but still bounded per scan
        return {"mode": "own", "providers": sorted(own)}
    settings.GEMINI_API_KEY = SHARED_KEYS["GEMINI_API_KEY"]
    settings.GROQ_API_KEY = SHARED_KEYS["GROQ_API_KEY"]
    settings.OPENROUTER_API_KEY = SHARED_KEYS["OPENROUTER_API_KEY"]
    if not any(SHARED_KEYS.values()):
        llm.reset(0)
        return {"mode": "none"}
    share = max(1, SHARED_DAILY // max(1, n_shared))
    used = usage["users"].get(uid, 0)
    # analyses per scan + room for provider fallbacks and the market brief
    allowance = max(0, min(PER_SCAN + 4, share - used, SHARED_DAILY - usage["total"]))
    settings.LLM_MAX_CALLS_PER_SCAN = PER_SCAN
    llm.reset(allowance)
    return {"mode": "shared", "daily_share": share, "used_today": used}


# ------------------------------------------------------------------ main
def scan_user(kv: KV, user: dict, force: bool, vapid: dict, public_url: str, llm_info: dict) -> dict:
    from app import db, engine
    from app.config import settings
    from app.main import dashboard_payload

    uid = user["id"]
    path = str(WORK / f"radar-{uid}.db")
    raw_db = kv.get(f"db:{uid}")
    Path(path).unlink(missing_ok=True)
    if raw_db:
        Path(path).write_bytes(raw_db)
    db.use(path)
    db.init()
    cfg = kv.get_json(f"config:{uid}")
    if cfg is None:
        cfg = config_from_db(db) if user.get("is_admin") else {"holdings": [], "watchlist": [], "risk": dict(db.DEFAULT_RISK), "feeds": db.get_feeds()}
        kv.put_json(f"config:{uid}", cfg)
    apply_config(db, cfg)

    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = vapid["public"], vapid["private"]
    if public_url:
        settings.PUBLIC_URL = public_url
    # each person gets alerts in their own Telegram chat
    settings.TELEGRAM_CHAT_ID = str(user.get("telegram_chat_id") or (os.environ.get("TELEGRAM_CHAT_ID", "").strip() if user.get("is_admin") else ""))

    subs = kv.get_json(f"push_subs:{uid}") or []
    db.execute("DELETE FROM push_subs")
    for s in subs:
        if s.get("endpoint"):
            db.add_push_sub(s)

    st = json.loads(db.kv_get("engine_state") or "{}")
    engine.state.update({"last_news": 0.0, "last_brief": 0.0, "scans": 0})
    engine.state.update({k: st[k] for k in ("last_news", "last_brief", "scans") if k in st})

    result = engine.run_scan(force_llm=force)
    db.kv_set("engine_state", json.dumps({k: engine.state[k] for k in ("last_news", "last_brief", "scans")}))

    dash = dashboard_payload()
    from app.analysis import llm
    if llm_info["mode"] == "shared":
        llm_info = {**llm_info, "used_today": llm_info["used_today"] + llm.calls}
    llm_info = {**llm_info, "requests_this_scan": llm.calls, "last_ok": llm.last_ok, "errors": dict(llm.last_errors)}
    if llm.last_errors:
        log.warning("AI problems for %s: %s", uid, llm.last_errors)
    dash.update({"mode": "cloud", "generated": time.time(), "user": {"id": uid, "name": user.get("name")}, "llm": llm_info})
    dash["status"]["next_scan"] = None
    dash["features"]["webpush"] = True
    kv.put_json(f"dashboard:{uid}", dash)

    stocks = {}
    for t, s in db.all_snapshots().items():
        s["news_items"] = db.list_news(t, limit=25)
        s["alerts"] = db.list_alerts(15, ticker=t)
        stocks[t] = s
    kv.put(f"stocks:{uid}", bundle(stocks))

    alive = db.list_push_subs()
    if len(alive) != len(subs):
        kv.put_json(f"push_subs:{uid}", alive)

    if engine.state["scans"] % 20 == 0:
        db.execute("VACUUM")
    db.checkpoint()
    kv.put(f"db:{uid}", Path(path).read_bytes())
    return {**result, "tickers_list": sorted(stocks), "llm_requests": llm.calls, "llm_info": llm_info}


def quiet_state(kv: KV, now: float | None = None) -> dict:
    """Shabbat / Yom Tov windows (written by the Worker from Hebcal). Returns {current, last_ended, enabled}."""
    now = now or time.time()
    mode = kv.get_json("shabbat_mode") or {}
    enabled = mode.get("enabled", True) is not False
    windows = (kv.get_json("quiet_windows") or {}).get("windows") or []
    if not windows:  # Worker hasn't fetched yet: conservative Friday 12:30 → Saturday 19:30 UTC
        from datetime import datetime, timedelta, timezone
        d = datetime.fromtimestamp(now, timezone.utc).replace(hour=12, minute=30, second=0, microsecond=0)
        d -= timedelta(days=(d.weekday() - 4) % 7)
        windows = [{"start": (d.timestamp()) * 1000, "end": (d.timestamp() + 31 * 3600) * 1000, "kind": "shabbat", "title": "שבת"}]
    ms = now * 1000
    current = next((w for w in windows if w["start"] <= ms < w["end"]), None) if enabled else None
    ended = [w for w in windows if w["end"] <= ms and ms - w["end"] < 8 * 3600 * 1000]
    return {"enabled": enabled, "current": current, "last_ended": ended[-1] if ended and enabled else None}


def send_digests(kv: KV, users: list[dict], only: str, vapid: dict) -> None:
    from app import digest
    from app.notify import telegram

    force = os.environ.get("FORCE_DIGEST") == "1"
    q = quiet_state(kv)
    if q["current"]:
        log.info("quiet window (%s) – no digests until havdalah", q["current"].get("title"))
        return
    disc_items = (kv.get_json("discovery") or {}).get("items", [])
    sent = kv.get_json("digest_sent") or {}
    changed = False
    for u in users:
        uid = u["id"]
        if only and uid != only:
            continue
        slot = digest.due_slot(sent.get(uid) or {})
        after = q["last_ended"]
        if after and f"after:{int(after['end'])}" not in (sent.get(uid) or {}):
            slot = (f"after:{int(after['end'])}", "✨ שבוע טוב – סיכום המלצות" if after.get("kind") == "shabbat" else f"✨ מוצאי {after.get('title', 'חג')} – סיכום המלצות")
        if force:
            slot = (f"manual:{int(time.time())}", "📋 סיכום המלצות עדכני")
        if not slot:
            continue
        dash = kv.get_json(f"dashboard:{uid}")
        if not dash or not (dash.get("holdings") or dash.get("opportunities") or disc_items):
            continue
        key, title = slot
        text, card = digest.build(dash, title, disc_items)
        chat = str(u.get("telegram_chat_id") or (os.environ.get("TELEGRAM_CHAT_ID", "").strip() if u.get("is_admin") else ""))
        tg_ok = False
        if telegram.settings.TELEGRAM_BOT_TOKEN and chat:
            try:
                telegram.send_text(text, chat_id=chat)
                tg_ok = True
            except Exception as exc:  # noqa: BLE001
                log.warning("digest telegram %s: %s", uid, exc)
        dash["digest"] = card
        kv.put_json(f"dashboard:{uid}", dash)
        _push(kv, uid, vapid, {"title": f"📋 {title}", "body": "המלצות מעודכנות לתיק, לרשימת המעקב ו‑TOP 5 – הקש לצפייה", "url": "/#digest", "tag": "digest"})
        user_sent = {k: v for k, v in (sent.get(uid) or {}).items() if v > time.time() - 3 * 86400}
        user_sent[key] = time.time()
        if key.startswith("after:"):  # don't send the regular evening digest on top of it
            from datetime import datetime
            from zoneinfo import ZoneInfo
            day = datetime.now(ZoneInfo("Asia/Jerusalem")).strftime("%Y-%m-%d")
            for sid, _, _ in digest.SLOTS:
                user_sent.setdefault(f"{day}:{sid}", time.time())
        sent[uid] = user_sent
        changed = True
        log.info("digest %s → %s (telegram=%s)", title, u.get("name") or uid, tg_ok)
    if changed:
        kv.put_json("digest_sent", sent)


def _push(kv: KV, uid: str, vapid: dict, payload: dict) -> None:
    subs = kv.get_json(f"push_subs:{uid}") or []
    if not subs:
        return
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        return
    alive = []
    for sub in subs:
        try:
            webpush(subscription_info=sub, data=json.dumps(payload, ensure_ascii=False), vapid_private_key=vapid["private"],
                    vapid_claims={"sub": "mailto:radar@example.com"}, ttl=6 * 3600)
            alive.append(sub)
        except WebPushException as exc:
            if getattr(getattr(exc, "response", None), "status_code", None) not in (404, 410):
                alive.append(sub)
        except Exception:  # noqa: BLE001
            alive.append(sub)
    if len(alive) != len(subs):
        kv.put_json(f"push_subs:{uid}", alive)


def main() -> int:
    t0 = time.time()
    kv = KV()
    from app import db  # noqa: F401  (imports settings with DB_PATH set above)
    from app.analysis import backtest
    from app.data import prices

    users = load_users(kv)
    q = quiet_state(kv)
    if q["current"]:
        from app.config import settings as _s
        _s.QUIET = True  # alerts are stored in the app but nothing is sent to Telegram / phones
        log.info("🕯️ %s – notifications muted", q["current"].get("title"))
    configs = {u["id"]: kv.get_json(f"config:{u['id']}") or {} for u in users}
    all_tickers = sorted({h["ticker"] for c in configs.values() for h in c.get("holdings") or []}
                         | {w["ticker"] for c in configs.values() for w in c.get("watchlist") or []})
    from app.engine import INDEX_TICKERS
    share_fetches(all_tickers + list(INDEX_TICKERS))

    vapid = ensure_vapid(kv)
    public_url = (kv.get("public_url") or b"").decode().strip()
    force = os.environ.get("FORCE_LLM") == "1"
    only = os.environ.get("ONLY_USER", "").strip()

    today = time.strftime("%Y-%m-%d", time.gmtime())
    usage = kv.get_json("llm_usage") or {}
    if usage.get("date") != today:
        usage = {"date": today, "total": 0, "users": {}}
    usage_start = json.loads(json.dumps(usage))  # to merge with requests the Worker counts meanwhile (Q&A)
    owns = {u["id"]: own_keys(kv, u["id"]) for u in users}
    n_shared = sum(1 for u in users if not owns[u["id"]])

    from app.analysis import llm as _llm
    llm_state = kv.get_json("llm_state") or {}
    # start with the Gemini model that answered last time, so busy ones aren't retried every scan
    if llm_state.get("gemini_good") and time.time() - llm_state.get("ts", 0) < 6 * 3600:
        _llm._good_gemini = llm_state["gemini_good"]

    failures, scanned, ai_report = 0, set(), []
    for u in users:
        if only and u["id"] != only:
            continue
        try:
            info = setup_llm(u, owns[u["id"]], usage, n_shared)
            r = scan_user(kv, u, force, vapid, public_url, info)
            if info["mode"] == "shared":
                usage["total"] += r.get("llm_requests", 0)
                usage["users"][u["id"]] = usage["users"].get(u["id"], 0) + r.get("llm_requests", 0)
            scanned.update(r.get("tickers_list", []))
            li = r.get("llm_info") or {}
            status = (f"OK via {li['last_ok']}" if li.get("last_ok") else
                      f"FAILED – {li['errors']}" if li.get("errors") else
                      "no AI request this scan (not due yet)" if li.get("mode") != "none" else "no AI key")
            ai_report.append((u.get("name") or u["id"], li.get("mode"), li.get("requests_this_scan", 0), status))
            log.info("user %s: %s", u["id"], {k: v for k, v in r.items() if k in ("status", "tickers", "alerts", "llm_calls")})
            if r.get("status") == "error":
                failures += 1
                log.error("scan error (%s): %s", u["id"], r.get("error"))
        except Exception:  # noqa: BLE001
            failures += 1
            log.exception("user %s failed", u["id"])

    # backtests depend only on the ticker, so they are shared – once a day or when tickers change
    meta = kv.get_json("backtests_meta") or {}
    tickers = sorted(scanned)
    if tickers and (time.time() - meta.get("ts", 0) > 20 * 3600 or not set(tickers) <= set(meta.get("tickers", [])) or force):
        bts = {}
        for t in tickers:
            try:
                df = prices.get_long_history(t, 3)
                bts[t] = {s: backtest.run(df, s) for s in STRATEGIES} if df is not None and len(df) > 120 else {}
            except Exception as exc:  # noqa: BLE001
                log.warning("backtest %s failed: %s", t, exc)
        kv.put("backtests", bundle(bts))
        kv.put_json("backtests_meta", {"ts": time.time(), "tickers": tickers})

    # ---- discovery: TOP opportunities outside everyone's lists (every 3 hours, shared AI key)
    from app import discovery
    from app.config import settings as _settings
    disc_meta = kv.get_json("discovery_meta")
    if (discovery.due(disc_meta) or force) and (not only or force):
        try:
            _settings.GEMINI_API_KEY = SHARED_KEYS["GEMINI_API_KEY"]
            _settings.GROQ_API_KEY = SHARED_KEYS["GROQ_API_KEY"]
            _settings.OPENROUTER_API_KEY = SHARED_KEYS["OPENROUTER_API_KEY"]
            ai_budget = max(0, min(discovery.AI_REQUESTS, SHARED_DAILY - usage["total"])) if any(SHARED_KEYS.values()) else 0
            res = discovery.run(ai_budget=ai_budget)
            usage["total"] += res["ai_requests"]
            usage["discovery"] = usage.get("discovery", 0) + res["ai_requests"]
            kv.put("discovery_stocks", bundle(res.pop("stocks")))
            kv.put_json("discovery", res)
            kv.put_json("discovery_meta", {"ts": res["ts"]})
            ai_report.append(("🔭 גילוי", "shared", res["ai_requests"],
                              f"top: {', '.join(i['ticker'] for i in res['items'][:5])} (scanned {res['scanned']})"))
        except Exception:  # noqa: BLE001
            log.exception("discovery failed")

    # ---- Hebrew recommendation digest: Telegram + push + a card in the app (3x per trading day)
    try:
        send_digests(kv, users, only, vapid)
    except Exception:  # noqa: BLE001
        log.exception("digest failed")

    # merge: keep requests the Worker counted while this run was going
    latest = kv.get_json("llm_usage") or {}
    if latest.get("date") == usage["date"]:
        usage["total"] = latest.get("total", 0) + (usage["total"] - usage_start.get("total", 0))
        for k in set(usage["users"]) | set(latest.get("users", {})):
            usage["users"][k] = latest.get("users", {}).get(k, 0) + (usage["users"].get(k, 0) - usage_start.get("users", {}).get(k, 0))
        for k in ("qa", "discovery"):
            usage[k] = latest.get(k, 0) + (usage.get(k, 0) - usage_start.get(k, 0))
    kv.put_json("llm_usage", usage)
    if _llm._good_gemini:
        kv.put_json("llm_state", {"gemini_good": _llm._good_gemini, "ts": time.time()})
    # Put the AI status at the very end of the log and on the run's summary page
    for name, mode, n, status in ai_report:
        log.info("AI [%s] mode=%s requests=%s → %s", name, mode, n, status)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write("### 🤖 AI status\n\n| user | key | requests | result |\n|---|---|---|---|\n")
            for name, mode, n, status in ai_report:
                fh.write(f"| {name} | {mode} | {n} | {status} |\n")
            fh.write(f"\nShared key usage today: **{usage['total']} / {SHARED_DAILY}**\n")
    log.info("done: %d users in %.1fs, shared AI requests today %d/%d", len(users), time.time() - t0, usage["total"], SHARED_DAILY)
    return 1 if failures and failures == len([u for u in users if not only or u["id"] == only]) else 0


if __name__ == "__main__":
    sys.exit(main())
