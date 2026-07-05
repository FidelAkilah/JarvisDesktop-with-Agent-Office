import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

config({ path: path.join(REPO_ROOT, '.env') });

// The Agent SDK's credential precedence puts ANTHROPIC_API_KEY and
// ANTHROPIC_AUTH_TOKEN above the subscription token, and ANTHROPIC_BASE_URL /
// CLAUDE_CODE_* leak in when this service is launched from inside another
// Claude Code session. Scrub them all so JARVIS always authenticates with the
// Max-subscription CLAUDE_CODE_OAUTH_TOKEN from .env — never API-key billing.
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('ANTHROPIC_') ||
    key.startsWith('CLAUDE_CODE_') ||
    key === 'CLAUDECODE'
  ) {
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
