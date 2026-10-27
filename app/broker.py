"""Broker skill: Alpaca paper trading. Orders are only sent after an explicit click + confirm in the UI."""
from __future__ import annotations

import requests

from .config import settings


def enabled() -> bool:
    return bool(settings.ALPACA_API_KEY and settings.ALPACA_SECRET_KEY)


def _h() -> dict:
    return {"APCA-API-KEY-ID": settings.ALPACA_API_KEY, "APCA-API-SECRET-KEY": settings.ALPACA_SECRET_KEY}


def account() -> dict:
    r = requests.get(f"{settings.ALPACA_BASE_URL}/v2/account", headers=_h(), timeout=15)
    r.raise_for_status()
    a = r.json()
    return {k: a.get(k) for k in ("status", "equity", "cash", "buying_power", "portfolio_value", "currency")} | {
        "paper": "paper" in settings.ALPACA_BASE_URL}


def positions() -> list[dict]:
    r = requests.get(f"{settings.ALPACA_BASE_URL}/v2/positions", headers=_h(), timeout=15)
    r.raise_for_status()
    return [{k: p.get(k) for k in ("symbol", "qty", "avg_entry_price", "market_value", "unrealized_plpc")} for p in r.json()]


def bracket_order(symbol: str, qty: int, side: str, stop: float | None, target: float | None, limit: float | None = None) -> dict:
    if symbol.endswith(".TA"):
        raise ValueError("Alpaca supports US stocks only")
    if qty <= 0:
        raise ValueError("qty must be positive")
    body: dict = {"symbol": symbol, "qty": str(int(qty)), "side": side, "time_in_force": "day",
                  "type": "limit" if limit else "market"}
    if limit:
        body["limit_price"] = f"{limit:.2f}"
    if side == "buy" and stop and target:
        body["order_class"] = "bracket"
        body["take_profit"] = {"limit_price": f"{target:.2f}"}
        body["stop_loss"] = {"stop_price": f"{stop:.2f}"}
        body["time_in_force"] = "gtc"
    r = requests.post(f"{settings.ALPACA_BASE_URL}/v2/orders", headers=_h(), json=body, timeout=15)
    if r.status_code >= 400:
        raise RuntimeError(r.text[:300])
    o = r.json()
    return {"id": o.get("id"), "status": o.get("status"), "symbol": o.get("symbol"), "qty": o.get("qty"), "side": o.get("side")}
