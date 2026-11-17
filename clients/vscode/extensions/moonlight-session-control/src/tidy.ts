/**
 * Tidying the session lists: forgetting old sessions in the daemon, hiding them here.
 *
 * The daemon keeps every session it managed in its database, so sessions that ended
 * days ago stay listed. Forget deletes the daemon's record (the transcript stays, and the
 * session comes back only if it works again). Hide is local to this window, and lasts
 * until the session does something.
 *
 * "Does something" means it is working or waiting on the operator — not a newer
 * `last_activity`: a finished turn cooling from waiting to idle bumps that too, and a
 * session hidden just after it finished would pop back two minutes later.
 */
import type { DiscoverableSession } from 'moonlight-control-client';

import type { CustomGroup } from './grouping';

/** Session id → when it was hidden (epoch ms). */
export type HiddenMap = Readonly<Record<string, number>>;

/** Hidden ids kept at most: a list of ids nobody sees should not grow forever. */
export const HIDDEN_CAP = 500;

/** Working, waiting on the operator, or holding an answer: never tidied away. */
export function isLive(session: DiscoverableSession, held: boolean): boolean {
  return held || session.status === 'Running' || session.status === 'WaitingInput';
}

/** Why a session cannot be hidden or forgotten, or `undefined` when it can. */
export function tidyBlocker(session: DiscoverableSession, held: boolean): string | undefined {
  if (held) {
    return 'It is waiting on you: answer it first.';
  }
  if (session.status === 'Running') {
    return 'It is working.';
  }
  if (session.status === 'WaitingInput') {
    return 'It is waiting for input.';
  }
  return undefined;
}

/**
 * The hidden list after the latest poll: a hidden session that is live again is
 * visible again, for good. Ids no longer listed are kept — a daemon restart briefly
 * lists nothing, and that must not unhide everything — up to {@link HIDDEN_CAP}, the
 * oldest dropped first.
 */
export function reconcileHidden(
  hidden: HiddenMap,
  sessions: readonly DiscoverableSession[],
  heldIds: ReadonlySet<string>
): { hidden: HiddenMap; changed: boolean } {
  const byId = new Map(sessions.map((s) => [s.session_id, s]));
  const kept = Object.entries(hidden).filter(([id]) => {
    const session = byId.get(id);
    return !session || !isLive(session, heldIds.has(id));
  });
  const capped = kept.sort((a, b) => b[1] - a[1]).slice(0, HIDDEN_CAP);
  return { hidden: Object.fromEntries(capped), changed: capped.length !== Object.keys(hidden).length };
}

/** Custom groups none of whose sessions is known any more. */
export function emptyGroups(groups: readonly CustomGroup[], sessions: readonly DiscoverableSession[]): CustomGroup[] {
  const known = new Set(sessions.map((s) => s.session_id));
  return groups.filter((g) => !g.sessionIds.some((id) => known.has(id)));
}
