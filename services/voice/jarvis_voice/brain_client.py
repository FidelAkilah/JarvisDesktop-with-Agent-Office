"""Client for the agent service WebSocket (the brain lives there).

Replies stream in as deltas; complete sentences are handed to `on_sentence`
as soon as they form, so TTS can start speaking while the rest of the reply
is still being generated."""

import json
import re
from collections.abc import Callable

from websockets.sync.client import connect

from . import config

_SENTENCE_END = re.compile(r'[.!?…]["\')\]]?\s')


class _SentenceAssembler:
    def __init__(self, emit: Callable[[str], None]) -> None:
        self._buf = ""
        self._emit = emit
        self.emitted_any = False

    def feed(self, text: str) -> None:
        self._buf += text
        while True:
            m = _SENTENCE_END.search(self._buf)
            if not m:
                return
            sentence = self._buf[: m.end()].strip()
            self._buf = self._buf[m.end() :]
            if sentence:
                self.emitted_any = True
                self._emit(sentence)

    def flush(self) -> None:
        tail = self._buf.strip()
        self._buf = ""
        if tail:
            self.emitted_any = True
            self._emit(tail)


class BrainClient:
    def __init__(self, session_id: str = "voice") -> None:
        self.session_id = session_id

    def chat(
        self,
        text: str,
        on_sentence: Callable[[str], None] | None = None,
    ) -> str:
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
            assembler = _SentenceAssembler(on_sentence) if on_sentence else None
            while True:
                msg = json.loads(ws.recv(timeout=180))
                kind = msg.get("type")
                if kind == "assistant_delta" and assembler:
                    assembler.feed(msg["text"])
                elif kind == "reply":
                    if assembler:
                        if assembler.emitted_any or assembler._buf.strip():
                            assembler.flush()
                        else:  # no deltas arrived — speak the whole reply
                            assembler.feed(msg["text"])
                            assembler.flush()
                    return msg["text"]
                elif kind == "error":
                    raise RuntimeError(msg["message"])
                # ignore hello / event broadcasts
