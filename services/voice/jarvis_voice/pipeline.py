"""The hands-free loop: armed → wake → capture → transcribe → think → speak →
armed. Per-stage timings are printed after every interaction."""

import time
from collections import deque

import numpy as np

from . import config
from .audio import MicSource
from .brain_client import BrainClient
from .capture import capture_utterance, rms
from .stt import Transcriber
from .tts import Speaker
from .wake import WakeDetector


def run(source=None, speak_replies: bool = True, once: bool = False):
    print("[voice] loading models…")
    t0 = time.perf_counter()
    wake = WakeDetector()
    stt = Transcriber()
    speaker = Speaker()
    brain = BrainClient()
    print(
        f"[voice] ready in {time.perf_counter() - t0:.1f}s — "
        'say "Hey Jarvis"…  (Ctrl+C to quit)'
    )

    src = source if source is not None else MicSource()
    ambient: deque[float] = deque(maxlen=25)
    last_result = None

    with src:
        frames = src.frames()
        brain.send_state("idle", "armed")
        try:
            for frame in frames:
                ambient.append(rms(frame))
                if wake.score(frame) < config.WAKE_THRESHOLD:
                    continue

                # ── wake word fired ─────────────────────────────────────
                t_wake = time.perf_counter()
                print("\n[voice] wake word detected — listening…")
                brain.send_state("listening")
                ambient_rms = float(np.median(ambient)) if ambient else 200.0
                pcm = capture_utterance(frames, ambient_rms)
                t_captured = time.perf_counter()

                if pcm is None:
                    print("[voice] heard nothing — back to armed.")
                    wake.reset()
                    brain.send_state("idle", "armed")
                    continue

                text = stt.transcribe(pcm)
                t_stt = time.perf_counter()
                if not text:
                    print("[voice] couldn't make out any words — back to armed.")
                    wake.reset()
                    brain.send_state("idle", "armed")
                    continue

                print(f"[you]    {text}")
                brain.send_state("thinking", text)
                try:
                    reply = brain.chat(text)
                except Exception as e:  # noqa: BLE001
                    reply = f"Sorry, I hit a problem talking to my brain: {e}"
                t_brain = time.perf_counter()

                print(f"[jarvis] {reply}")
                brain.send_state("speaking", reply[:120])
                tts = speaker.speak(reply) if speak_replies else {"synth": 0.0, "play": 0.0}

                stt_s = t_stt - t_captured
                brain_s = t_brain - t_stt
                to_voice = stt_s + brain_s + tts["synth"]
                print(
                    "[timing] stt={:.2f}s · brain={:.2f}s · tts={:.2f}s │ "
                    "end-of-speech → JARVIS starts speaking: {:.2f}s "
                    "(then {:.1f}s of audio)".format(
                        stt_s, brain_s, tts["synth"], to_voice, tts["play"]
                    )
                )

                wake.reset()
                brain.send_state("idle", "armed")
                last_result = (text, reply)
                if once:
                    return last_result
        except KeyboardInterrupt:
            print("\n[voice] powering down. Goodbye.")
            brain.send_state("idle", "off")

    return last_result
