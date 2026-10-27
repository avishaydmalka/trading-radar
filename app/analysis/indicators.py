"""Technical indicators: Bollinger Bands, RSI, MACD, moving averages, ATR, volume."""
from __future__ import annotations

import numpy as np
import pandas as pd


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100.0).where(loss.notna(), np.nan)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev = df["Close"].shift(1)
    tr = pd.concat([df["High"] - df["Low"], (df["High"] - prev).abs(), (df["Low"] - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def enrich(df: pd.DataFrame, bb_period: int = 20, bb_std: float = 2.0) -> pd.DataFrame:
    """Return a copy of df with all indicator columns added."""
    d = df.copy()
    c = d["Close"]
    d["SMA20"] = c.rolling(20).mean()
    d["SMA50"] = c.rolling(50).mean()
    d["SMA200"] = c.rolling(200).mean()
    d["EMA12"] = c.ewm(span=12, adjust=False).mean()
    d["EMA26"] = c.ewm(span=26, adjust=False).mean()
    d["MACD"] = d["EMA12"] - d["EMA26"]
    d["MACD_SIG"] = d["MACD"].ewm(span=9, adjust=False).mean()
    d["MACD_HIST"] = d["MACD"] - d["MACD_SIG"]

    mid = c.rolling(bb_period).mean()
    sd = c.rolling(bb_period).std(ddof=0)
    d["BB_MID"] = mid
    d["BB_UP"] = mid + bb_std * sd
    d["BB_LO"] = mid - bb_std * sd
    width = d["BB_UP"] - d["BB_LO"]
    d["BB_PCTB"] = (c - d["BB_LO"]) / width.replace(0, np.nan)
    d["BB_BW"] = width / mid
    # where today's bandwidth ranks within the last ~6 months (0 = tightest)
    d["BB_BW_PCTL"] = d["BB_BW"].rolling(126, min_periods=40).rank(pct=True) * 100

    d["RSI"] = rsi(c)
    d["ATR"] = atr(d)
    d["VOL_AVG20"] = d["Volume"].rolling(20).mean()
    d["VOL_RATIO"] = d["Volume"] / d["VOL_AVG20"]
    return d


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) or np.isinf(f) else f


def latest(d: pd.DataFrame) -> dict:
    """Flat dict of the latest indicator values plus a few derived stats."""
    last = d.iloc[-1]
    prev = d.iloc[-2] if len(d) > 1 else last
    close = float(last["Close"])
    year = d.tail(252)
    out = {
        "price": close,
        "prev_close": float(prev["Close"]),
        "change_pct": (close / float(prev["Close"]) - 1) * 100 if prev["Close"] else 0.0,
        "change_5d_pct": (close / float(d["Close"].iloc[-6]) - 1) * 100 if len(d) > 6 else None,
        "change_1m_pct": (close / float(d["Close"].iloc[-22]) - 1) * 100 if len(d) > 22 else None,
        "high_52w": float(year["High"].max()),
        "low_52w": float(year["Low"].min()),
        "volume": _num(last["Volume"]),
    }
    for col in ["SMA20", "SMA50", "SMA200", "MACD", "MACD_SIG", "MACD_HIST", "BB_MID", "BB_UP", "BB_LO",
                "BB_PCTB", "BB_BW", "BB_BW_PCTL", "RSI", "ATR", "VOL_RATIO"]:
        out[col.lower()] = _num(last[col])
    out["dist_52w_high_pct"] = (close / out["high_52w"] - 1) * 100 if out["high_52w"] else None
    return out


def chart_series(d: pd.DataFrame, bars: int = 160) -> dict:
    """Compact series for the front-end chart."""
    t = d.tail(bars)

    def col(name: str) -> list:
        return [None if pd.isna(v) else round(float(v), 4) for v in t[name]]

    return {
        "t": [ix.strftime("%Y-%m-%d") for ix in t.index],
        "o": col("Open"), "h": col("High"), "l": col("Low"), "c": col("Close"), "v": col("Volume"),
        "bb_up": col("BB_UP"), "bb_mid": col("BB_MID"), "bb_lo": col("BB_LO"),
        "sma50": col("SMA50"), "sma200": col("SMA200"), "rsi": col("RSI"),
        "macd": col("MACD"), "macd_sig": col("MACD_SIG"),
    }
