"""SQLite storage. One small file, safe for a single-process server."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .config import load_portfolio_file, settings

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    basket TEXT DEFAULT 'כללי',
    shares REAL NOT NULL,
    avg_price REAL NOT NULL,
    stop_loss REAL,
    take_profit REAL,
    trailing_pct REAL,
    notes TEXT DEFAULT '',
    opened_at TEXT
);
CREATE TABLE IF NOT EXISTS watchlist (
    ticker TEXT PRIMARY KEY,
    basket TEXT DEFAULT 'מעקב'
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
    ticker TEXT PRIMARY KEY,
    ts REAL,
    data TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL,
    ticker TEXT,
    kind TEXT,
    level TEXT,
    title TEXT,
    body TEXT,
    score REAL,
    data TEXT,
    read INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
CREATE TABLE IF NOT EXISTS alert_keys (
    key TEXT PRIMARY KEY,
    ts REAL
);
CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    ts REAL,
    ticker TEXT,
    source TEXT,
    kind TEXT,
    title TEXT,
    url TEXT,
    sentiment REAL
);
CREATE INDEX IF NOT EXISTS idx_news_ticker_ts ON news(ticker, ts DESC);
CREATE TABLE IF NOT EXISTS summaries (
    key TEXT PRIMARY KEY,
    ts REAL,
    data TEXT
);
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    ts REAL,
    data TEXT
);
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    data TEXT
);
CREATE TABLE IF NOT EXISTS equity (
    ts REAL PRIMARY KEY,
    value REAL,
    cost REAL
);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL,
    duration REAL,
    status TEXT,
    message TEXT
);
"""

DEFAULT_RISK = {
    "cash": 10000.0,
    "risk_per_trade_pct": 1.0,     # max % of portfolio lost if a stop is hit
    "max_position_pct": 15.0,      # max weight of a single position
    "max_basket_pct": 40.0,        # max weight of a single basket
    "default_stop_pct": 8.0,       # used when a holding has no stop
    "default_target_pct": 20.0,    # used when a holding has no target
    "atr_stop_mult": 2.0,          # suggested stop = entry - mult * ATR
    "reward_risk": 2.0,            # suggested target = entry + R:R * risk
}


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        Path(settings.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(settings.DB_PATH, check_same_thread=False, timeout=30)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
    return _conn


def use(path: str) -> None:
    """Switch to another SQLite file (one per user in the cloud runner)."""
    global _conn
    with _lock:
        if _conn is not None:
            _conn.commit()
            _conn.close()
        _conn = None
        settings.DB_PATH = path


def checkpoint() -> None:
    with _lock:
        conn().commit()
        conn().execute("PRAGMA wal_checkpoint(TRUNCATE)")


def execute(sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
    with _lock:
        cur = conn().execute(sql, params)
        conn().commit()
        return cur


def query(sql: str, params: tuple | list = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def query_one(sql: str, params: tuple | list = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


# ---------------------------------------------------------------- init / seed
def init() -> None:
    with _lock:
        conn().executescript(SCHEMA)
        conn().commit()
    if not query_one("SELECT 1 AS x FROM kv WHERE key='seeded'"):
        seed_from_file()
        kv_set("seeded", "1")


def seed_from_file() -> None:
    data = load_portfolio_file()
    risk = {**DEFAULT_RISK, **(data.get("risk") or {})}
    kv_set("risk", json.dumps(risk))
    for h in data.get("holdings") or []:
        add_holding(h)
    for w in data.get("watchlist") or []:
        if isinstance(w, str):
            add_watch(w, "מעקב")
        else:
            add_watch(w["ticker"], w.get("basket", "מעקב"))
    kv_set("feeds", json.dumps(data.get("feeds") or {}))


# ---------------------------------------------------------------- key/value
def kv_get(key: str, default: Any = None) -> Any:
    row = query_one("SELECT value FROM kv WHERE key=?", (key,))
    return row["value"] if row else default


def kv_set(key: str, value: str) -> None:
    execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_risk() -> dict:
    raw = kv_get("risk")
    stored = json.loads(raw) if raw else {}
    return {**DEFAULT_RISK, **stored}


def set_risk(values: dict) -> dict:
    risk = get_risk()
    for k, v in values.items():
        if k in DEFAULT_RISK:
            risk[k] = float(v)
    kv_set("risk", json.dumps(risk))
    return risk


def get_feeds() -> dict:
    raw = kv_get("feeds")
    return json.loads(raw) if raw else {}


# ---------------------------------------------------------------- holdings
def norm_ticker(t: str) -> str:
    return t.strip().upper()


def list_holdings() -> list[dict]:
    return query("SELECT * FROM holdings ORDER BY basket, ticker")


def add_holding(h: dict) -> int:
    cur = execute(
        "INSERT INTO holdings(ticker,basket,shares,avg_price,stop_loss,take_profit,trailing_pct,notes,opened_at) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (
            norm_ticker(h["ticker"]),
            h.get("basket") or "כללי",
            float(h["shares"]),
            float(h["avg_price"]),
            _f(h.get("stop_loss")),
            _f(h.get("take_profit")),
            _f(h.get("trailing_pct")),
            h.get("notes") or "",
            h.get("opened_at") or time.strftime("%Y-%m-%d"),
        ),
    )
    return int(cur.lastrowid)


def update_holding(hid: int, h: dict) -> None:
    fields = ["ticker", "basket", "shares", "avg_price", "stop_loss", "take_profit", "trailing_pct", "notes", "opened_at"]
    sets, vals = [], []
    for f in fields:
        if f in h:
            v = h[f]
            if f == "ticker":
                v = norm_ticker(v)
            elif f in ("shares", "avg_price", "stop_loss", "take_profit", "trailing_pct"):
                v = _f(v)
            sets.append(f"{f}=?")
            vals.append(v)
    if sets:
        execute(f"UPDATE holdings SET {','.join(sets)} WHERE id=?", (*vals, hid))


def delete_holding(hid: int) -> None:
    execute("DELETE FROM holdings WHERE id=?", (hid,))


def list_watch() -> list[dict]:
    return query("SELECT * FROM watchlist ORDER BY basket, ticker")


def add_watch(ticker: str, basket: str = "מעקב") -> None:
    execute(
        "INSERT INTO watchlist(ticker,basket) VALUES(?,?) ON CONFLICT(ticker) DO UPDATE SET basket=excluded.basket",
        (norm_ticker(ticker), basket or "מעקב"),
    )


def delete_watch(ticker: str) -> None:
    execute("DELETE FROM watchlist WHERE ticker=?", (norm_ticker(ticker),))


def _f(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- snapshots / summaries / cache
def save_snapshot(ticker: str, data: dict) -> None:
    execute(
        "INSERT INTO snapshots(ticker,ts,data) VALUES(?,?,?) ON CONFLICT(ticker) DO UPDATE SET ts=excluded.ts, data=excluded.data",
        (ticker, time.time(), json.dumps(data, default=_json_default)),
    )


def get_snapshot(ticker: str) -> dict | None:
    row = query_one("SELECT data FROM snapshots WHERE ticker=?", (ticker,))
    return json.loads(row["data"]) if row else None


def all_snapshots() -> dict[str, dict]:
    return {r["ticker"]: json.loads(r["data"]) for r in query("SELECT ticker,data FROM snapshots")}


def save_summary(key: str, data: dict) -> None:
    execute(
        "INSERT INTO summaries(key,ts,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, data=excluded.data",
        (key, time.time(), json.dumps(data, default=_json_default)),
    )


def get_summary(key: str) -> tuple[float, dict] | None:
    row = query_one("SELECT ts,data FROM summaries WHERE key=?", (key,))
    return (row["ts"], json.loads(row["data"])) if row else None


def cache_get(key: str, max_age_sec: float) -> Any:
    row = query_one("SELECT ts,data FROM cache WHERE key=?", (key,))
    if row and time.time() - row["ts"] <= max_age_sec:
        return json.loads(row["data"])
    return None


def cache_set(key: str, data: Any) -> None:
    execute(
        "INSERT INTO cache(key,ts,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts, data=excluded.data",
        (key, time.time(), json.dumps(data, default=_json_default)),
    )


# ---------------------------------------------------------------- alerts
def alert_recently_sent(key: str, cooldown_hours: float) -> bool:
    row = query_one("SELECT ts FROM alert_keys WHERE key=?", (key,))
    return bool(row and time.time() - row["ts"] < cooldown_hours * 3600)


def mark_alert_key(key: str) -> None:
    execute("INSERT INTO alert_keys(key,ts) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts", (key, time.time()))


def insert_alert(a: dict) -> dict:
    cur = execute(
        "INSERT INTO alerts(ts,ticker,kind,level,title,body,score,data) VALUES(?,?,?,?,?,?,?,?)",
        (time.time(), a.get("ticker"), a["kind"], a["level"], a["title"], a.get("body", ""), a.get("score"),
         json.dumps(a.get("data") or {}, default=_json_default)),
    )
    a = {**a, "id": cur.lastrowid, "ts": time.time(), "read": 0}
    return a


def list_alerts(limit: int = 50, ticker: str | None = None) -> list[dict]:
    if ticker:
        rows = query("SELECT * FROM alerts WHERE ticker=? ORDER BY ts DESC LIMIT ?", (ticker, limit))
    else:
        rows = query("SELECT * FROM alerts ORDER BY ts DESC LIMIT ?", (limit,))
    for r in rows:
        r["data"] = json.loads(r["data"] or "{}")
    return rows


def mark_alerts_read() -> None:
    execute("UPDATE alerts SET read=1 WHERE read=0")


# ---------------------------------------------------------------- news
def news_exists(news_id: str) -> bool:
    return bool(query_one("SELECT 1 AS x FROM news WHERE id=?", (news_id,)))


def upsert_news(item: dict) -> bool:
    """Returns True if the item is new."""
    if query_one("SELECT 1 AS x FROM news WHERE id=?", (item["id"],)):
        return False
    execute(
        "INSERT INTO news(id,ts,ticker,source,kind,title,url,sentiment) VALUES(?,?,?,?,?,?,?,?)",
        (item["id"], item["ts"], item.get("ticker"), item.get("source"), item.get("kind", "news"),
         item["title"], item.get("url"), item.get("sentiment", 0.0)),
    )
    return True


def list_news(ticker: str | None = None, limit: int = 40, since_hours: float | None = None) -> list[dict]:
    params: list = []
    where = []
    if ticker:
        where.append("ticker=?")
        params.append(ticker)
    if since_hours:
        where.append("ts>=?")
        params.append(time.time() - since_hours * 3600)
    sql = "SELECT * FROM news" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    return query(sql, params)


def prune(days: int = 30) -> None:
    cutoff = time.time() - days * 86400
    execute("DELETE FROM news WHERE ts<?", (cutoff,))
    execute("DELETE FROM alerts WHERE ts<?", (time.time() - 90 * 86400,))  # alerts kept 90 days
    execute("DELETE FROM runs WHERE ts<?", (cutoff,))


# ---------------------------------------------------------------- push subs / equity / runs
def add_push_sub(sub: dict) -> None:
    execute(
        "INSERT INTO push_subs(endpoint,data) VALUES(?,?) ON CONFLICT(endpoint) DO UPDATE SET data=excluded.data",
        (sub["endpoint"], json.dumps(sub)),
    )


def list_push_subs() -> list[dict]:
    return [json.loads(r["data"]) for r in query("SELECT data FROM push_subs")]


def delete_push_sub(endpoint: str) -> None:
    execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))


def add_equity_point(value: float, cost: float) -> None:
    execute("INSERT OR REPLACE INTO equity(ts,value,cost) VALUES(?,?,?)", (time.time(), value, cost))


def equity_series(days: int = 90) -> list[dict]:
    return query("SELECT ts,value,cost FROM equity WHERE ts>=? ORDER BY ts", (time.time() - days * 86400,))


def log_run(duration: float, status: str, message: str = "") -> None:
    execute("INSERT INTO runs(ts,duration,status,message) VALUES(?,?,?,?)", (time.time(), duration, status, message[:500]))


def last_run() -> dict | None:
    return query_one("SELECT * FROM runs ORDER BY ts DESC LIMIT 1")


def _json_default(o: Any) -> Any:
    try:
        import numpy as np

        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return None if np.isnan(o) else float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    return str(o)
