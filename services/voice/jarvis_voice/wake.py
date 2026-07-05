"""Wake word detection — openWakeWord's pretrained "hey jarvis" model (ONNX)."""

import numpy as np

from . import config

WAKE_MODEL = "hey_jarvis_v0.1"


class WakeDetector:
    def __init__(self) -> None:
        import openwakeword
        from openwakeword.model import Model

        # No-op when already present; fetches the shared feature models too.
        openwakeword.utils.download_models(model_names=[WAKE_MODEL])
        self._model = Model(
            wakeword_models=[WAKE_MODEL],
            inference_framework="onnx",
        )

    def reset(self) -> None:
        self._model.reset()

    def score(self, frame: np.ndarray) -> float:
        """Feed one 80 ms frame; returns the current wake-word confidence 0–1."""
        preds = self._model.predict(frame)
        return float(max(preds.values()))
