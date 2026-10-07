/**
 * A verdict for a session the MoonlightCode mod governs, in the mod's words.
 *
 * The plan panel is the same for both backends; only the delivery differs. The daemon
 * takes a verdict and the composed feedback separately; the mod takes one entry (see
 * `moonlight-core/src/mod-bridge.ts`), with the feedback as its note. The editor's four
 * verdicts become the mod's three, and the feedback keeps the editor's verdict tag, so
 * the agent still reads which of the four it was.
 */
import type { ModEntry } from 'moonlight-core';

import { approves, denialReason, type PlanVerdict } from './feedback';

export function modPlanEntry(
  version: number,
  plan: string,
  comments: ReadonlyMap<number, string>,
  verdict: PlanVerdict
): Extract<ModEntry, { kind: 'plan' }> {
  const note =
    approves(verdict) && comments.size === 0 ? '' : denialReason(plan, comments, verdict);
  return {
    kind: 'plan',
    version,
    verdict: verdict === 'approve' ? 'approve' : verdict === 'no-go' ? 'reject' : 'refine',
    note,
  };
}
