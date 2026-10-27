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

import requests  # noqa: E402

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
        acc, ns, tok = os.environ["CF_ACCOUNT_ID"], os.environ["KV_NAMESPACE_ID"], os.environ["CF_API_TOKEN"]
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


# ------------------------------------------------------------------ main
def main() -> int:
    t0 = time.time()
    kv = KV()

    raw_db = kv.get("db")
    if raw_db:
        Path(os.environ["DB_PATH"]).write_bytes(raw_db)

    from app import db, engine
    from app.analysis import backtest
    from app.config import settings
    from app.data import prices
    from app.main import dashboard_payload

    db.init()
    cfg = kv.get_json("config")
    if cfg:
        apply_config(db, cfg)
    else:
        kv.put_json("config", config_from_db(db))  # first run: seeded from config/portfolio.yaml
        log.info("seeded portfolio config")

    vapid = ensure_vapid(kv)
    settings.VAPID_PUBLIC_KEY, settings.VAPID_PRIVATE_KEY = vapid["public"], vapid["private"]
    public_url = (kv.get("public_url") or b"").decode().strip()
    if public_url:
        settings.PUBLIC_URL = public_url

    subs = kv.get_json("push_subs") or []
    db.execute("DELETE FROM push_subs")
    for s in subs:
        if s.get("endpoint"):
            db.add_push_sub(s)

    st = json.loads(db.kv_get("engine_state") or "{}")
    for k in ("last_news", "last_brief", "scans"):
        if k in st:
            engine.state[k] = st[k]

    force = os.environ.get("FORCE_LLM") == "1"
    result = engine.run_scan(force_llm=force)
    log.info("scan: %s", {k: v for k, v in result.items() if k != "error"})
    if result.get("status") == "error":
        log.error("scan error: %s", result.get("error"))

    db.kv_set("engine_state", json.dumps({k: engine.state[k] for k in ("last_news", "last_brief", "scans")}))

    # ---- publish to KV
    dash = dashboard_payload()
    dash["mode"] = "cloud"
    dash["generated"] = time.time()
    dash["status"]["next_scan"] = None
    dash["features"]["webpush"] = True
    kv.put_json("dashboard", dash)

    snaps = db.all_snapshots()
    stocks = {}
    for t, s in snaps.items():
        s["news_items"] = db.list_news(t, limit=25)
        s["alerts"] = db.list_alerts(15, ticker=t)
        stocks[t] = s
    kv.put("stocks", bundle(stocks))

    # backtests: once a day, or when the ticker list changed
    meta = json.loads(db.kv_get("backtest_meta") or "{}")
    tickers = sorted(snaps)
    if time.time() - meta.get("ts", 0) > 20 * 3600 or meta.get("tickers") != tickers or force:
        bts = {}
        for t in tickers:
            try:
                df = prices.get_long_history(t, 3)
                bts[t] = {s: backtest.run(df, s) for s in STRATEGIES} if df is not None and len(df) > 120 else {}
            except Exception as exc:  # noqa: BLE001
                log.warning("backtest %s failed: %s", t, exc)
        kv.put("backtests", bundle(bts))
        db.kv_set("backtest_meta", json.dumps({"ts": time.time(), "tickers": tickers}))

    # push subs may have shrunk (expired phones)
    alive = db.list_push_subs()
    if len(alive) != len(subs):
        kv.put_json("push_subs", alive)

    db.execute("VACUUM") if engine.state["scans"] % 20 == 0 else None
    db.conn().commit()
    db.conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")
    kv.put("db", Path(os.environ["DB_PATH"]).read_bytes())
    log.info("done in %.1fs", time.time() - t0)
    return 0 if result.get("status") != "error" else 1


if __name__ == "__main__":
    sys.exit(main())
