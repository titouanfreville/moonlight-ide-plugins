/**
 * Setting a session's phase on whichever backend governs it.
 *
 * The daemon takes its own phase names over HTTP; the MoonlightCode mod inside Claude
 * Code takes one inbox entry in its names (see `moonlight-core/src/mod-bridge.ts`).
 * Both refuse loudly: a phase change that silently did not happen leaves the operator
 * believing writes are denied (or allowed) when they are not.
 */
import * as controlApi from 'moonlight-control-client';
import type { ModPhase, MoonlightApi } from 'moonlight-core';

const MOD_PHASE: Record<controlApi.Phase, ModPhase> = {
  Plan: 'plan',
  AutoImplement: 'auto',
  Test: 'test',
  Review: 'review',
  Commit: 'commit',
};

const ORDER: readonly controlApi.Phase[] = ['Plan', 'AutoImplement', 'Test', 'Review', 'Commit'];

export function modPhaseOf(phase: controlApi.Phase): ModPhase {
  return MOD_PHASE[phase];
}

/** The phase after `phase`, as the daemon advances it: Commit goes back to Plan. */
export function nextPhase(phase: controlApi.Phase): controlApi.Phase {
  return ORDER[(ORDER.indexOf(phase) + 1) % ORDER.length];
}

export async function setSessionPhase(core: MoonlightApi, sessionId: string, phase: controlApi.Phase): Promise<void> {
  if (core.governor?.(sessionId) === 'mod' && core.sendToMod) {
    const answer = await core.sendToMod(sessionId, { kind: 'phase', to: modPhaseOf(phase) });
    if (!answer.ok) {
      throw new Error(`The Claude Code session did not change phase: ${answer.message}`);
    }
    return;
  }
  await controlApi.setPhase(sessionId, phase);
}

export async function advanceSessionPhase(core: MoonlightApi, session: controlApi.DiscoverableSession): Promise<void> {
  if (core.governor?.(session.session_id) === 'mod') {
    await setSessionPhase(core, session.session_id, nextPhase(session.phase));
    return;
  }
  await controlApi.advancePhase(session.session_id);
}
