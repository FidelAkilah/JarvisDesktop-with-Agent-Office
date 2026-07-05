"""The hands-free loop: armed → wake → capture → transcribe → think → speak →
armed. Replies are spoken sentence-by-sentence as they stream from the brain.

Live wiring to the HUD (via the agent service):
  · voice_state  — armed / listening / thinking / speaking / muted
  · voice_level  — mic energy ~12×/s (drives the reactor waveform)
  · voice_partial — in-progress transcript while the user is still talking
  · voice_cmd (inbound) — ptt (act as if the wake word fired), mute / unmute /
    toggle_mute
"""

import queue
import threading
import time
from collections import deque

import numpy as np

from . import config
from .audio import MicSource
from .brain_client import BrainClient
from .capture import capture_utterance, rms
from .link import AgentLink
from .stt import Transcriber
from .tts import Speaker
from .wake import WakeDetector

# Speech at normal volume lands around 1500–5000 RMS on int16; this maps it
# into a pleasant 0–1 meter range for the HUD.
LEVEL_SCALE = 4000.0


def run(source=None, speak_replies: bool = True, once: bool = False):
    print("[voice] loading models…")
    t0 = time.perf_counter()
    wake = WakeDetector()
    stt = Transcriber()
    speaker = Speaker()
    brain = BrainClient()

    muted = threading.Event()
    ptt = threading.Event()

    def on_command(cmd: str) -> None:
        if cmd == "ptt":
            ptt.set()
        elif cmd == "mute":
            muted.set()
        elif cmd == "unmute":
            muted.clear()
        elif cmd == "toggle_mute":
            if muted.is_set():
                muted.clear()
            else:
                muted.set()
        else:
            return
        if muted.is_set():
            link.send_state("waiting", "muted")
            print("[voice] muted")
        else:
            link.send_state("idle", "armed")
            print("[voice] armed")

    link = AgentLink(on_command=on_command)
    print(
        f"[voice] ready in {time.perf_counter() - t0:.1f}s — "
        'say "Hey Jarvis"…  (Ctrl+C to quit)'
    )

    src = source if source is not None else MicSource()
    ambient: deque[float] = deque(maxlen=25)
    last_result = None

    # Partial transcription runs on a worker so capture never stalls.
    partial_busy = threading.Event()

    def on_chunk(pcm_so_far: np.ndarray) -> None:
        if partial_busy.is_set():
            return
        partial_busy.set()

        def work() -> None:
            try:
                partial = stt.transcribe(pcm_so_far)
                if partial:
                    link.send_partial(partial)
            finally:
                partial_busy.clear()

        threading.Thread(target=work, daemon=True).start()

    with src:
        frames = src.frames()
        link.send_state("idle", "armed")
        try:
            for frame in frames:
                level = rms(frame)
                ambient.append(level)
                link.send_level(0.0 if muted.is_set() else level / LEVEL_SCALE)

                triggered = ptt.is_set()
                if triggered:
                    ptt.clear()
                elif muted.is_set():
                    continue
                elif wake.score(frame) < config.WAKE_THRESHOLD:
                    continue

                # ── wake word (or push-to-talk) fired ───────────────────
                t_wake = time.perf_counter()
                print(f"\n[voice] {'push-to-talk' if triggered else 'wake word'} — listening…")
                link.send_state("listening")
                ambient_rms = float(np.median(ambient)) if ambient else 200.0
                pcm = capture_utterance(
                    frames,
                    ambient_rms,
                    on_frame=lambda f: link.send_level(rms(f) / LEVEL_SCALE),
                    on_chunk=on_chunk,
                )
                t_captured = time.perf_counter()

                if pcm is None:
                    print("[voice] heard nothing — back to armed.")
                    wake.reset()
                    link.send_state("idle", "armed")
                    continue

                text = stt.transcribe(pcm)
                t_stt = time.perf_counter()
                if not text:
                    print("[voice] couldn't make out any words — back to armed.")
                    wake.reset()
                    link.send_state("idle", "armed")
                    continue

                print(f"[you]    {text}")
                link.send_state("thinking", text)

                # Speak sentences on a worker thread as they stream in.
                sentences: queue.Queue[str | None] = queue.Queue()
                first_audio_at: list[float | None] = [None]
                started_speaking = threading.Event()

                def speak_worker() -> None:
                    while True:
                        sentence = sentences.get()
                        if sentence is None:
                            return
                        if not started_speaking.is_set():
                            started_speaking.set()
                            link.send_state("talking")
                        t_s = time.perf_counter()
                        timings = speaker.speak(sentence)
                        if first_audio_at[0] is None:
                            first_audio_at[0] = t_s + timings["synth"]

                worker = threading.Thread(target=speak_worker, daemon=True)
                worker.start()
                on_sentence = sentences.put if speak_replies else None
                try:
                    reply = brain.chat(text, on_sentence=on_sentence)
                except Exception as e:  # noqa: BLE001
                    reply = f"Sorry, I hit a problem talking to my brain: {e}"
                    if speak_replies:
                        sentences.put(reply)
                t_reply_done = time.perf_counter()
                print(f"[jarvis] {reply}")
                sentences.put(None)
                worker.join()
                t_all_spoken = time.perf_counter()

                stt_s = t_stt - t_captured
                first_voice = (first_audio_at[0] or t_all_spoken) - t_captured
                print(
                    "[timing] stt={:.2f}s · reply-complete={:.2f}s │ "
                    "end-of-speech → JARVIS starts speaking: {:.2f}s "
                    "(finished speaking at {:.1f}s)".format(
                        stt_s,
                        t_reply_done - t_captured,
                        first_voice,
                        t_all_spoken - t_captured,
                    )
                )

                wake.reset()
                link.send_state("idle", "armed")
                last_result = (text, reply)
                if once:
                    return last_result
        except KeyboardInterrupt:
            print("\n[voice] powering down. Goodbye.")
            link.send_state("idle", "off")

    return last_result
