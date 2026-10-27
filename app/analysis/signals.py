"""Rule-based signal engine (scanner / entry / exit skills).

Each signal: {code, cat, dir (+1 bull, -1 bear, 0 neutral), strength 0..1, title, desc}
Categories: bollinger, momentum, trend, volume, exit, risk
"""
from __future__ import annotations

import pandas as pd

WEIGHTS = {"bollinger": 1.2, "momentum": 1.0, "trend": 1.1, "volume": 0.7, "exit": 1.6, "risk": 0.8}


def _sig(code, cat, direction, strength, title, desc) -> dict:
    return {"code": code, "cat": cat, "dir": direction, "strength": round(float(max(0.0, min(1.0, strength))), 2),
            "title": title, "desc": desc}


def evaluate(d: pd.DataFrame, holding: dict | None = None) -> list[dict]:
    """d = enriched dataframe (see indicators.enrich)."""
    if len(d) < 30:
        return []
    s: list[dict] = []
    L, P = d.iloc[-1], d.iloc[-2]
    c, pc = float(L["Close"]), float(P["Close"])
    up, lo, mid = L["BB_UP"], L["BB_LO"], L["BB_MID"]
    rsi_v, rsi_p = L["RSI"], P["RSI"]
    volr = L["VOL_RATIO"] if pd.notna(L["VOL_RATIO"]) else 1.0
    bw_pctl = L["BB_BW_PCTL"]

    # ------------------------------------------------ Bollinger Bands
    recent_pctl_min = d["BB_BW_PCTL"].iloc[-6:-1].min()
    if pd.notna(bw_pctl) and bw_pctl <= 10:
        lean = 1 if c > mid else -1
        s.append(_sig("bb_squeeze", "bollinger", 0, 0.6,
                      "סחיטת בולינגר",
                      f"רוחב הרצועות בשפל של {bw_pctl:.0f}% מחצי השנה האחרונה – צפויה תנועה חדה. "
                      f"המחיר {'מעל' if lean > 0 else 'מתחת'} לממוצע האמצעי."))
    if c > up and pd.notna(recent_pctl_min) and recent_pctl_min <= 15:
        s.append(_sig("bb_squeeze_break_up", "bollinger", 1, 0.9, "פריצה מסחיטה כלפי מעלה",
                      f"המחיר פרץ את הרצועה העליונה מיד אחרי סחיטה, נפח ×{volr:.1f}."))
    elif c < lo and pd.notna(recent_pctl_min) and recent_pctl_min <= 15:
        s.append(_sig("bb_squeeze_break_down", "bollinger", -1, 0.9, "שבירה מסחיטה כלפי מטה",
                      f"המחיר שבר את הרצועה התחתונה אחרי סחיטה, נפח ×{volr:.1f}."))
    elif c > up and volr >= 1.5:
        s.append(_sig("bb_breakout", "bollinger", 1, 0.7, "פריצת רצועה עליונה בנפח",
                      f"סגירה מעל הרצועה העליונה עם נפח ×{volr:.1f} מהממוצע – מומנטום חזק."))

    closes_above = (d["Close"].iloc[-5:] > d["BB_UP"].iloc[-5:]).sum()
    if closes_above >= 3:
        s.append(_sig("bb_walk_up", "bollinger", 1, 0.45, "הליכה על הרצועה העליונה",
                      f"{closes_above} מתוך 5 הסגירות האחרונות מעל הרצועה העליונה – מגמה חזקה אך מתוחה."))

    if pc < P["BB_LO"] and c > lo:
        s.append(_sig("bb_reentry_up", "bollinger", 1, 0.75, "חזרה לתוך הרצועות מלמטה",
                      "אתמול נסגר מתחת לרצועה התחתונה והיום חזר פנימה – איתות היפוך קלאסי לקנייה."))
    if pc > P["BB_UP"] and c < up:
        s.append(_sig("bb_reentry_down", "bollinger", -1, 0.7, "חזרה לתוך הרצועות מלמעלה",
                      "אתמול מעל הרצועה העליונה והיום חזר פנימה – סימן להתשת קונים, שקול מימוש חלקי."))
    if c < lo and pd.notna(rsi_v) and rsi_v < 30:
        s.append(_sig("bb_oversold", "bollinger", 1, 0.6, "מכירת יתר מתחת לרצועה",
                      f"מחיר מתחת לרצועה התחתונה ו-RSI {rsi_v:.0f} – פוטנציאל לתיקון כלפי הממוצע."))
    if c > up and pd.notna(rsi_v) and rsi_v > 72:
        s.append(_sig("bb_overbought", "bollinger", -1, 0.5, "קניית יתר מעל הרצועה",
                      f"מחיר מעל הרצועה העליונה ו-RSI {rsi_v:.0f} – סיכון לתיקון."))

    # ------------------------------------------------ Momentum
    if pd.notna(rsi_p) and pd.notna(rsi_v):
        if rsi_p < 30 <= rsi_v:
            s.append(_sig("rsi_up30", "momentum", 1, 0.6, "RSI חוצה 30 כלפי מעלה", "יציאה מאזור מכירת יתר."))
        if rsi_p > 70 >= rsi_v:
            s.append(_sig("rsi_down70", "momentum", -1, 0.55, "RSI חוצה 70 כלפי מטה", "יציאה מאזור קניית יתר – המומנטום נחלש."))
    if P["MACD"] < P["MACD_SIG"] and L["MACD"] > L["MACD_SIG"]:
        s.append(_sig("macd_up", "momentum", 1, 0.5 + (0.15 if L["MACD"] < 0 else 0), "חציית MACD חיובית",
                      "קו ה-MACD חצה את קו האיתות כלפי מעלה."))
    if P["MACD"] > P["MACD_SIG"] and L["MACD"] < L["MACD_SIG"]:
        s.append(_sig("macd_down", "momentum", -1, 0.5 + (0.15 if L["MACD"] > 0 else 0), "חציית MACD שלילית",
                      "קו ה-MACD חצה את קו האיתות כלפי מטה."))

    # ------------------------------------------------ Trend
    if pd.notna(L["SMA200"]) and pd.notna(L["SMA50"]):
        win = d[["SMA50", "SMA200"]].iloc[-4:]
        diff = (win["SMA50"] - win["SMA200"]).dropna()
        if len(diff) >= 2 and diff.iloc[0] < 0 < diff.iloc[-1]:
            s.append(_sig("golden_cross", "trend", 1, 0.8, "צלב זהב (50/200)", "הממוצע ה-50 חצה מעל ה-200 – שינוי מגמה ארוך טווח לחיובי."))
        if len(diff) >= 2 and diff.iloc[0] > 0 > diff.iloc[-1]:
            s.append(_sig("death_cross", "trend", -1, 0.8, "צלב מוות (50/200)", "הממוצע ה-50 חצה מתחת ל-200 – אזהרת מגמה ארוכת טווח."))
        if c > L["SMA50"] > L["SMA200"]:
            s.append(_sig("uptrend", "trend", 1, 0.35, "מגמת עלייה", "מחיר מעל ממוצע 50 שמעל ממוצע 200."))
        elif c < L["SMA50"] < L["SMA200"]:
            s.append(_sig("downtrend", "trend", -1, 0.35, "מגמת ירידה", "מחיר מתחת לממוצע 50 שמתחת ל-200."))
    if pd.notna(L["SMA50"]) and pc > P["SMA50"] and c < L["SMA50"]:
        s.append(_sig("lost_sma50", "trend", -1, 0.5, "שבירת ממוצע 50", "המחיר נסגר מתחת לממוצע הנע 50 יום."))
    if pd.notna(L["SMA50"]) and pc < P["SMA50"] and c > L["SMA50"]:
        s.append(_sig("reclaim_sma50", "trend", 1, 0.45, "חזרה מעל ממוצע 50", "המחיר נסגר מחדש מעל הממוצע הנע 50 יום."))
    hi52 = d["High"].tail(252).max()
    if c >= hi52 * 0.995:
        s.append(_sig("new_high", "trend", 1, 0.5, "שיא 52 שבועות", "המחיר בשיא שנתי – אין התנגדות מעל."))

    # ------------------------------------------------ Volume
    if volr >= 2.0:
        direction = 1 if c > pc else -1
        s.append(_sig("vol_spike", "volume", direction, min(1.0, 0.4 + (volr - 2) * 0.15),
                      f"נפח חריג ×{volr:.1f}",
                      f"נפח המסחר גבוה פי {volr:.1f} מהממוצע, ביום {'עולה' if direction > 0 else 'יורד'} – כסף גדול זז."))

    # ------------------------------------------------ Exit / risk for holdings
    if holding:
        s.extend(exit_signals(d, holding))
    return s


def exit_signals(d: pd.DataFrame, h: dict) -> list[dict]:
    out: list[dict] = []
    c = float(d["Close"].iloc[-1])
    stop, target, trail = h.get("stop_loss"), h.get("take_profit"), h.get("trailing_pct")
    avg = float(h["avg_price"])
    pnl = (c / avg - 1) * 100
    if stop and c <= stop:
        out.append(_sig("stop_hit", "exit", -1, 1.0, "🛑 הגעה לסטופ לוס",
                        f"המחיר {c:.2f} ירד אל/מתחת לסטופ {stop:.2f}. לפי התוכנית – יציאה."))
    elif stop and c <= stop * 1.025:
        out.append(_sig("near_stop", "risk", -1, 0.7, "מתקרב לסטופ",
                        f"המחיר במרחק {((c / stop) - 1) * 100:.1f}% בלבד מהסטופ {stop:.2f}."))
    if target and c >= target:
        out.append(_sig("target_hit", "exit", -1, 0.85, "🎯 הגעה ליעד רווח",
                        f"המחיר {c:.2f} הגיע ליעד {target:.2f} (רווח {pnl:.1f}%). שקול מימוש או העלאת סטופ."))
    elif target and c >= avg + (target - avg) * 0.9 and target > avg:
        out.append(_sig("near_target", "exit", -1, 0.4, "קרוב ליעד",
                        f"90% מהדרך ליעד {target:.2f} – שקול מימוש חלקי."))
    if trail:
        opened = pd.Timestamp(h.get("opened_at") or d.index[-60])
        since = d[d.index >= opened]
        peak = float(since["Close"].max()) if len(since) else c
        trail_level = peak * (1 - trail / 100)
        if c <= trail_level and peak > avg:
            out.append(_sig("trailing_hit", "exit", -1, 0.9, "סטופ נגרר הופעל",
                            f"ירידה של {trail:.0f}% מהשיא {peak:.2f} מאז הכניסה – נעילת רווח."))
    return out


def technical_score(signals: list[dict], ind: dict) -> float:
    """-100..100. Signals plus a small baseline from trend position."""
    raw = 0.0
    for s in signals:
        raw += s["dir"] * s["strength"] * WEIGHTS.get(s["cat"], 1.0)
    # baseline context (keeps score informative even without fresh signals)
    base = 0.0
    if ind.get("sma200") and ind["price"] > ind["sma200"]:
        base += 0.25
    elif ind.get("sma200"):
        base -= 0.25
    if ind.get("rsi") is not None:
        base += (ind["rsi"] - 50) / 200  # +-0.25
    if ind.get("macd_hist") is not None and ind.get("atr"):
        base += max(-0.2, min(0.2, ind["macd_hist"] / ind["atr"]))
    total = raw + base
    # squash to -100..100
    import math
    return round(100 * math.tanh(total / 2.2), 1)
