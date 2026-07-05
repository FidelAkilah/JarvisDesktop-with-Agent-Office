import type { NewEvent } from '../events.js';

// Everything above this interface (server, UI, voice) is agnostic to which
// brain is underneath. Swapping Agent SDK ↔ raw Anthropic API ↔ Ollama is a
// config change (JARVIS_BRAIN in .env) plus a new implementation of this.
export interface ChatInput {
  /** Stable conversation id — the provider maps it to its own session state. */
  sessionId: string;
  text: string;
  /** Structured events for the HUD / office view / event log. */
  onEvent?: (e: NewEvent) => void;
  /** Incremental reply text, for live streaming into the UI. */
  onPartialText?: (text: string) => void;
}

export interface BrainProvider {
  readonly name: string;
  /** Returns the final assistant reply text. Throws on failure. */
  chat(input: ChatInput): Promise<string>;
}
