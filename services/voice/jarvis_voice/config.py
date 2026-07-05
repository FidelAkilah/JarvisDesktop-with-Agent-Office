"""Configuration — reads the repo-root .env (single source of truth)."""

import os
from pathlib import Path

# jarvis_voice/config.py → jarvis_voice → voice → services → repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = Path(__file__).resolve().parents[1] / "models"


def _load_dotenv() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

AGENT_PORT = int(os.environ.get("JARVIS_AGENT_PORT", "4777"))
AGENT_WS_URL = f"ws://127.0.0.1:{AGENT_PORT}/ws"

WHISPER_MODEL = os.environ.get("JARVIS_WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("JARVIS_LANGUAGE", "en")
TTS_VOICE = os.environ.get("JARVIS_TTS_VOICE", "en_GB-alan-medium")
WAKE_THRESHOLD = float(os.environ.get("JARVIS_WAKE_THRESHOLD", "0.5"))

SAMPLE_RATE = 16_000
FRAME_SAMPLES = 1_280  # 80 ms frames — what openWakeWord expects
