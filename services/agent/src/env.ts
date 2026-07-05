import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

config({ path: path.join(REPO_ROOT, '.env') });

// The Agent SDK's credential precedence puts ANTHROPIC_API_KEY and
// ANTHROPIC_AUTH_TOKEN above the subscription token, and CLAUDE* vars leak in
// when this service is launched from inside another Claude Code session
// (e.g. CLAUDE_EFFORT=xhigh, which massively slows replies). Scrub everything
// Anthropic/Claude-shaped so JARVIS behaves identically no matter what shell
// launched it, then re-inject only its own subscription token from .env.
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE')) {
    delete process.env[key];
  }
}
if (oauthToken) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

export const CONFIG = {
  model: process.env.JARVIS_MODEL ?? 'claude-opus-4-8',
  brain: process.env.JARVIS_BRAIN ?? 'agent-sdk',
  port: Number(process.env.JARVIS_AGENT_PORT ?? 4777),
  vaultPath:
    process.env.JARVIS_VAULT_PATH ??
    path.join(REPO_ROOT, 'JARVIS VAULT', 'JARVIS'),
  hasOauthToken: Boolean(oauthToken),
};
