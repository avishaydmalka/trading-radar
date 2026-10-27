"""Free LLM layer (analyst skill): Gemini free tier → Groq → OpenRouter free → Ollama.

Every call returns structured JSON. If no provider is configured or all fail,
a deterministic rule-based analysis is produced instead, so the dashboard and
alerts keep working with zero keys.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time

import requests

from ..config import settings

log = logging.getLogger("radar.llm")
_lock = threading.Lock()
_cooldown: dict[str, float] = {}   # provider -> unix time until which it is skipped
_last_call: dict[str, float] = {}

# Request budget for this process (None = unlimited). The cloud runner sets it per user so a
# shared free-tier key is split fairly and never pushed past its free quota.
budget: int | None = None
calls = 0  # requests sent since the last reset()
last_errors: dict[str, str] = {}  # provider -> last failure, shown on the dashboard
last_ok: str | None = None        # provider:model of the last successful answer


def reset(new_budget: int | None = None) -> None:
    """Called when the runner switches to another user's keys."""
    global budget, calls, last_ok
    budget, calls, last_ok = new_budget, 0, None
    _cooldown.clear()
    last_errors.clear()


def has_budget() -> bool:
    return budget is None or budget > 0
MIN_GAP_SEC = {"gemini": 5.0, "groq": 2.5, "openrouter": 4.0, "ollama": 0.0}

SYSTEM_PROMPT = (
    "אתה אנליסט שוק הון זהיר ומנוסה. אתה מקבל נתונים טכניים, חדשות, סנטימנט ונתונים פונדמנטליים, "
    "ומחזיר הערכה תמציתית בעברית. אל תמציא נתונים שלא קיבלת. ציין סיכונים. "
    "החזר JSON תקין בלבד, בלי טקסט נוסף ובלי ```."
)

STOCK_SCHEMA = """{
 "action": "BUY|ADD|HOLD|WATCH|TRIM|SELL",
 "confidence": 0-100,
 "headline": "משפט אחד חד",
 "summary": "2-3 משפטים",
 "bull": ["נקודה חיובית", "..."],
 "bear": ["סיכון", "..."],
 "entry": מספר או null,
 "stop": מספר או null,
 "target": מספר או null,
 "horizon": "ימים|שבועות|חודשים"
}"""

BRIEF_SCHEMA = """{
 "mood": -100..100,
 "title": "כותרת קצרה למצב השוק",
 "summary": "3-4 משפטים על השוק והתיק",
 "focus": ["מניה/נושא לתשומת לב", "..."],
 "risks": ["סיכון", "..."],
 "actions": ["פעולה מומלצת כללית", "..."]
}"""


# ------------------------------------------------------------------ providers
# Fallback chain inside Gemini: when a model is overloaded (503) or out of quota (429, quotas are per
# model), the next one is tried. Lite has its own, larger free quota.
# gemini-3.5-flash is deprecated but still forwarded by Google to a newer Flash, so it stays as a fallback
GEMINI_FALLBACKS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-flash-lite-latest"]
# Preferred Groq/OpenRouter models, newest first. If the configured model has been retired (404),
# the first one the account can actually use is picked automatically.
PREFERRED_MODELS = {
    "groq": ["openai/gpt-oss-120b", "meta-llama/llama-4-maverick-17b-128e-instruct", "llama-3.3-70b-versatile",
             "meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"],
}
_SKIP_MODEL = re.compile(r"whisper|guard|tts|orpheus|playai|distil|embed|vision|compound|prompt", re.I)
_model_override: dict[str, str] = {}


def _count_request() -> None:
    """Every HTTP request counts toward the provider quota and the user's budget."""
    global calls, budget
    calls += 1
    if budget is not None:
        budget -= 1


def _err_message(r: requests.Response) -> str:
    try:
        e = r.json().get("error")
        if isinstance(e, dict):
            return str(e.get("message") or e)[:160]
        return str(e or r.text)[:160]
    except ValueError:
        return r.text[:160]


_gemini_discovered: list[str] | None = None


def _newest_gemini_flash() -> list[str]:
    """Ask Google which models this key can use and return the newest stable Flash models first
    (e.g. gemini-3.6-flash before gemini-3.5-flash). Cached for the run."""
    global _gemini_discovered
    if _gemini_discovered is not None:
        return _gemini_discovered
    _gemini_discovered = []
    try:
        r = requests.get("https://generativelanguage.googleapis.com/v1beta/models", params={"pageSize": 200},
                         headers={"x-goog-api-key": settings.GEMINI_API_KEY}, timeout=20)
        if r.ok:
            found = []
            for m in r.json().get("models", []):
                name = m.get("name", "").removeprefix("models/")
                hit = re.fullmatch(r"gemini-(\d+(?:\.\d+)?)-flash", name)  # stable Flash only (no lite/preview)
                if hit and "generateContent" in m.get("supportedGenerationMethods", ["generateContent"]):
                    found.append((float(hit.group(1)), name))
            _gemini_discovered = [n for _, n in sorted(found, reverse=True)[:2]]
    except Exception:  # noqa: BLE001
        pass
    return _gemini_discovered


def _call_gemini(prompt: str) -> tuple[str, str]:
    configured = [m.strip() for m in settings.GEMINI_MODEL.split(",") if m.strip()]
    if not configured or "auto" in configured:
        configured = [m for m in configured if m != "auto"] + _newest_gemini_flash()
    models = list(dict.fromkeys(configured + GEMINI_FALLBACKS))
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        # newer Flash models "think" before answering and those tokens count toward this limit
        "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json", "maxOutputTokens": 4096},
    }
    problems = []
    for i, model in enumerate(models):
        if budget is not None and budget <= 0:
            break
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        _count_request()
        # key in a header, not the URL, so it can never show up in error messages or logs
        r = requests.post(url, headers={"x-goog-api-key": settings.GEMINI_API_KEY}, json=body, timeout=90)
        if r.status_code in (404, 429, 500, 502, 503, 504):
            problems.append(f"{model}: HTTP {r.status_code} {_err_message(r)}")
            if i + 1 < len(models):
                time.sleep(2)
            continue
        _raise(r, "gemini")
        data = r.json()
        cands = data.get("candidates") or []
        if not cands:
            reason = (data.get("promptFeedback") or {}).get("blockReason") or "no candidates"
            problems.append(f"{model}: no answer ({reason})")
            continue
        parts = (cands[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if not text:
            problems.append(f"{model}: empty text (finishReason={cands[0].get('finishReason')})")
            continue
        return text, model
    if problems and all("HTTP 429" in p for p in problems):
        _cooldown["gemini"] = time.time() + 600
    raise RuntimeError(" | ".join(problems) or "gemini: no model available")


def _discover_model(base: str, key: str, name: str, current: str) -> str | None:
    """Ask the provider which models this key can use and pick the best replacement."""
    try:
        r = requests.get(f"{base}/models", headers={"Authorization": f"Bearer {key}"}, timeout=20)
        if not r.ok:
            return None
        ids = [m["id"] for m in r.json().get("data", []) if m.get("active", True) and m.get("id")]
    except Exception:  # noqa: BLE001
        return None
    usable = [i for i in ids if not _SKIP_MODEL.search(i) and i != current]
    for pref in PREFERRED_MODELS.get(name, []):
        if pref in usable:
            return pref
    return usable[0] if usable else None


def _call_openai_compatible(base: str, key: str, model: str, prompt: str, name: str, json_mode: bool = True) -> tuple[str, str]:
    model = _model_override.get(name, model)
    for attempt in range(3):
        body = {
            "model": model,
            "temperature": 0.3,
            "max_tokens": 4096,  # reasoning models spend part of this on thinking
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        if name == "openrouter":
            headers["X-Title"] = "Trading Radar"
        _count_request()
        r = requests.post(f"{base}/chat/completions", json=body, headers=headers, timeout=90)
        msg = _err_message(r) if not r.ok else ""
        if r.status_code == 404 or (r.status_code == 400 and ("decommission" in msg or "model_not_found" in r.text)):
            replacement = _discover_model(base, key, name, model)
            if replacement and attempt < 2:
                log.warning("%s model %s unavailable, switching to %s", name, model, replacement)
                _model_override[name] = model = replacement
                continue
        if r.status_code == 400 and json_mode and "response_format" in msg:
            json_mode = False  # this model doesn't support JSON mode – ask for JSON in the prompt only
            continue
        _raise(r, name)
        return r.json()["choices"][0]["message"]["content"] or "", model
    raise RuntimeError(f"{name}: no usable model ({msg})")


def _call_ollama(prompt: str) -> str:
    r = requests.post(f"{settings.OLLAMA_URL.rstrip('/')}/api/chat", timeout=180, json={
        "model": settings.OLLAMA_MODEL, "stream": False, "format": "json",
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": prompt}],
        "options": {"temperature": 0.3},
    })
    _raise(r, "ollama")
    return r.json()["message"]["content"], settings.OLLAMA_MODEL


def _redact(text: str) -> str:
    """Remove any API key from an error message before it is logged or shown."""
    for key in (settings.GEMINI_API_KEY, settings.GROQ_API_KEY, settings.OPENROUTER_API_KEY):
        if key and len(key) >= 8:
            text = text.replace(key, "***")
    return re.sub(r"(key=)[^&\s'\"]+", r"\1***", text)


def _raise(r: requests.Response, name: str) -> None:
    if r.status_code == 429:
        retry = r.headers.get("retry-after")
        wait = float(retry) if retry and retry.replace(".", "").isdigit() else 120
        _cooldown[name] = time.time() + min(wait, 3600)
        raise RuntimeError(f"{name} rate-limited")
    if r.status_code >= 400:
        raise RuntimeError(f"{name} HTTP {r.status_code}: {_err_message(r)}")


def _available() -> list[str]:
    out = []
    for p in settings.LLM_PROVIDERS:
        if p == "gemini" and settings.GEMINI_API_KEY:
            out.append(p)
        elif p == "groq" and settings.GROQ_API_KEY:
            out.append(p)
        elif p == "openrouter" and settings.OPENROUTER_API_KEY:
            out.append(p)
        elif p == "ollama" and settings.OLLAMA_URL:
            out.append(p)
    return out


def complete_json(prompt: str) -> tuple[dict | None, str]:
    """Try providers in order. Returns (parsed_json | None, provider_name)."""
    global last_ok
    for name in _available():
        if budget is not None and budget <= 0:
            break
        if _cooldown.get(name, 0) > time.time():
            continue
        with _lock:
            gap = MIN_GAP_SEC.get(name, 2) - (time.time() - _last_call.get(name, 0))
            if gap > 0:
                time.sleep(gap)
            _last_call[name] = time.time()
        try:
            if name == "gemini":
                text, model = _call_gemini(prompt)
            elif name == "groq":
                text, model = _call_openai_compatible("https://api.groq.com/openai/v1", settings.GROQ_API_KEY,
                                                      settings.GROQ_MODEL, prompt, name)
            elif name == "openrouter":
                text, model = _call_openai_compatible("https://openrouter.ai/api/v1", settings.OPENROUTER_API_KEY,
                                                      settings.OPENROUTER_MODEL, prompt, name, json_mode=False)
            else:
                _count_request()
                text, model = _call_ollama(prompt)
            parsed = extract_json(text)
            if parsed is not None:
                last_ok = f"{name}:{model}"
                last_errors.pop(name, None)
                return parsed, f"{name}:{model}"
            last_errors[name] = f"התשובה לא הייתה JSON תקין: {text[:80]!r}"
            log.warning("%s returned non-JSON: %s", name, text[:200])
        except Exception as exc:  # noqa: BLE001
            msg = _redact(str(exc))
            last_errors[name] = msg[:200]
            log.warning("LLM %s failed: %s", name, msg)
            if "rate-limited" not in str(exc) and _cooldown.get(name, 0) < time.time():
                _cooldown[name] = time.time() + 180  # skip this provider briefly; the next one is tried now
    return None, "rules"


def extract_json(text: str) -> dict | None:
    if not text:
        return None
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
    return None


# ------------------------------------------------------------------ prompts
def _fmt(v, nd=2):
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def analyze_stock(ctx: dict) -> dict:
    """ctx: ticker, name, ind, signals, score, holding, news, social, fundamentals, congress, sizing"""
    ind = ctx["ind"]
    h = ctx.get("holding")
    lines = [
        f"מניה: {ctx['ticker']} ({ctx.get('name') or ''}) מטבע {ctx.get('currency')}",
        f"מחיר {_fmt(ind['price'])} | שינוי יומי {_fmt(ind['change_pct'])}% | 5 ימים {_fmt(ind.get('change_5d_pct'))}% | חודש {_fmt(ind.get('change_1m_pct'))}%",
        f"בולינגר: עליונה {_fmt(ind.get('bb_up'))} אמצע {_fmt(ind.get('bb_mid'))} תחתונה {_fmt(ind.get('bb_lo'))} | %B {_fmt(ind.get('bb_pctb'))} | אחוזון רוחב {_fmt(ind.get('bb_bw_pctl'), 0)}",
        f"RSI {_fmt(ind.get('rsi'), 0)} | MACD hist {_fmt(ind.get('macd_hist'), 3)} | SMA50 {_fmt(ind.get('sma50'))} SMA200 {_fmt(ind.get('sma200'))} | ATR {_fmt(ind.get('atr'))} | נפח יחסי {_fmt(ind.get('vol_ratio'))}",
        f"ציון טכני+סנטימנט: {ctx['score']} (-100..100)",
        "איתותים: " + ("; ".join(f"{s['title']} ({'+' if s['dir'] > 0 else '-' if s['dir'] < 0 else '~'})" for s in ctx["signals"]) or "אין"),
    ]
    if h:
        lines.append(f"בתיק: {h['shares']} יח' במחיר ממוצע {h['avg_price']} | סטופ {h.get('stop_loss')} | יעד {h.get('take_profit')} | רווח/הפסד {_fmt(ctx.get('pnl_pct'))}%")
    else:
        lines.append("לא בתיק – מועמדת לכניסה.")
        if ctx.get("sizing"):
            sz = ctx["sizing"]
            lines.append(f"הצעת גודל פוזיציה: {sz.get('shares')} יח', סטופ מוצע {_fmt(sz.get('stop'))}, יעד {_fmt(sz.get('target'))}")
    f = ctx.get("fundamentals") or {}
    if f:
        lines.append("פונדמנטלי: " + ", ".join(f"{k}={_fmt(v)}" for k, v in f.items() if k != "name"))
    soc = ctx.get("social") or {}
    if soc.get("messages"):
        lines.append(f"StockTwits: שוריים {soc.get('bull')} / דוביים {soc.get('bear')} מתוך {soc.get('messages')} | אזכורי Reddit {soc.get('reddit_mentions')}")
    if ctx.get("congress"):
        lines.append("עסקאות קונגרס: " + "; ".join(f"{c['member']} {c['type']} {c['amount']} ({c['date']})" for c in ctx["congress"][:3]))
    news = ctx.get("news") or []
    if news:
        lines.append("כותרות אחרונות:")
        lines += [f"- [{n['source']}] {n['title']}" for n in news[:8]]
    prompt = "\n".join(lines) + f"\n\nהחזר JSON במבנה:\n{STOCK_SCHEMA}"
    out, provider = complete_json(prompt)
    if out:
        out = _sanitize_stock(out)
        out["provider"] = provider
        return out
    return rule_based_stock(ctx)


def market_brief(ctx: dict) -> dict:
    lines = ["מדדים:"]
    lines += [f"- {k}: {_fmt(v.get('price'))} ({_fmt(v.get('change_pct'))}%)" for k, v in ctx["indices"].items()]
    lines.append(f"תיק: שווי {_fmt(ctx['portfolio'].get('value'))} | יומי {_fmt(ctx['portfolio'].get('day_pnl_pct'))}% | כולל {_fmt(ctx['portfolio'].get('total_pnl_pct'))}%")
    lines.append("מניות בתיק (ציון, פעולה):")
    lines += [f"- {r['ticker']}: {r['score']} {r['action']}" for r in ctx["holdings"][:15]]
    lines.append("הזדמנויות מובילות:")
    lines += [f"- {r['ticker']}: {r['score']} – {r.get('top_signal', '')}" for r in ctx["opportunities"][:6]]
    lines.append("כותרות שוק:")
    lines += [f"- [{n['source']}] {n['title']}" for n in ctx["news"][:12]]
    prompt = "\n".join(lines) + f"\n\nכתוב תדריך שוק קצר. החזר JSON במבנה:\n{BRIEF_SCHEMA}"
    out, provider = complete_json(prompt)
    if out:
        out["provider"] = provider
        try:
            out["mood"] = max(-100, min(100, float(out.get("mood", 0))))
        except (TypeError, ValueError):
            out["mood"] = 0
        return out
    return rule_based_brief(ctx)


def _sanitize_stock(o: dict) -> dict:
    act = str(o.get("action", "HOLD")).upper()
    o["action"] = act if act in {"BUY", "ADD", "HOLD", "WATCH", "TRIM", "SELL"} else "HOLD"
    try:
        o["confidence"] = int(max(0, min(100, float(o.get("confidence", 50)))))
    except (TypeError, ValueError):
        o["confidence"] = 50
    for k in ("bull", "bear"):
        o[k] = [str(x) for x in (o.get(k) or [])][:5]
    for k in ("entry", "stop", "target"):
        try:
            o[k] = float(o[k]) if o.get(k) not in (None, "", "null") else None
        except (TypeError, ValueError):
            o[k] = None
    return o


# ------------------------------------------------------------------ rule-based fallback
def rule_based_stock(ctx: dict) -> dict:
    score = ctx["score"]
    held = bool(ctx.get("holding"))
    sigs = ctx["signals"]
    exits = [s for s in sigs if s["cat"] == "exit" and s["strength"] >= 0.85]
    if exits:
        action = "SELL" if any(s["code"] in ("stop_hit", "trailing_hit") for s in exits) else "TRIM"
    elif held:
        action = "ADD" if score >= 55 else "HOLD" if score > -25 else "TRIM" if score > -55 else "SELL"
    else:
        action = "BUY" if score >= 55 else "WATCH" if score >= 15 else "HOLD"
    bull = [s["title"] for s in sorted(sigs, key=lambda x: -x["strength"]) if s["dir"] > 0][:4]
    bear = [s["title"] for s in sorted(sigs, key=lambda x: -x["strength"]) if s["dir"] < 0][:4]
    top = max(sigs, key=lambda x: x["strength"])["title"] if sigs else "אין איתות בולט"
    sz = ctx.get("sizing") or {}
    names = {"BUY": "קנייה", "ADD": "הגדלה", "HOLD": "החזקה", "WATCH": "מעקב", "TRIM": "מימוש חלקי", "SELL": "מכירה"}
    return {
        "action": action,
        "confidence": int(min(95, 40 + abs(score) * 0.55)),
        "headline": f"{names[action]} · {top}",
        "summary": f"ציון משוקלל {score:+.0f}. " + (" | ".join(s['desc'] for s in sigs[:2]) if sigs else "המניה בטווח ללא איתות מובהק."),
        "bull": bull, "bear": bear,
        "entry": sz.get("entry"), "stop": sz.get("stop") or (ctx["holding"] or {}).get("stop_loss"),
        "target": sz.get("target") or (ctx["holding"] or {}).get("take_profit"),
        "horizon": "שבועות", "provider": "rules",
    }


def rule_based_brief(ctx: dict) -> dict:
    idx = ctx["indices"]
    chg = [v.get("change_pct") or 0 for k, v in idx.items() if k != "^VIX"]
    avg = sum(chg) / len(chg) if chg else 0
    vix = (idx.get("^VIX") or {}).get("price") or 18
    news_sent = ctx.get("news_sentiment", 0)
    mood = max(-100, min(100, avg * 35 + news_sent * 40 - (vix - 18) * 3))
    title = "שוק חיובי" if mood > 20 else "שוק שלילי" if mood < -20 else "שוק מעורב"
    hold = ctx["holdings"]
    sells = [h["ticker"] for h in hold if h["action"] in ("SELL", "TRIM")]
    return {
        "mood": round(mood),
        "title": f"{title} · VIX {vix:.1f}",
        "summary": f"שינוי ממוצע במדדים {avg:+.2f}%. סנטימנט כותרות {news_sent:+.2f}. "
                   f"בתיק {len(hold)} פוזיציות, {len(sells)} עם איתות יציאה.",
        "focus": [o["ticker"] + " – " + o.get("top_signal", "") for o in ctx["opportunities"][:3]],
        "risks": ([f"איתות יציאה: {', '.join(sells)}"] if sells else []) + (["תנודתיות גבוהה (VIX>25)"] if vix > 25 else []),
        "actions": ["עבור על איתותי היציאה לפני הפתיחה"] if sells else ["אין פעולה דחופה – המשך מעקב"],
        "provider": "rules",
    }
