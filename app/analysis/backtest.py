"""Time-machine skill: simple long-only daily backtests of the dashboard's strategies."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .indicators import enrich

STRATEGIES = {
    "bb_reversion": "בולינגר – חזרה לממוצע (קנייה בחזרה מעל התחתונה, מכירה בממוצע/עליונה)",
    "bb_breakout": "בולינגר – פריצה מסחיטה (קנייה בפריצה מעל העליונה, מכירה מתחת לאמצע)",
    "sma_cross": "צלב ממוצעים 50/200",
    "rsi_reversion": "RSI – קנייה מתחת ל-30, מכירה מעל 70",
}


def run(df: pd.DataFrame, strategy: str, commission_pct: float = 0.1, stop_atr: float = 2.5) -> dict:
    if strategy not in STRATEGIES:
        raise ValueError("unknown strategy")
    d = enrich(df).dropna(subset=["BB_MID", "RSI", "ATR"])
    if strategy == "sma_cross":
        d = d.dropna(subset=["SMA200"])
    if len(d) < 60:
        raise ValueError("not enough history")

    close = d["Close"].values
    cash, shares, entry_px, stop_px = 1.0, 0.0, 0.0, 0.0
    equity, trades = [], []
    fee = commission_pct / 100
    entry_date = None

    for i in range(1, len(d)):
        row, prev = d.iloc[i], d.iloc[i - 1]
        px = float(row["Close"])
        buy = sell = False
        reason = ""
        if strategy == "bb_reversion":
            buy = prev["Close"] < prev["BB_LO"] and px > row["BB_LO"]
            sell = px >= row["BB_MID"] + 0.5 * (row["BB_UP"] - row["BB_MID"])
        elif strategy == "bb_breakout":
            squeezed = d["BB_BW_PCTL"].iloc[max(0, i - 5):i].min() <= 20
            buy = px > row["BB_UP"] and squeezed
            sell = px < row["BB_MID"]
        elif strategy == "sma_cross":
            buy = prev["SMA50"] <= prev["SMA200"] and row["SMA50"] > row["SMA200"]
            sell = prev["SMA50"] >= prev["SMA200"] and row["SMA50"] < row["SMA200"]
        elif strategy == "rsi_reversion":
            buy = prev["RSI"] < 30 <= row["RSI"]
            sell = row["RSI"] > 70

        if shares > 0 and px <= stop_px:
            sell, reason = True, "stop"
        if shares > 0 and sell:
            cash = shares * px * (1 - fee)
            trades.append({"entry_date": entry_date, "exit_date": d.index[i].strftime("%Y-%m-%d"),
                           "entry": round(entry_px, 4), "exit": round(px, 4),
                           "ret_pct": round((px * (1 - fee) / (entry_px * (1 + fee)) - 1) * 100, 2),
                           "reason": reason or "signal"})
            shares = 0.0
        elif shares == 0 and buy:
            shares = cash * (1 - fee) / px
            cash = 0.0
            entry_px = px
            stop_px = px - stop_atr * float(row["ATR"])
            entry_date = d.index[i].strftime("%Y-%m-%d")
        equity.append(cash + shares * px)

    if shares > 0:
        trades.append({"entry_date": entry_date, "exit_date": "פתוחה", "entry": round(entry_px, 4),
                       "exit": round(float(close[-1]), 4), "ret_pct": round((close[-1] / entry_px - 1) * 100, 2),
                       "reason": "open"})

    eq = np.array(equity)
    bh = close[1:] / close[1]
    years = len(eq) / 252
    rets = np.diff(eq) / eq[:-1]
    dd = eq / np.maximum.accumulate(eq) - 1
    bh_dd = bh / np.maximum.accumulate(bh) - 1
    closed = [t for t in trades if t["reason"] != "open"]
    wins = [t for t in closed if t["ret_pct"] > 0]
    gross_win = sum(t["ret_pct"] for t in wins)
    gross_loss = -sum(t["ret_pct"] for t in closed if t["ret_pct"] <= 0)
    step = max(1, len(eq) // 250)
    return {
        "strategy": strategy, "label": STRATEGIES[strategy],
        "stats": {
            "total_return_pct": round((eq[-1] - 1) * 100, 2),
            "buy_hold_pct": round((bh[-1] - 1) * 100, 2),
            "cagr_pct": round((eq[-1] ** (1 / years) - 1) * 100, 2) if years > 0 and eq[-1] > 0 else None,
            "max_dd_pct": round(dd.min() * 100, 2),
            "buy_hold_max_dd_pct": round(bh_dd.min() * 100, 2),
            "sharpe": round(float(rets.mean() / rets.std() * math.sqrt(252)), 2) if rets.std() > 0 else None,
            "trades": len(closed),
            "win_rate_pct": round(len(wins) / len(closed) * 100, 1) if closed else None,
            "avg_trade_pct": round(sum(t["ret_pct"] for t in closed) / len(closed), 2) if closed else None,
            "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
            "years": round(years, 1),
        },
        "curve": {
            "t": [ix.strftime("%Y-%m-%d") for ix in d.index[1:][::step]],
            "strategy": [round(float(v), 4) for v in eq[::step]],
            "buy_hold": [round(float(v), 4) for v in bh[::step]],
        },
        "trades": trades[-30:],
    }
