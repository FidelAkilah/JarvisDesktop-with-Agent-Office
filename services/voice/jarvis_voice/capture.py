"""Utterance capture with a simple adaptive energy VAD: record from wake until
the speaker goes quiet. Good enough for v1; upgrade path is silero-vad (noted
in vault NEXT_STEPS)."""

from collections.abc import Iterator

import numpy as np

from . import config


def rms(frame: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(frame.astype(np.float32)))))


def capture_utterance(
    frames: Iterator[np.ndarray],
    ambient_rms: float,
    max_seconds: float = 15.0,
    trailing_silence: float = 0.9,
    no_speech_timeout: float = 5.0,
    on_frame=None,
    on_chunk=None,
    chunk_interval: float = 1.0,
) -> np.ndarray | None:
    """Collect frames until `trailing_silence` seconds of quiet after speech.
    Returns None if the wake word fired but nobody said anything.

    `on_frame(frame)` fires per 80 ms frame (mic-level meter for the HUD);
    `on_chunk(pcm_so_far)` fires every `chunk_interval` s of speech so a
    partial transcript can stream in while the user is still talking."""
    threshold = max(ambient_rms * 2.5, 250.0)
    frame_s = config.FRAME_SAMPLES / config.SAMPLE_RATE

    collected: list[np.ndarray] = []
    heard_speech = False
    silence_s = 0.0
    total_s = 0.0
    since_chunk = 0.0

    for frame in frames:
        collected.append(frame)
        total_s += frame_s
        since_chunk += frame_s
        if on_frame:
            on_frame(frame)
        if rms(frame) >= threshold:
            heard_speech = True
            silence_s = 0.0
        else:
            silence_s += frame_s

        if heard_speech and on_chunk and since_chunk >= chunk_interval:
            since_chunk = 0.0
            on_chunk(np.concatenate(collected))

        if heard_speech and silence_s >= trailing_silence:
            break
        if not heard_speech and total_s >= no_speech_timeout:
            return None
        if total_s >= max_seconds:
            break

    if not heard_speech or not collected:
        return None
    return np.concatenate(collected)
