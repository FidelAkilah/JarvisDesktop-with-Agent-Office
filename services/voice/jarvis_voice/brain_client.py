"""Client for the agent service WebSocket (the brain lives there)."""

import json

from websockets.sync.client import connect

from . import config


class BrainClient:
    def __init__(self, session_id: str = "voice") -> None:
        self.session_id = session_id

    def chat(self, text: str) -> str:
        with connect(config.AGENT_WS_URL, open_timeout=5) as ws:
            ws.send(
                json.dumps(
                    {
                        "type": "chat",
                        "sessionId": self.session_id,
                        "channel": "voice",
                        "text": text,
                    }
                )
            )
            while True:
                msg = json.loads(ws.recv(timeout=180))
                if msg.get("type") == "reply":
                    return msg["text"]
                if msg.get("type") == "error":
                    raise RuntimeError(msg["message"])
                # ignore hello / assistant_delta / event broadcasts

    def send_state(self, state: str, message: str | None = None) -> None:
        """Best-effort voice-state events for the HUD; never breaks the loop."""
        try:
            with connect(config.AGENT_WS_URL, open_timeout=2) as ws:
                ws.send(
                    json.dumps(
                        {"type": "voice_state", "state": state, "message": message}
                    )
                )
        except Exception:  # noqa: BLE001
            pass
