import { query } from '@anthropic-ai/claude-agent-sdk';
import { CONFIG } from '../env.js';
import type { BrainProvider, ChatInput } from './BrainProvider.js';

const PERSONA = `You are JARVIS, Fidel's personal AI assistant — capable, warm, and
lightly witty in the manner of a trusted butler. You run inside the JARVIS desktop
app on his Mac. Answer conversational questions directly and concisely (a sentence
or two unless more is genuinely needed). Do not narrate your reasoning.`;

export class AgentSdkProvider implements BrainProvider {
  readonly name = 'agent-sdk';

  // Our stable sessionId → the SDK's session id, so conversations resume
  // with full context across turns.
  private sdkSessions = new Map<string, string>();

  async chat({ sessionId, text, channel, onEvent, onPartialText }: ChatInput): Promise<string> {
    if (!CONFIG.hasOauthToken) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_TOKEN is missing from .env — run `claude setup-token` ' +
          'in Terminal and paste the sk-ant-oat01-… token into .env (see README).',
      );
    }

    const resume = this.sdkSessions.get(sessionId);
    let reply = '';

    // Ambient context Claude can't know on its own. Appended per message (not
    // the system prompt) so it stays fresh across a long-lived session.
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

    const stream = query({
      prompt: text + contextNote,
      options: {
        model: CONFIG.model,
        systemPrompt: PERSONA,
        // Phase 0 is chat-only. Real tool use (files, terminal, vault, subagents)
        // arrives in Phase 3 with a proper permission handler.
        allowedTools: [],
        maxTurns: 1,
        includePartialMessages: true,
        ...(resume ? { resume } : {}),
      },
    });

    for await (const msg of stream) {
      switch (msg.type) {
        case 'system': {
          if (msg.subtype === 'init') {
            this.sdkSessions.set(sessionId, msg.session_id);
            onEvent?.({
              source: 'orchestrator',
              agentId: 'jarvis',
              state: 'thinking',
              message: `session ${resume ? 'resumed' : 'opened'} · model=${
                (msg as { model?: string }).model ?? CONFIG.model
              }`,
            });
          }
          break;
        }
        case 'stream_event': {
          const ev = (msg as { event?: any }).event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            onPartialText?.(ev.delta.text as string);
          }
          break;
        }
        case 'assistant': {
          const blocks: any[] = (msg as any).message?.content ?? [];
          const textParts = blocks
            .filter((b) => b?.type === 'text')
            .map((b) => b.text as string);
          if (textParts.length > 0) reply = textParts.join('');
          break;
        }
        case 'result': {
          const r = msg as any;
          if (r.subtype === 'success') {
            if (typeof r.result === 'string' && r.result.length > 0) reply = r.result;
            onEvent?.({
              source: 'orchestrator',
              agentId: 'jarvis',
              state: 'done',
              data: {
                costUsd: r.total_cost_usd,
                durationMs: r.duration_ms,
                turns: r.num_turns,
              },
            });
          } else {
            throw new Error(
              `Brain error (${r.subtype})${typeof r.result === 'string' ? `: ${r.result}` : ''}`,
            );
          }
          break;
        }
      }
    }

    return reply;
  }
}
