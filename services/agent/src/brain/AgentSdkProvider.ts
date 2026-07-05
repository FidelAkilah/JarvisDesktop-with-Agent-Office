import fs from 'node:fs';
import path from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CONFIG, REPO_ROOT } from '../env.js';
import type { BrainProvider, ChatInput } from './BrainProvider.js';
import type { Activity, NewEvent } from '../events.js';

/* ── personas live in the vault (JARVIS/Agents/*.md) — editing a note
      changes the agent on the next session spawn ─────────────────────── */

const FALLBACK_ORCHESTRATOR = `You are JARVIS, Fidel's personal AI assistant —
capable, warm, lightly witty. Use your tools to do real work; confirm what you
did afterwards. Delegate to researcher / coder / vault-librarian via the Agent
tool when useful.`;

function loadAgentNote(name: string, fallback: string): string {
  try {
    const text = fs
      .readFileSync(path.join(CONFIG.vaultPath, 'Agents', `${name}.md`), 'utf8')
      .replace(/^#.*\n/, '')
      .replace(/\*[^*]*agent service[^*]*\*/s, '') // strip the "live persona" note-to-humans
      .trim();
    if (text) return text;
  } catch {
    /* note missing — fallback below */
  }
  return fallback;
}

/* ── operational context appended to the persona ─────────────────────── */

function operationalCore(): string {
  return `

Operational context (from the JARVIS runtime, not editable prose):
- Repo root: ${REPO_ROOT}
- Obsidian vault (your memory — the ONLY vault area you may write): ${CONFIG.vaultPath}
  Folders: Memory/ (durable facts), Tasks/, Context/, Daily/, Agents/, System/.
- Personal notes elsewhere in the vault and the repo .env file are protected;
  writes there will be denied by the runtime.
- The user often speaks by voice; when the message says so, keep replies short
  and speakable.`;
}

/* ── tool → activity mapping (drives the HUD + pixel office) ─────────── */

function describeTool(name: string, input: any): { activity?: Activity; target?: string } {
  const raw = String(
    input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query ?? '',
  );
  const target = raw.length > 90 ? raw.slice(0, 87) + '…' : raw || undefined;
  const inVault = raw.includes('JARVIS VAULT');
  switch (name) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { activity: inVault ? 'vault_write' : 'typing', target };
    case 'Read':
    case 'Glob':
    case 'Grep':
      return { activity: inVault ? 'vault_read' : 'typing', target };
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return { activity: 'terminal', target };
    case 'WebSearch':
    case 'WebFetch':
      return { activity: 'research', target };
    default:
      return { target };
  }
}

/* ── safety guard: JARVIS acts freely EXCEPT where it must never ─────── */

const VAULT_ROOT = path.dirname(CONFIG.vaultPath); // ".../JARVIS VAULT"

function guardTool(
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } {
  const target = String(input?.file_path ?? input?.path ?? '');
  if (target) {
    const p = path.resolve(REPO_ROOT, target);
    const writes = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName);
    if (writes && p.startsWith(VAULT_ROOT + path.sep) && !p.startsWith(CONFIG.vaultPath + path.sep)) {
      return {
        behavior: 'deny',
        message: `Personal vault notes outside ${CONFIG.vaultPath} are protected — JARVIS only writes inside its own folder.`,
      };
    }
    if (writes && path.basename(p) === '.env') {
      return { behavior: 'deny', message: '.env holds secrets and is protected.' };
    }
  }
  if (toolName === 'Bash') {
    const cmd = String(input?.command ?? '');
    if (/\bsudo\b/.test(cmd)) {
      return { behavior: 'deny', message: 'sudo is not permitted.' };
    }
    if (/rm\s+(-[a-zA-Z]*\s+)*(\/|~\/?)(\s|$)/.test(cmd)) {
      return { behavior: 'deny', message: 'Refusing to delete from the filesystem root or home directory.' };
    }
  }
  return { behavior: 'allow', updatedInput: input };
}

/* ── persistent streaming session ─────────────────────────────────────── */

interface Pending {
  resolve: (reply: string) => void;
  reject: (err: Error) => void;
  onEvent?: (e: NewEvent) => void;
  onPartialText?: (text: string) => void;
}

class PersistentSession {
  private inputQueue: (SDKUserMessage | null)[] = [];
  private inputWaiter: (() => void) | null = null;
  private pending: Pending[] = [];
  private replyBuffer = '';
  /** tool_use id of an Agent dispatch → subagent name, for event attribution */
  private subagentCalls = new Map<string, string>();
  dead = false;
  lastUsed = Date.now();

  constructor(readonly id: string) {
    const stream = query({
      prompt: this.inputStream(),
      options: {
        model: CONFIG.model,
        cwd: REPO_ROOT,
        systemPrompt: loadAgentNote('orchestrator', FALLBACK_ORCHESTRATOR) + operationalCore(),
        includePartialMessages: true,
        // Reads and research are auto-approved; writes/bash go through guardTool.
        allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite'],
        canUseTool: async (toolName: string, input: Record<string, unknown>) =>
          guardTool(toolName, input),
        agents: {
          researcher: {
            description:
              'Web research specialist — investigates questions online and reports verified findings with sources.',
            prompt: loadAgentNote('researcher', 'You research questions on the web and report verified findings with sources.'),
            tools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
          },
          coder: {
            description:
              'Software specialist — writes, edits, and runs code and shell commands, verifying results.',
            prompt: loadAgentNote('coder', 'You write, edit and run code in small verified steps.'),
            tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
          },
          'vault-librarian': {
            description:
              "Keeper of the Obsidian vault — reads, writes, and organises notes inside the vault's JARVIS folder only.",
            prompt: loadAgentNote('vault-librarian', 'You manage the Obsidian vault, writing only inside the JARVIS folder.'),
            tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
          },
        },
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
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              !msg.parent_tool_use_id // only the orchestrator's own prose streams to the UI
            ) {
              current?.onPartialText?.(ev.delta.text as string);
            }
            break;
          }

          case 'assistant': {
            const parentId = msg.parent_tool_use_id as string | null;
            const agentId = parentId ? (this.subagentCalls.get(parentId) ?? 'agent') : 'jarvis';
            const blocks: any[] = msg.message?.content ?? [];
            for (const b of blocks) {
              if (b?.type === 'text') {
                if (!parentId && b.text) this.replyBuffer = b.text;
              } else if (b?.type === 'tool_use') {
                if ((b.name === 'Agent' || b.name === 'Task') && b.input?.subagent_type) {
                  const sub = String(b.input.subagent_type);
                  this.subagentCalls.set(b.id, sub);
                  current?.onEvent?.({
                    source: 'orchestrator',
                    agentId: 'jarvis',
                    state: 'working',
                    tool: 'Agent',
                    target: sub,
                    message: String(b.input.description ?? b.input.prompt ?? '').slice(0, 120),
                  });
                  current?.onEvent?.({
                    source: 'agent',
                    agentId: sub,
                    state: 'thinking',
                    message: String(b.input.description ?? '').slice(0, 120),
                  });
                } else {
                  const { activity, target } = describeTool(b.name, b.input);
                  current?.onEvent?.({
                    source: parentId ? 'agent' : 'orchestrator',
                    agentId,
                    state: 'working',
                    activity,
                    tool: b.name,
                    target,
                  });
                }
              }
            }
            break;
          }

          case 'user': {
            // subagent finished when its Agent tool_result comes back
            const blocks = msg.message?.content;
            if (Array.isArray(blocks)) {
              for (const b of blocks) {
                if (b?.type === 'tool_result' && this.subagentCalls.has(b.tool_use_id)) {
                  const sub = this.subagentCalls.get(b.tool_use_id)!;
                  this.subagentCalls.delete(b.tool_use_id);
                  current?.onEvent?.({ source: 'agent', agentId: sub, state: 'done' });
                }
              }
            }
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
                  turns: msg.num_turns,
                  usage: msg.usage,
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

/* ── provider ─────────────────────────────────────────────────────────── */

const KEEP_WARM = new Set(['voice', 'default']);
const IDLE_LIMIT_MS = 10 * 60 * 1000;

export class AgentSdkProvider implements BrainProvider {
  readonly name = 'agent-sdk';
  private sessions = new Map<string, PersistentSession>();

  constructor() {
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

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

    const now = new Date().toLocaleString('en-GB', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const contextNote =
      `\n\n[Context, not written by the user: current local time is ${now}.` +
      (channel === 'voice'
        ? ' The user is speaking by voice and your reply will be read aloud — keep it to a sentence or two of plain speakable prose, no markdown, no lists. If you used tools, briefly confirm what you actually did.'
        : '') +
      ']';

    try {
      return await this.session(sessionId).chat(text + contextNote, { onEvent, onPartialText });
    } catch (err) {
      this.sessions.delete(sessionId);
      onEvent?.({
        source: 'system',
        message: `brain session restarted (${err instanceof Error ? err.message : err})`,
      });
      return await this.session(sessionId).chat(text + contextNote, { onEvent, onPartialText });
    }
  }
}
