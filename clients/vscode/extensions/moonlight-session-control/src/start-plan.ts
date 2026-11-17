/**
 * Who will govern a session we start, decided before launching: it changes the launch
 * (the daemon's MCP config, or none) and what follows it (adopting, or nothing to do).
 */
import type { ClaudeModState } from 'moonlight-core';

export type Governor = 'daemon' | 'mod' | 'none';

/**
 * A reachable daemon governs what we start. Without one, the Claude Code plugin governs
 * every session it runs in — when it is installed and enabled. Otherwise nothing does,
 * and the operator should hear so before the session starts, not after.
 */
export function governorFor(backendError: string | undefined, claudeMod: ClaudeModState): Governor {
  if (backendError === undefined) {
    return 'daemon';
  }
  return claudeMod === 'active' ? 'mod' : 'none';
}

/** Where a session runs. */
export type Host = 'terminal' | 'herdr';

/**
 * The host to use, or `ask` to let the operator pick. herdr is offered only while a herdr
 * server runs: a choice that would fail is not a choice.
 */
export function hostFor(setting: string, herdrRunning: boolean): Host | 'ask' | 'herdr-down' {
  if (setting === 'terminal') {
    return 'terminal';
  }
  if (setting === 'herdr') {
    return herdrRunning ? 'herdr' : 'herdr-down';
  }
  return herdrRunning ? 'ask' : 'terminal';
}
