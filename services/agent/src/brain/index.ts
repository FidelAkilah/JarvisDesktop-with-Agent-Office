import { CONFIG } from '../env.js';
import type { BrainProvider } from './BrainProvider.js';
import { AgentSdkProvider } from './AgentSdkProvider.js';

export type { BrainProvider, ChatInput } from './BrainProvider.js';

export function createBrain(): BrainProvider {
  switch (CONFIG.brain) {
    case 'agent-sdk':
      return new AgentSdkProvider();
    // case 'api': raw Anthropic API provider — planned fallback, see
    // JARVIS/System/DECISIONS.md in the vault.
    default:
      throw new Error(
        `Unknown JARVIS_BRAIN "${CONFIG.brain}" — valid values: agent-sdk`,
      );
  }
}
