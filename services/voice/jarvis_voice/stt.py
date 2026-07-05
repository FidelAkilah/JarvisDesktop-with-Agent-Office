"""Speech-to-text — faster-whisper (CTranslate2, int8 on CPU; fast on the M3).
Model size comes from JARVIS_WHISPER_MODEL (.env)."""

import threading

import numpy as np

from . import config


class Transcriber:
    def __init__(self) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            config.WHISPER_MODEL, device="cpu", compute_type="int8"
        )
        # Partial (mid-utterance) and final transcriptions can overlap;
        # serialize access so the final one never races a partial.
        self._lock = threading.Lock()

    def transcribe(self, pcm: np.ndarray) -> str:
        audio = pcm.astype(np.float32) / 32768.0
        with self._lock:
            segments, _info = self._model.transcribe(
                audio,
                language=config.LANGUAGE,
                beam_size=1,
                vad_filter=True,
            )
            return " ".join(s.text.strip() for s in segments).strip()
