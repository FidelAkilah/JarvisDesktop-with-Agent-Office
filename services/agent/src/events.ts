// The canonical JARVIS event schema. Every meaningful action in the system
// emits one of these; the HUD and the pixel office render as a pure function
// of this stream. Persisted append-only to data/events.jsonl (SQLite planned
// for Phase 3). Keep in sync with shared/EVENTS.md.

export type AgentState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'talking'
  | 'waiting'
  | 'error'
  | 'done';

// Drives sprite animation in the pixel office (Phase 4):
// typing → desk · terminal → terminal station · research → globe ·
// vault_read/vault_write → bookshelf · waiting_user → looks at camera
export type Activity =
  | 'typing'
  | 'terminal'
  | 'research'
  | 'vault_read'
  | 'vault_write'
  | 'speaking'
  | 'listening'
  | 'waiting_user';

export interface JarvisEvent {
  id: number;
  ts: string; // ISO 8601
  source: 'orchestrator' | 'agent' | 'voice' | 'ui' | 'system';
  agentId?: string;
  state?: AgentState;
  activity?: Activity;
  tool?: string;
  target?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export type NewEvent = Omit<JarvisEvent, 'id' | 'ts'>;
