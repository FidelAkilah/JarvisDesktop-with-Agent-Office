# JARVIS voice service (Phase 1 — not yet built)

Python sidecar for the hands-free loop:

openWakeWord ("hey jarvis") → VAD capture → faster-whisper STT (streaming
partials) → agent service over WebSocket → Piper TTS (British male voice;
fallback `say -v Daniel`).

Planned stack: uv-managed Python 3.12, RealtimeSTT, openwakeword, piper-tts.
On this machine (Apple M3) evaluate mlx-whisper / whisper.cpp+CoreML for speed.
Speaks WebSocket to the UI on port 4778 and to the agent service on 4777.

See `JARVIS VAULT/JARVIS/System/NEXT_STEPS.md` for the Phase 1 plan.
