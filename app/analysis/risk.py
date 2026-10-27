"""Risk & budget skills: portfolio metrics, limit checks and position sizing."""
from __future__ import annotations

import math

from ..data.prices import currency_of


def to_base(amount: float, ccy: str, base: str, usdils: float) -> float:
    if ccy == base:
        return amount
    if ccy == "ILS" and base == "USD":
        return amount / usdils
    if ccy == "USD" and base == "ILS":
        return amount * usdils
    return amount


def portfolio_metrics(holdings: list[dict], snaps: dict, risk: dict, base: str, usdils: float) -> dict:
    rows, value, cost, day_pnl, risk_to_stop = [], 0.0, 0.0, 0.0, 0.0
    for h in holdings:
        s = snaps.get(h["ticker"]) or {}
        ind = s.get("ind") or {}
        price = ind.get("price")
        ccy = currency_of(h["ticker"])
        if price is None:
            price = h["avg_price"]
        mv = to_base(price * h["shares"], ccy, base, usdils)
        cb = to_base(h["avg_price"] * h["shares"], ccy, base, usdils)
        prev = ind.get("prev_close") or price
        dp = to_base((price - prev) * h["shares"], ccy, base, usdils)
        stop = h.get("stop_loss") or h["avg_price"] * (1 - risk["default_stop_pct"] / 100)
        rts = to_base(max(0.0, price - stop) * h["shares"], ccy, base, usdils)
        value += mv
        cost += cb
        day_pnl += dp
        risk_to_stop += rts
        rows.append({"id": h["id"], "ticker": h["ticker"], "basket": h["basket"], "value": mv, "cost": cb,
                     "day_pnl": dp, "pnl": mv - cb, "pnl_pct": (mv / cb - 1) * 100 if cb else 0.0,
                     "risk_to_stop": rts, "currency": ccy, "price": price})
    cash = float(risk.get("cash", 0))
    total = value + cash
    baskets: dict[str, dict] = {}
    for r in rows:
        r["weight"] = r["value"] / total * 100 if total else 0
        b = baskets.setdefault(r["basket"], {"basket": r["basket"], "value": 0.0, "cost": 0.0, "day_pnl": 0.0, "tickers": []})
        b["value"] += r["value"]
        b["cost"] += r["cost"]
        b["day_pnl"] += r["day_pnl"]
        b["tickers"].append(r["ticker"])
    for b in baskets.values():
        b["weight"] = b["value"] / total * 100 if total else 0
        b["pnl_pct"] = (b["value"] / b["cost"] - 1) * 100 if b["cost"] else 0
        b["day_pct"] = b["day_pnl"] / (b["value"] - b["day_pnl"]) * 100 if b["value"] - b["day_pnl"] else 0

    warnings = []
    for r in rows:
        if r["weight"] > risk["max_position_pct"]:
            warnings.append({"ticker": r["ticker"], "text": f"{r['ticker']} מהווה {r['weight']:.1f}% מהתיק (מגבלה {risk['max_position_pct']:.0f}%)"})
    for b in baskets.values():
        if b["weight"] > risk["max_basket_pct"]:
            warnings.append({"ticker": None, "text": f"הסל '{b['basket']}' מהווה {b['weight']:.1f}% מהתיק (מגבלה {risk['max_basket_pct']:.0f}%)"})
    for h in holdings:
        if not h.get("stop_loss"):
            warnings.append({"ticker": h["ticker"], "text": f"ל-{h['ticker']} אין סטופ לוס מוגדר"})

    prev_value = value - day_pnl
    return {
        "base": base, "usdils": usdils, "value": value, "cash": cash, "total": total, "cost": cost,
        "pnl": value - cost, "total_pnl_pct": (value / cost - 1) * 100 if cost else 0,
        "day_pnl": day_pnl, "day_pnl_pct": day_pnl / prev_value * 100 if prev_value else 0,
        "risk_to_stop": risk_to_stop, "risk_to_stop_pct": risk_to_stop / total * 100 if total else 0,
        "rows": rows, "baskets": sorted(baskets.values(), key=lambda b: -b["value"]), "warnings": warnings,
    }


def position_size(ind: dict, risk: dict, total_value: float, cash: float, ccy: str, base: str, usdils: float) -> dict:
    """Budget skill: how many shares to buy so a stop-out costs at most risk_per_trade_pct of the portfolio."""
    entry = ind["price"]
    atr_v = ind.get("atr") or entry * 0.02
    stop = entry - risk["atr_stop_mult"] * atr_v
    # don't place the stop above the lower Bollinger band minus a little room when it is close
    if ind.get("bb_lo") and entry > ind["bb_lo"] > stop:
        stop = min(stop, ind["bb_lo"] * 0.99)
    stop = max(stop, entry * 0.75)
    per_share_risk = entry - stop
    target = entry + risk["reward_risk"] * per_share_risk
    risk_budget = total_value * risk["risk_per_trade_pct"] / 100          # in base ccy
    max_pos = total_value * risk["max_position_pct"] / 100
    entry_base = to_base(entry, ccy, base, usdils)
    risk_base = to_base(per_share_risk, ccy, base, usdils)
    shares_risk = risk_budget / risk_base if risk_base > 0 else 0
    shares_cap = max_pos / entry_base if entry_base else 0
    shares_cash = cash / entry_base if entry_base and cash > 0 else 0
    shares = max(0, math.floor(min(shares_risk, shares_cap, shares_cash if cash > 0 else shares_cap)))
    limited_by = min((("risk", shares_risk), ("max_position", shares_cap), ("cash", shares_cash if cash > 0 else 1e18)),
                     key=lambda x: x[1])[0]
    return {
        "entry": round(entry, 4), "stop": round(stop, 4), "target": round(target, 4),
        "shares": shares, "cost": round(shares * entry_base, 2), "risk_amount": round(shares * risk_base, 2),
        "rr": risk["reward_risk"], "stop_pct": round((stop / entry - 1) * 100, 2),
        "target_pct": round((target / entry - 1) * 100, 2), "limited_by": limited_by,
    }


def check_trade(sizing: dict, risk: dict, total_value: float) -> list[str]:
    """Risk skill: validate a proposed trade against the limits."""
    issues = []
    if sizing["shares"] <= 0:
        issues.append("אין תקציב/מזומן לפוזיציה במסגרת המגבלות")
    if sizing["risk_amount"] > total_value * risk["risk_per_trade_pct"] / 100 * 1.01:
        issues.append("הסיכון לעסקה חורג מהמגבלה")
    if abs(sizing["stop_pct"]) > 15:
        issues.append("הסטופ רחוק מ-15% – תנודתיות גבוהה")
    return issues
