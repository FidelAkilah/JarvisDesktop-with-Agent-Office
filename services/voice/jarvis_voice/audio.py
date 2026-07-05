"""Audio sources. MicSource for real use; FileSource replays a recording so the
whole pipeline can be tested end-to-end without a microphone."""

import queue
from collections.abc import Iterator

import numpy as np

from . import config


class MicSource:
    """Yields 80 ms int16 mono frames at 16 kHz from the default microphone."""

    def __init__(self) -> None:
        import sounddevice as sd  # deferred: importing touches CoreAudio

        self._queue: queue.Queue[np.ndarray] = queue.Queue()
        self._stream = sd.InputStream(
            samplerate=config.SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=config.FRAME_SAMPLES,
            callback=self._on_audio,
        )

    def _on_audio(self, indata, frames, time_info, status) -> None:  # noqa: ANN001
        self._queue.put(indata[:, 0].copy())

    def __enter__(self) -> "MicSource":
        self._stream.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stream.stop()
        self._stream.close()

    def frames(self) -> Iterator[np.ndarray]:
        while True:
            yield self._queue.get()


class FileSource:
    """Replays an audio file as if it were the mic (any format/rate — resampled
    to 16 kHz via faster-whisper's decoder)."""

    def __init__(self, path: str) -> None:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(path, sampling_rate=config.SAMPLE_RATE)  # float32 −1…1
        self._pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)

    def __enter__(self) -> "FileSource":
        return self

    def __exit__(self, *exc: object) -> None:
        pass

    def frames(self) -> Iterator[np.ndarray]:
        n = config.FRAME_SAMPLES
        for i in range(0, len(self._pcm) - n + 1, n):
            yield self._pcm[i : i + n]
