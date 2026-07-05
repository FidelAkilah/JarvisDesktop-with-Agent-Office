# JARVIS

A personal AI assistant for macOS: an Iron-Man-style HUD, a live pixel-art office
where real AI agents visibly work, hands-free local voice control ("Hey Jarvis"),
and an Obsidian vault as long-term memory. The brain is Claude (Opus 4.8) via the
Claude Agent SDK, authenticated with a Claude Max subscription.

## Status

**Phase 0 — Foundation.** Agent service + stub chat UI built. Full build plan and
live status: `JARVIS VAULT/JARVIS/System/NEXT_STEPS.md`.

## One-time setup

1. Open **Terminal** and run:
   ```
   claude setup-token
   ```
   A browser window opens — approve it. Copy the token it prints
   (starts with `sk-ant-oat01-`).
2. Put it in `.env` at the repo root:
   ```
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
   ```

## Run it

```bash
cd services/agent
npm install        # first time only
npm run dev        # starts the agent service on http://localhost:4777
```

Open <http://localhost:4777> in a browser and talk to JARVIS.

Smoke test from another terminal:

```bash
cd services/agent && npm run test:roundtrip
```

## Repo layout

| Path | What it is |
|---|---|
| `services/agent/` | The brain service (Node + Claude Agent SDK, WebSocket event stream) |
| `services/voice/` | Voice pipeline sidecar (Python — wake word, Whisper STT, Piper TTS) — Phase 1 |
| `apps/desktop/` | Electron shell + HUD + pixel office UI — Phase 2+ |
| `shared/` | Shared event schema docs |
| `JARVIS VAULT/` | The Obsidian vault (JARVIS's memory — git-ignored, personal data) |
| `data/` | Runtime event logs (git-ignored) |

## Documentation & continuity

All architecture decisions, build log, and next steps live in the vault so any
future builder (human or AI) can resume cold:

- `JARVIS VAULT/JARVIS/System/ARCHITECTURE.md`
- `JARVIS VAULT/JARVIS/System/BUILD_LOG.md`
- `JARVIS VAULT/JARVIS/System/NEXT_STEPS.md`
- `JARVIS VAULT/JARVIS/System/DECISIONS.md`
