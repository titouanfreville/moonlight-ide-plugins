/**
 * The row vocabulary of the session lists: what a row says, in which order the rows
 * come, and which badge wins. Pure, so the rules are tested rather than eyeballed —
 * and mirrored by the JetBrains plugin's `Rows.kt`, so both editors read the same.
 */
import * as controlApi from 'moonlight-control-client';
import type { DiscoverableSession, SessionStatus } from 'moonlight-control-client';

/** Phases in workflow order — the order the rail walks, not alphabetical. */
export const PHASES: readonly controlApi.Phase[] = [
  'Plan',
  'AutoImplement',
  'Test',
  'Review',
  'Commit',
];

/** The phase as an operator says it: the daemon's `AutoImplement` is "Auto" everywhere else. */
export function phaseLabel(phase: controlApi.Phase): string {
  return phase === 'AutoImplement' ? 'Auto' : phase;
}

export function isFrozen(phase: controlApi.Phase): boolean {
  return controlApi.FROZEN_PHASES.includes(phase);
}

/**
 * Mirrors `SessionStatus::triage_rank`: what needs you floats to the top.
 * Blocked → errored → review-ready → active → idle.
 */
export function triageRank(status: SessionStatus): number {
  switch (status) {
    case 'WaitingInput':
      return 0;
    case 'Errored':
      return 1;
    case 'Done':
      return 2;
    case 'Running':
      return 3;
    case 'Idle':
      return 4;
    default:
      return 5;
  }
}

/** Mirrors `SessionStatus::badge` — the cockpit's glyph vocabulary. */
export function statusGlyph(status: SessionStatus): string {
  switch (status) {
    case 'Running':
      return '●';
    case 'WaitingInput':
      return '◐';
    case 'Done':
      return '✓';
    case 'Errored':
      return '✕';
    case 'Idle':
      return '○';
    default:
      return '‖';
  }
}

/** Plain words for the status, for the one slot that has room for words. */
export function statusWords(status: SessionStatus): string {
  switch (status) {
    case 'WaitingInput':
      return 'waiting for input';
    case 'Running':
      return 'working';
    case 'Done':
      return 'finished';
    case 'Errored':
      return 'errored';
    case 'Paused':
      return 'paused';
    default:
      return 'idle';
  }
}

/** A hold, as far as a row cares: whether it is a plan. */
export interface RowHold {
  plan: boolean;
}

/**
 * The description: the one fact you would act on.
 *
 * Governed rows lead with the phase, because the phase is what an operator changes —
 * and a frozen phase says so in words, since "Plan" does not look like "cannot write
 * files" to anyone who has not read the docs. Ungoverned rows lead with the absence
 * of a gate, stated as a consequence: "not gated" tells you what is true of the
 * session, where "unadopted" only names our bookkeeping.
 */
export function describe(session: DiscoverableSession, held: RowHold | undefined): string {
  if (!session.adopted) {
    return `not gated, ${statusWords(session.status)}`;
  }
  if (held) {
    return held.plan ? 'Plan waiting on you' : 'Waiting on you';
  }
  return isFrozen(session.phase)
    ? `${phaseLabel(session.phase)}, writes denied`
    : `${phaseLabel(session.phase)}, ${statusWords(session.status)}`;
}

export type BadgeTone = 'held' | 'info' | 'error' | 'muted' | 'normal';

export interface Badge {
  text: string;
  tone: BadgeTone;
}

/**
 * The badge at the end of a row. One glyph and a strict priority, because three things
 * want it: a hold beats an unreviewed count beats the resting status — "what would
 * make you click this row".
 */
export function badge(session: DiscoverableSession, held: boolean): Badge {
  if (held) {
    return { text: '!', tone: 'held' };
  }
  if (session.adopted && session.unreviewed_files > 0) {
    // Saturates rather than growing: a wide badge pushes the description off the row.
    return { text: session.unreviewed_files > 99 ? '99+' : String(session.unreviewed_files), tone: 'info' };
  }
  if (!session.adopted) {
    return { text: statusGlyph(session.status), tone: 'muted' };
  }
  if (session.status === 'Errored') {
    return { text: statusGlyph(session.status), tone: 'error' };
  }
  return { text: statusGlyph(session.status), tone: 'normal' };
}

/** The sessions of one list, worst first. Governed and ungoverned are never mixed. */
export function sessionsFor(
  scope: 'governed' | 'unadopted',
  sessions: readonly DiscoverableSession[]
): DiscoverableSession[] {
  return sessions
    .filter((s) => (scope === 'governed' ? s.adopted : !s.adopted))
    .sort((a, b) => triageRank(a.status) - triageRank(b.status));
}
