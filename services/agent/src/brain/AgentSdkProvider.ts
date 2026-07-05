import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CONFIG } from '../env.js';
import type { BrainProvider, ChatInput } from './BrainProvider.js';
import type { NewEvent } from '../events.js';

const PERSONA = `You are JARVIS, Fidel's personal AI assistant — capable, warm, and
lightly witty in the manner of a trusted butler. You run inside the JARVIS desktop
app on his Mac. Answer conversational questions directly and concisely (a sentence
or two unless more is genuinely needed). Do not narrate your reasoning.`;

interface Pending {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  onEvent?: (e: NewEvent) => void;
  onPartialText?: (text: string) => void;
}

/**
 * One long-lived Agent SDK session (streaming input mode). The CLI subprocess
 * spawns once and stays warm, so per-turn latency is inference only — this is
 * what got voice latency out of the 5–10 s range. Messages queue and process
 * sequentially; each turn ends with a `result` message that resolves the
 * matching pending promise (FIFO).
 */
class PersistentSession {
  private inputQueue: (SDKUserMessage | null)[] = [];
  private inputWaiter: (() => void) | null = null;
  private pending: Pending[] = [];
  private replyBuffer = '';
  dead = false;
  lastUsed = Date.now();

  constructor(readonly id: string) {
    const stream = query({
      prompt: this.inputStream(),
      options: {
        model: CONFIG.model,
        systemPrompt: PERSONA,
        // Phase 0/1 is chat-only; Phase 3 adds tools + a permission handler.
        allowedTools: [],
        includePartialMessages: true,
      },
    });
    void this.pump(stream);
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.inputQueue.length === 0) {
        await new Promise<void>((res) => (this.inputWaiter = res));
      }
      const next = this.inputQueue.shift()!;
      if (next === null) return; // dispose(): close input → CLI exits cleanly
      yield next;
    }
  }

  private pushInput(msg: SDKUserMessage | null): void {
    this.inputQueue.push(msg);
    this.inputWaiter?.();
    this.inputWaiter = null;
  }

  private async pump(stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const raw of stream) {
        const msg = raw as any;
        const current = this.pending[0];
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              current?.onEvent?.({
                source: 'orchestrator',
                agentId: 'jarvis',
                state: 'thinking',
                message: `session warm · model=${msg.model ?? CONFIG.model}`,
              });
            }
            break;
          case 'stream_event': {
            const ev = msg.event;
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              current?.onPartialText?.(ev.delta.text as string);
            }
            break;
          }
          case 'assistant': {
            const blocks: any[] = msg.message?.content ?? [];
            const text = blocks
              .filter((b) => b?.type === 'text')
              .map((b) => b.text as string)
              .join('');
            if (text) this.replyBuffer = text;
            break;
          }
          case 'result': {
            const done = this.pending.shift();
            const reply =
              msg.subtype === 'success' && typeof msg.result === 'string' && msg.result
                ? msg.result
                : this.replyBuffer;
            this.replyBuffer = '';
            if (msg.subtype === 'success') {
              done?.onEvent?.({
                source: 'orchestrator',
                agentId: 'jarvis',
                state: 'done',
                data: {
                  costUsd: msg.total_cost_usd,
                  durationMs: msg.duration_ms,
                  usage: msg.usage, // input/output token counts for the HUD gauges
                },
              });
              done?.resolve(reply);
            } else {
              done?.reject(new Error(`Brain error (${msg.subtype})`));
            }
            break;
          }
        }
      }
      this.fail(new Error('brain session ended'));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private fail(err: Error): void {
    this.dead = true;
    for (const p of this.pending.splice(0)) p.reject(err);
  }

  chat(prompt: string, callbacks: Omit<Pending, 'resolve' | 'reject'>): Promise<string> {
    this.lastUsed = Date.now();
    return new Promise<string>((resolve, reject) => {
      this.pending.push({ resolve, reject, ...callbacks });
      this.pushInput({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    });
  }

  dispose(): void {
    this.dead = true;
    this.pushInput(null);
  }
}

// Sessions that stay warm forever; everything else is reaped after idling.
const KEEP_WARM = new Set(['voice', 'default']);
const IDLE_LIMIT_MS = 10 * 60 * 1000;

export class AgentSdkProvider implements BrainProvider {
  readonly name = 'agent-sdk';
  private sessions = new Map<string, PersistentSession>();

  constructor() {
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  /** Spawn a session ahead of time so the first question pays no boot cost. */
  warm(sessionId: string): void {
    if (CONFIG.hasOauthToken) this.session(sessionId);
  }

  private session(id: string): PersistentSession {
    let s = this.sessions.get(id);
    if (!s || s.dead) {
      s = new PersistentSession(id);
      this.sessions.set(id, s);
    }
    return s;
  }

  private reapIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!KEEP_WARM.has(id) && now - s.lastUsed > IDLE_LIMIT_MS) {
        s.dispose();
        this.sessions.delete(id);
      }
    }
  }

  async chat({ sessionId, text, channel, onEvent, onPartialText }: ChatInput): Promise<string> {
    if (!CONFIG.hasOauthToken) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_TOKEN is missing from .env — run `claude setup-token` ' +
          'in Terminal and paste the sk-ant-oat01-… token into .env (see README).',
      );
    }

    // Ambient context Claude can't know on its own; appended per message so it
    // stays fresh across the long-lived session.
    const now = new Date().toLocaleString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const contextNote =
      `\n\n[Context, not written by the user: current local time is ${now}.` +
      (channel === 'voice'
        ? ' The user is speaking by voice and your reply will be read aloud — keep it to a sentence or two of plain speakable prose, no markdown, no lists.'
        : '') +
      ']';

    try {
      return await this.session(sessionId).chat(text + contextNote, { onEvent, onPartialText });
    } catch (err) {
      // Session died mid-turn (CLI crash etc.) — retry once on a fresh one.
      this.sessions.delete(sessionId);
      onEvent?.({
        source: 'system',
        message: `brain session restarted (${err instanceof Error ? err.message : err})`,
      });
      return await this.session(sessionId).chat(text + contextNote, { onEvent, onPartialText });
    }
  }
}
