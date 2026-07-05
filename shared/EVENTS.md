# JARVIS event schema (v0)

Every meaningful action in JARVIS emits a structured event. The HUD and the
pixel office render as a **pure function of this stream** — nothing in the UI is
faked. Canonical TypeScript definition: `services/agent/src/events.ts`.

```jsonc
{
  "id": 42,                     // monotonic, per service run
  "ts": "2026-07-05T20:00:00Z", // ISO 8601
  "source": "agent",            // orchestrator | agent | voice | ui | system
  "agentId": "researcher",      // which character this is
  "state": "working",           // idle|thinking|working|talking|waiting|error|done
  "activity": "vault_read",     // drives sprite animation, see below
  "tool": "Read",               // raw tool name, when applicable
  "target": "Memory/foo.md",    // what it acted on
  "message": "optional human-readable line",
  "data": {}                    // extra payload (cost, duration, …)
}
```

## Activity → office animation mapping

| activity | sprite behaviour |
|---|---|
| `typing` | typing at a desk (file edits) |
| `terminal` | at the terminal station (bash) |
| `research` | at the globe station (web/search) |
| `vault_read` / `vault_write` | at the bookshelf / filing cabinet |
| `speaking` / `listening` | speech bubble / ear icon (voice) |
| `waiting_user` | looks toward the camera |

## Transport

- Emitted over the agent service WebSocket (`ws://127.0.0.1:4777/ws`) as
  `{"type": "event", "event": {…}}`.
- Persisted append-only to `data/events.jsonl` (SQLite planned Phase 3) so runs
  can be replayed.
