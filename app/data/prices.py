"""Price data: Yahoo Finance via yfinance (free), with a synthetic demo mode.

Notes
- Tel Aviv (.TA) stocks are quoted by Yahoo in agorot (ILA); we convert to shekels.
- Daily history is cached for an hour; the latest price is refreshed every scan
  from 5-minute bars, so intraday moves show up within minutes.
"""
from __future__ import annotations

import hashlib
import logging
import math
import threading
import time
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from ..config import settings

log = logging.getLogger("radar.prices")

_hist_cache: dict[str, tuple[float, pd.DataFrame]] = {}
_lock = threading.Lock()
HIST_TTL = 3600
COLS = ["Open", "High", "Low", "Close", "Volume"]


def currency_of(ticker: str) -> str:
    return "ILS" if ticker.upper().endswith(".TA") and not ticker.startswith("^") else "USD"


def _is_agorot(ticker: str) -> bool:
    return currency_of(ticker) == "ILS"


# ------------------------------------------------------------------ public API
def get_history(tickers: list[str], period: str = "1y", refresh_latest: bool = True) -> dict[str, pd.DataFrame]:
    """Daily OHLCV per ticker. Last bar is patched with the latest intraday price."""
    tickers = sorted(set(tickers))
    if settings.DEMO_MODE:
        return {t: demo_history(t) for t in tickers}

    now = time.time()
    stale = [t for t in tickers if t not in _hist_cache or now - _hist_cache[t][0] > HIST_TTL]
    if stale:
        fresh = _yf_download(stale, period=period, interval="1d")
        with _lock:
            for t, df in fresh.items():
                _hist_cache[t] = (now, df)

    out = {t: _hist_cache[t][1].copy() for t in tickers if t in _hist_cache}
    if refresh_latest and out:
        latest = _yf_download(list(out), period="2d", interval="5m")
        for t, intraday in latest.items():
            if intraday.empty or t not in out:
                continue
            out[t] = _patch_last_bar(out[t], intraday)
    return out


def get_long_history(ticker: str, years: int = 5) -> pd.DataFrame:
    if settings.DEMO_MODE:
        return demo_history(ticker, days=int(252 * years))
    data = _yf_download([ticker], period=f"{years}y", interval="1d")
    return data.get(ticker, pd.DataFrame(columns=COLS))


def get_fx_usdils() -> float:
    if settings.DEMO_MODE:
        return 3.70
    try:
        data = _yf_download(["ILS=X"], period="5d", interval="1d")
        df = data.get("ILS=X")
        if df is not None and not df.empty:
            return float(df["Close"].dropna().iloc[-1])
    except Exception as exc:  # noqa: BLE001
        log.warning("FX fetch failed: %s", exc)
    return 3.70


def get_fundamentals(ticker: str) -> dict:
    """Key fundamentals for the analyst module (cached by caller, ~daily)."""
    if settings.DEMO_MODE:
        return _demo_fundamentals(ticker)
    try:
        import yfinance as yf

        info = yf.Ticker(ticker).info or {}
    except Exception as exc:  # noqa: BLE001
        log.warning("fundamentals %s failed: %s", ticker, exc)
        return {}
    keys = {
        "shortName": "name", "sector": "sector", "industry": "industry", "marketCap": "market_cap",
        "trailingPE": "pe", "forwardPE": "forward_pe", "pegRatio": "peg", "priceToBook": "pb",
        "profitMargins": "profit_margin", "revenueGrowth": "revenue_growth", "earningsGrowth": "earnings_growth",
        "debtToEquity": "debt_to_equity", "returnOnEquity": "roe", "dividendYield": "dividend_yield",
        "targetMeanPrice": "target_mean", "recommendationKey": "recommendation",
        "numberOfAnalystOpinions": "analysts", "fiftyTwoWeekHigh": "high_52w", "fiftyTwoWeekLow": "low_52w",
        "shortPercentOfFloat": "short_float", "beta": "beta",
    }
    out = {v: info.get(k) for k, v in keys.items() if info.get(k) is not None}
    if _is_agorot(ticker):
        for k in ("target_mean", "high_52w", "low_52w"):
            if out.get(k):
                out[k] = out[k] / 100
    ts = info.get("earningsTimestamp") or info.get("earningsTimestampStart")
    if ts:
        out["next_earnings"] = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    return out


# ------------------------------------------------------------------ yfinance
def _yf_download(tickers: list[str], period: str, interval: str) -> dict[str, pd.DataFrame]:
    try:
        import yfinance as yf
    except ImportError:
        log.error("yfinance is not installed")
        return {}
    try:
        raw = yf.download(
            tickers=tickers, period=period, interval=interval, group_by="ticker",
            auto_adjust=True, progress=False, threads=True, prepost=False,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("yfinance download failed (%s): %s", ",".join(tickers[:5]), exc)
        return {}
    out: dict[str, pd.DataFrame] = {}
    if raw is None or raw.empty:
        return out
    for t in tickers:
        try:
            if isinstance(raw.columns, pd.MultiIndex):
                if t not in raw.columns.get_level_values(0):
                    continue
                df = raw[t].copy()
            else:
                df = raw.copy()
            df = df[[c for c in COLS if c in df.columns]].dropna(subset=["Close"])
            if df.empty:
                continue
            if _is_agorot(t):
                for c in ("Open", "High", "Low", "Close"):
                    df[c] = df[c] / 100.0
            df.index = pd.to_datetime(df.index).tz_localize(None) if df.index.tz is not None else pd.to_datetime(df.index)
            out[t] = df
        except Exception as exc:  # noqa: BLE001
            log.debug("parse %s failed: %s", t, exc)
    return out


def _patch_last_bar(daily: pd.DataFrame, intraday: pd.DataFrame) -> pd.DataFrame:
    last_ts = intraday.index[-1]
    day = pd.Timestamp(last_ts.date())
    today_bars = intraday[intraday.index.date == last_ts.date()]
    bar = {
        "Open": float(today_bars["Open"].iloc[0]),
        "High": float(today_bars["High"].max()),
        "Low": float(today_bars["Low"].min()),
        "Close": float(today_bars["Close"].iloc[-1]),
        "Volume": float(today_bars["Volume"].sum()),
    }
    daily = daily.copy()
    if len(daily) and daily.index[-1].normalize() == day:
        for k, v in bar.items():
            daily.loc[daily.index[-1], k] = v
    elif len(daily) and day > daily.index[-1]:
        daily.loc[day] = bar
    return daily


# ------------------------------------------------------------------ demo data
_DEMO_NAMES = {
    "AAPL": ("Apple", 230, "Technology"), "MSFT": ("Microsoft", 470, "Technology"),
    "NVDA": ("NVIDIA", 175, "Technology"), "AMZN": ("Amazon", 215, "Consumer"),
    "GOOGL": ("Alphabet", 185, "Communication"), "META": ("Meta", 640, "Communication"),
    "TSLA": ("Tesla", 320, "Consumer"), "AMD": ("AMD", 160, "Technology"),
    "PLTR": ("Palantir", 140, "Technology"), "JPM": ("JPMorgan", 260, "Financials"),
    "XOM": ("Exxon Mobil", 112, "Energy"), "LLY": ("Eli Lilly", 820, "Healthcare"),
    "TEVA.TA": ("Teva", 72, "Healthcare"), "NICE.TA": ("NICE", 640, "Technology"),
    "ESLT.TA": ("Elbit Systems", 1400, "Industrials"), "LUMI.TA": ("Bank Leumi", 52, "Financials"),
    "POLI.TA": ("Bank Hapoalim", 58, "Financials"), "SPY": ("S&P 500 ETF", 590, "Index"),
    "QQQ": ("Nasdaq 100 ETF", 510, "Index"), "^VIX": ("VIX", 16, "Index"),
    "^TA125.TA": ("TA-125", 2700, "Index"), "COIN": ("Coinbase", 260, "Financials"),
    "SMCI": ("Super Micro", 45, "Technology"), "AVGO": ("Broadcom", 330, "Technology"),
}

# A few hand-tuned "story" shapes so the demo shows every kind of signal.
_DEMO_SHAPES = {
    "NVDA": "breakout", "PLTR": "walk_up", "TSLA": "reversal_down", "AMD": "squeeze",
    "XOM": "oversold", "TEVA.TA": "breakout", "LUMI.TA": "trend_up", "META": "trend_up",
    "COIN": "oversold", "SMCI": "breakdown", "AVGO": "squeeze", "ESLT.TA": "walk_up",
}


def _seed(t: str) -> int:
    return int(hashlib.md5(t.encode()).hexdigest()[:8], 16)


def demo_history(ticker: str, days: int = 300) -> pd.DataFrame:
    rng = np.random.default_rng(_seed(ticker))
    base = _DEMO_NAMES.get(ticker, (ticker, 50 + _seed(ticker) % 400, "Other"))[1]
    vol = 0.012 + (_seed(ticker) % 15) / 1000
    shape = _DEMO_SHAPES.get(ticker, "random")
    if ticker == "^VIX":
        vol = 0.05
    rets = rng.normal(0.0004, vol, days)
    n = days
    tail = 25
    if shape == "breakout":       # tight range then pop above the upper band on volume
        rets[-tail:-3] = rng.normal(0, vol * 0.25, tail - 3)
        rets[-3:] = [0.012, 0.025, 0.031]
    elif shape == "squeeze":      # very low volatility at the end
        rets[-tail:] = rng.normal(0.0002, vol * 0.2, tail)
    elif shape == "oversold":     # sharp sell-off, first bounce back inside the band
        rets[-7:-1] = rng.normal(-0.03, vol * 0.2, 6)
        rets[-1] = 0.034
    elif shape == "reversal_down":  # rally above the upper band then a hard close back inside
        rets[-8:-1] = rng.normal(0.021, vol * 0.2, 7)
        rets[-1] = -0.035
    elif shape == "walk_up":
        rets[-15:] = rng.normal(0.011, vol * 0.3, 15)
    elif shape == "trend_up":
        rets[-80:] = rng.normal(0.0025, vol * 0.7, 80)
    elif shape == "breakdown":
        rets[-6:] = [-0.03, -0.02, -0.035, -0.015, -0.028, -0.02]

    closes = base / math.exp(rets.sum()) * np.exp(np.cumsum(rets))
    # live wiggle so consecutive demo scans differ slightly
    wiggle = 1 + 0.004 * math.sin(time.time() / 420 + _seed(ticker) % 7)
    closes[-1] *= wiggle
    opens = np.r_[closes[0], closes[:-1]] * (1 + rng.normal(0, vol * 0.3, n))
    highs = np.maximum(opens, closes) * (1 + np.abs(rng.normal(0, vol * 0.5, n)))
    lows = np.minimum(opens, closes) * (1 - np.abs(rng.normal(0, vol * 0.5, n)))
    volume = rng.lognormal(15, 0.35, n)
    if shape in ("breakout", "breakdown"):
        volume[-3:] *= 2.6
    if shape == "oversold":
        volume[-1] *= 2.1
    end = pd.Timestamp(datetime.now().date())
    idx = pd.bdate_range(end=end, periods=n)
    return pd.DataFrame({"Open": opens, "High": highs, "Low": lows, "Close": closes, "Volume": volume}, index=idx)


def _demo_fundamentals(ticker: str) -> dict:
    name, price, sector = _DEMO_NAMES.get(ticker, (ticker, 100, "Other"))
    rng = np.random.default_rng(_seed(ticker) + 1)
    rec = ["strong_buy", "buy", "hold", "underperform"][_seed(ticker) % 4]
    return {
        "name": name, "sector": sector, "market_cap": float(rng.uniform(5e9, 3e12)),
        "pe": round(float(rng.uniform(9, 60)), 1), "forward_pe": round(float(rng.uniform(8, 45)), 1),
        "revenue_growth": round(float(rng.uniform(-0.05, 0.6)), 3), "profit_margin": round(float(rng.uniform(0.03, 0.5)), 3),
        "target_mean": round(price * float(rng.uniform(0.95, 1.3)), 2), "recommendation": rec,
        "analysts": int(rng.integers(5, 55)), "beta": round(float(rng.uniform(0.6, 2.2)), 2),
        "next_earnings": (datetime.now() + timedelta(days=int(rng.integers(3, 70)))).strftime("%Y-%m-%d"),
    }


def demo_name(ticker: str) -> str:
    return _DEMO_NAMES.get(ticker, (ticker,))[0]
