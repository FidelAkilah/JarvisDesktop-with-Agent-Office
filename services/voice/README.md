# JARVIS voice service

The hands-free loop, fully local: **openWakeWord** ("hey jarvis", ONNX) →
adaptive energy-VAD capture → **faster-whisper** STT (`small` by default) →
agent service over WebSocket → **Piper** TTS (`en_GB-alan-medium`; falls back
to macOS `say -v Daniel`).

## Run

```bash
./run.sh                 # live mic loop (agent service must be running)
./run.sh --no-speak      # print replies instead of speaking
./run.sh --input x.wav   # replay a recording as the mic (offline testing)
./run.sh --once          # exit after one interaction
```

Managed by [uv](https://docs.astral.sh/uv/) (Python 3.12, `uv sync` to
install). Settings live in the repo-root `.env`: `JARVIS_WHISPER_MODEL`,
`JARVIS_TTS_VOICE`, `JARVIS_WAKE_THRESHOLD`, `JARVIS_LANGUAGE`.

Models: openWakeWord downloads into the venv on first run; the Piper voice
lives in `models/` (re-download with
`uv run python -m piper.download_voices en_GB-alan-medium --data-dir models`);
Whisper caches under `~/.cache/huggingface`.

Design notes and the RealtimeSTT deviation: vault `System/DECISIONS.md`.
