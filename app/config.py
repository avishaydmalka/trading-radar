"""Central configuration: environment variables (.env) + config/portfolio.yaml."""
from __future__ import annotations

import os
from pathlib import Path

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no external dependency). Real env vars win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if value[:1] not in ('"', "'") and " #" in value:
            value = value.split(" #", 1)[0].strip()  # inline comment
        value = value.strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


_load_dotenv(BASE_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_bool(name: str, default: bool = False) -> bool:
    return _env(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


class Settings:
    # --- general ---
    DEMO_MODE = _env_bool("DEMO_MODE", False)
    TIMEZONE = _env("TIMEZONE", "Asia/Jerusalem")
    BASE_CURRENCY = _env("BASE_CURRENCY", "USD").upper()  # USD or ILS
    DB_PATH = _env("DB_PATH", str(BASE_DIR / "data" / "radar.db"))
    PORTFOLIO_FILE = _env("PORTFOLIO_FILE", str(BASE_DIR / "config" / "portfolio.yaml"))
    PUBLIC_URL = _env("PUBLIC_URL", "")  # e.g. https://radar.example.com (used in Telegram links)

    # --- scheduling ---
    SCAN_INTERVAL_MIN = _env_int("SCAN_INTERVAL_MIN", 5)          # while a market is open
    OFFHOURS_INTERVAL_MIN = _env_int("OFFHOURS_INTERVAL_MIN", 60)  # when all markets closed
    NEWS_INTERVAL_MIN = _env_int("NEWS_INTERVAL_MIN", 15)
    LLM_INTERVAL_MIN = _env_int("LLM_INTERVAL_MIN", 30)            # per ticker re-analysis
    BRIEF_INTERVAL_MIN = _env_int("BRIEF_INTERVAL_MIN", 60)        # market brief
    LLM_MAX_CALLS_PER_SCAN = _env_int("LLM_MAX_CALLS_PER_SCAN", 4)

    # --- free LLM providers (tried in order, falls back to rules if none work) ---
    LLM_PROVIDERS = [p.strip() for p in _env("LLM_PROVIDERS", "gemini,groq,openrouter,ollama").split(",") if p.strip()]
    GEMINI_API_KEY = _env("GEMINI_API_KEY")
    GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-flash-latest")  # falls back to flash-lite when busy
    GROQ_API_KEY = _env("GROQ_API_KEY")
    GROQ_MODEL = _env("GROQ_MODEL", "openai/gpt-oss-120b")  # auto-replaced if retired
    OPENROUTER_API_KEY = _env("OPENROUTER_API_KEY")
    OPENROUTER_MODEL = _env("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct:free")
    OLLAMA_URL = _env("OLLAMA_URL")  # e.g. http://ollama:11434
    OLLAMA_MODEL = _env("OLLAMA_MODEL", "llama3.1:8b")

    # --- optional data keys ---
    FINNHUB_API_KEY = _env("FINNHUB_API_KEY")
    CONGRESS_API_URL = _env("CONGRESS_API_URL", "https://www.bargo.ai/free-apis/congress/v1/trades")
    CONGRESS_API_KEY = _env("CONGRESS_API_KEY")

    # --- notifications ---
    TELEGRAM_BOT_TOKEN = _env("TELEGRAM_BOT_TOKEN")
    TELEGRAM_CHAT_ID = _env("TELEGRAM_CHAT_ID")
    VAPID_PUBLIC_KEY = _env("VAPID_PUBLIC_KEY")
    VAPID_PRIVATE_KEY = _env("VAPID_PRIVATE_KEY")
    VAPID_EMAIL = _env("VAPID_EMAIL", "mailto:admin@example.com")
    ALERT_COOLDOWN_HOURS = _env_float("ALERT_COOLDOWN_HOURS", 6)
    MIN_OPPORTUNITY_SCORE = _env_int("MIN_OPPORTUNITY_SCORE", 55)

    # --- dashboard auth (strongly recommended in the cloud) ---
    DASHBOARD_USER = _env("DASHBOARD_USER", "admin")
    DASHBOARD_PASSWORD = _env("DASHBOARD_PASSWORD")

    # --- broker (Alpaca paper trading, orders only after manual approval) ---
    ALPACA_API_KEY = _env("ALPACA_API_KEY")
    ALPACA_SECRET_KEY = _env("ALPACA_SECRET_KEY")
    ALPACA_BASE_URL = _env("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

    @classmethod
    def llm_enabled(cls) -> bool:
        return bool(cls.GEMINI_API_KEY or cls.GROQ_API_KEY or cls.OPENROUTER_API_KEY or cls.OLLAMA_URL)


settings = Settings()


def load_portfolio_file() -> dict:
    path = Path(settings.PORTFOLIO_FILE)
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}
