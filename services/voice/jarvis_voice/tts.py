"""Text-to-speech. Prefers Piper (local neural TTS, British male voice);
falls back to macOS `say -v Daniel`, then the system default voice."""

import io
import subprocess
import tempfile
import time
import wave
from pathlib import Path

from . import config


class Speaker:
    def __init__(self) -> None:
        self._piper = None
        model_path = config.MODELS_DIR / f"{config.TTS_VOICE}.onnx"
        if model_path.exists():
            try:
                from piper import PiperVoice

                self._piper = PiperVoice.load(str(model_path))
            except Exception as e:  # noqa: BLE001
                print(f"[tts] piper unavailable ({e}); falling back to macOS say")
        self._say_voice = "Daniel" if self._say_has("Daniel") else None
        engine = (
            f"piper:{config.TTS_VOICE}" if self._piper
            else f"say:{self._say_voice or 'default'}"
        )
        print(f"[tts] engine = {engine}")
        if self._piper:  # warm up espeak/onnx so the first real reply is fast
            with wave.open(io.BytesIO(), "wb") as f:
                self._piper.synthesize_wav("Ready.", f)

    @staticmethod
    def _say_has(voice: str) -> bool:
        try:
            out = subprocess.run(
                ["say", "-v", "?"], capture_output=True, text=True, timeout=10
            ).stdout
            return any(
                line.split()[0] == voice for line in out.splitlines() if line.strip()
            )
        except Exception:  # noqa: BLE001
            return False

    def synth_to_wav(self, text: str, path: Path) -> bool:
        """Piper synthesis to a wav file (used by tests). False if no Piper."""
        if not self._piper:
            return False
        with wave.open(str(path), "wb") as f:
            if hasattr(self._piper, "synthesize_wav"):
                self._piper.synthesize_wav(text, f)
            else:  # older piper-tts API
                self._piper.synthesize(text, f)
        return True

    def speak(self, text: str) -> dict[str, float]:
        """Synthesize and play. Returns {'synth': s, 'play': s} timings —
        `synth` is the part the user perceives as latency; `play` is just the
        audio's own duration."""
        if self._piper:
            tmp = Path(tempfile.mkstemp(suffix=".wav")[1])
            try:
                t0 = time.perf_counter()
                self.synth_to_wav(text, tmp)
                synth = time.perf_counter() - t0
                t1 = time.perf_counter()
                subprocess.run(["afplay", str(tmp)], check=False)
                return {"synth": synth, "play": time.perf_counter() - t1}
            finally:
                tmp.unlink(missing_ok=True)
        t0 = time.perf_counter()
        cmd = ["say", "-v", self._say_voice, text] if self._say_voice else ["say", text]
        subprocess.run(cmd, check=False)
        return {"synth": 0.0, "play": time.perf_counter() - t0}
