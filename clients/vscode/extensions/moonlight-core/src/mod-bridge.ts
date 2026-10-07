/**
 * The sessions the MoonlightCode mod for Claude Code governs, for the same panels the
 * daemon's sessions use.
 *
 * The mod cannot listen, so it and the editor meet in files, per session, under
 * `~/.moonlight/mod/sessions/<id>/` (the format is the mod's `hooks/bridge.ts`):
 *
 * - `state.json` — what the mod shows: phase, the phase request waiting, the latest plan;
 * - `heartbeat` — touched every two seconds while the session lives;
 * - `inbox/<entry>.json` — one operator decision, written here;
 * - `outbox/<entry>.json` — the mod's answer, read here; then both files are removed.
 *
 * The agent cannot forge a decision: the mod refuses its writes under `~/.moonlight`.
 *
 * Everything that decides is pure; the file I/O sits at the bottom.
 */
import * as fs from 'fs';
import * as path from 'path';

import { PLAN_HOLD, type DiscoverableSession, type Phase } from 'moonlight-control-client';

import type { HeldApproval } from './api';

export const BRIDGE_VERSION = 1;

/** A session whose heartbeat is older than this has no mod behind it any more. */
export const HEARTBEAT_STALE_MS = 10_000;

export type ModPhase = 'plan' | 'auto' | 'test' | 'review' | 'commit';
export type ModPlanVerdict = 'approve' | 'refine' | 'reject';

/** A file the mod has under review: `baseline` is its saved copy, `/dev/null` for a created file, absent against HEAD. */
export interface ModReviewFile {
  path: string;
  absolute: string;
  status: string;
  added: number;
  removed: number;
  baseline?: string;
  skipped?: string;
}

export interface ModReviewComment {
  id: string;
  path: string;
  side: 'before' | 'after';
  start: number;
  end: number;
  body: string;
  excerpt?: string;
}

export interface ModFinding {
  id: string;
  key: string;
  severity: 'high' | 'medium' | 'low';
  route: 'patch' | 'decision' | 'defer';
  owner: string[];
  file: string;
  line: number;
  summary: string;
  detail: string;
  fix?: string;
  decision: 'keep' | 'dismiss';
  note?: string;
}

/** The mod's review, as its Review panel holds it. */
export interface ModReview {
  scope: 'session' | 'head';
  files: ModReviewFile[];
  comments: ModReviewComment[];
  findings: ModFinding[];
  findingsStatus: string | null;
  /** The AI review running, if any. */
  run: { skill: string } | null;
  /** The review skills this session can run. */
  skills: string[];
}

export interface ModState {
  v: number;
  sessionId: string;
  root: string | null;
  phase: ModPhase;
  pending: { to: ModPhase; reason: string } | null;
  plan: { version: number; title: string; markdown: string; decided?: ModPlanVerdict } | null;
  /** Absent from a mod that predates the review bridge. */
  review?: ModReview;
  updatedMs: number;
}

/** One operator decision, as the mod reads it. */
export type ModEntry =
  | { kind: 'phase'; to: ModPhase }
  | { kind: 'request'; approve: boolean; reason?: string }
  | { kind: 'plan'; version: number; verdict: ModPlanVerdict; note: string }
  | { kind: 'review-comment'; path: string; side: 'before' | 'after'; start: number; end: number; body: string; excerpt?: string }
  | { kind: 'review-comment-edit'; id: string; body: string }
  | { kind: 'review-uncomment'; id: string }
  | { kind: 'review-submit'; summary?: string }
  | { kind: 'review-accept' }
  | { kind: 'review-accept-file'; path: string }
  | { kind: 'review-run'; skill: string }
  | { kind: 'review-cancel' }
  | { kind: 'review-scope'; scope: 'session' | 'head' }
  | { kind: 'finding'; id: string; decision: 'keep' | 'dismiss'; note?: string };

export interface ModAnswer {
  ok: boolean;
  message: string;
}

const TO_DAEMON: Record<ModPhase, Phase> = {
  plan: 'Plan',
  auto: 'AutoImplement',
  test: 'Test',
  review: 'Review',
  commit: 'Commit',
};

/** The daemon's phase names, which every panel speaks, for the mod's. */
export function daemonPhase(phase: ModPhase): Phase {
  return TO_DAEMON[phase];
}

export function modPhase(phase: Phase): ModPhase {
  return (Object.keys(TO_DAEMON) as ModPhase[]).find((p) => TO_DAEMON[p] === phase) ?? 'plan';
}

/** A `state.json`, or `undefined` for one this editor cannot read (another version, a torn write). */
export function parseModState(text: string): ModState | undefined {
  try {
    const s = JSON.parse(text) as ModState;
    if (s.v !== BRIDGE_VERSION || typeof s.sessionId !== 'string' || !(s.phase in TO_DAEMON)) {
      return undefined;
    }
    return s;
  } catch {
    return undefined;
  }
}

/** A mod session as the session lists show it: governed, so adopted; waiting when it holds. */
export function modSession(state: ModState): DiscoverableSession {
  const holds = state.pending !== null || (state.plan !== null && state.plan.decided === undefined);
  return {
    session_id: state.sessionId,
    title: state.root ? `${path.basename(state.root)} (Claude Code plugin)` : 'Claude Code plugin',
    root: state.root,
    adopted: true,
    status: holds ? 'WaitingInput' : 'Running',
    phase: daemonPhase(state.phase),
    unreviewed_files: 0,
  };
}

/**
 * What the session waits on, as the panels already show a daemon hold: the plan first
 * (a plan hold opens the plan panel), else the phase request.
 */
export function modHold(state: ModState, sinceMs: number): HeldApproval | undefined {
  if (state.plan !== null && state.plan.decided === undefined) {
    return {
      sessionId: state.sessionId,
      what: PLAN_HOLD,
      plan: state.plan.markdown,
      mcpTool: undefined,
      sinceMs,
      planVersion: state.plan.version,
    };
  }
  if (state.pending !== null) {
    const why = state.pending.reason.trim();
    return {
      sessionId: state.sessionId,
      what: `phase change to ${daemonPhase(state.pending.to)}${why ? `: ${why}` : ''}`,
      plan: undefined,
      mcpTool: undefined,
      sinceMs,
    };
  }
  return undefined;
}

/**
 * The editor's four plan verdicts, in the mod's three: a question and a revision both
 * send the plan back; a no-go rejects it. The feedback text carries the editor's own
 * verdict tag, so the agent still reads which of the four it was.
 */
export function modVerdict(verdict: 'approve' | 'open-question' | 'refine' | 'no-go'): ModPlanVerdict {
  return verdict === 'approve' ? 'approve' : verdict === 'no-go' ? 'reject' : 'refine';
}

/** An entry file's name: sorts by time, so the mod applies decisions in order. */
export function entryName(now: number, random: string): string {
  return `${now.toString().padStart(15, '0')}-${random.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}.json`;
}

export function parseAnswer(text: string): ModAnswer | undefined {
  try {
    const a = JSON.parse(text) as { ok?: unknown; message?: unknown };
    return typeof a.ok === 'boolean' ? { ok: a.ok, message: typeof a.message === 'string' ? a.message : '' } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Every session a live mod governs, read from `dir`. */
export function readModStates(dir: string, now: number): ModState[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const states: ModState[] = [];
  for (const name of names) {
    const folder = path.join(dir, name);
    try {
      if (now - fs.statSync(path.join(folder, 'heartbeat')).mtimeMs > HEARTBEAT_STALE_MS) {
        continue;
      }
      const state = parseModState(fs.readFileSync(path.join(folder, 'state.json'), 'utf8'));
      if (state && state.sessionId === name) {
        states.push(state);
      }
    } catch {
      // No heartbeat or no state: not a session the mod governs now.
    }
  }
  return states;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hands one decision to the mod and waits for its answer (it reads its inbox every two
 * seconds). An entry it has not taken by the deadline is withdrawn, so it can never
 * apply later behind the operator's back; an answer that lands meanwhile still counts.
 */
export async function sendToMod(
  dir: string,
  sessionId: string,
  entry: ModEntry,
  timeoutMs = 10_000
): Promise<ModAnswer> {
  const folder = path.join(dir, sessionId);
  const name = entryName(Date.now(), Math.random().toString(36).slice(2));
  const inbox = path.join(folder, 'inbox', name);
  const outbox = path.join(folder, 'outbox', name);
  fs.mkdirSync(path.dirname(inbox), { recursive: true });
  // Whole or not at all: the mod must never read half a decision.
  fs.writeFileSync(`${inbox}.tmp`, JSON.stringify({ v: BRIDGE_VERSION, ...entry }));
  fs.renameSync(`${inbox}.tmp`, inbox);
  const take = (): ModAnswer | undefined => {
    try {
      const answer = parseAnswer(fs.readFileSync(outbox, 'utf8'));
      if (answer) {
        fs.rmSync(inbox, { force: true });
        fs.rmSync(outbox, { force: true });
      }
      return answer;
    } catch {
      return undefined;
    }
  };
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    const answer = take();
    if (answer) {
      return answer;
    }
  }
  fs.rmSync(inbox, { force: true });
  return (
    take() ?? {
      ok: false,
      message: 'the Claude Code session did not answer in time (is it still running?). Nothing was applied.',
    }
  );
}
