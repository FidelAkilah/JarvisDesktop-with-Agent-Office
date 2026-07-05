"""Persistent link to the agent service: pushes voice states / mic levels /
partial transcripts up, receives commands (mute, push-to-talk) back down.
Auto-reconnects forever; every send is best-effort — the voice loop must never
die because the hub is down."""

import json
import queue
import threading
import time
from collections.abc import Callable

from websockets.sync.client import connect

from . import config


class AgentLink:
    def __init__(self, on_command: Callable[[str], None] | None = None) -> None:
        self._out: queue.Queue[str] = queue.Queue(maxsize=200)
        self._on_command = on_command
        self._last_level = 0.0
        threading.Thread(target=self._run, daemon=True, name="agent-link").start()

    # ── outgoing ────────────────────────────────────────────────────────
    def _send(self, obj: dict) -> None:
        try:
            self._out.put_nowait(json.dumps(obj))
        except queue.Full:
            pass

    def send_state(self, state: str, message: str | None = None) -> None:
        self._send({"type": "voice_state", "state": state, "message": message})

    def send_level(self, level: float) -> None:
        """Mic energy 0–1, throttled to ~12/s. Drives the reactor waveform."""
        now = time.monotonic()
        if now - self._last_level < 0.08:
            return
        self._last_level = now
        self._send({"type": "voice_level", "level": round(max(0.0, min(1.0, level)), 3)})

    def send_partial(self, text: str) -> None:
        """In-progress transcript while the user is still talking."""
        self._send({"type": "voice_partial", "text": text})

    # ── connection loop ─────────────────────────────────────────────────
    def _run(self) -> None:
        while True:
            try:
                with connect(config.AGENT_WS_URL, open_timeout=3) as ws:
                    stop = threading.Event()

                    def sender() -> None:
                        while not stop.is_set():
                            try:
                                item = self._out.get(timeout=0.5)
                            except queue.Empty:
                                continue
                            ws.send(item)

                    st = threading.Thread(target=sender, daemon=True)
                    st.start()
                    try:
                        while True:
                            msg = json.loads(ws.recv())
                            if msg.get("type") == "voice_cmd" and self._on_command:
                                self._on_command(str(msg.get("cmd", "")))
                    finally:
                        stop.set()
                        st.join(timeout=1)
            except Exception:  # noqa: BLE001
                time.sleep(2)  # hub down — retry quietly
