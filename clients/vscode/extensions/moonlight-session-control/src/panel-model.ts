/**
 * What the MoonlightCode sidebar shows, computed in the extension and drawn by the
 * webview (`media/panel.js`). The webview only renders: every rule — which list a
 * session is in, what its row says, which session the review tabs are about — is
 * here, pure, and tested.
 */
import * as controlApi from 'moonlight-control-client';
import type { DiscoverableSession } from 'moonlight-control-client';
import type { ClaudeModState, HeldApproval, ReviewPanelData } from 'moonlight-core';

import { effectiveMode, groupSessions, type CustomGroup, type GroupBy } from './grouping';
import { badge, describe, isFrozen, phaseLabel, PHASES, sessionsFor, statusGlyph, type Badge } from './rows';

export type Tab = 'sessions' | 'review' | 'ai';

export interface PanelInput {
  sessions: readonly DiscoverableSession[];
  holds: readonly HeldApproval[];
  backendError: string | undefined;
  claudeMod: ClaudeModState;
  following: string | undefined;
  groupBy: GroupBy;
  groups: readonly CustomGroup[];
  tab: Tab;
  selected: string | undefined;
  /** The review of {@link reviewTarget}, when moonlight-ai-review answered for it. */
  review: ReviewPanelData | undefined;
  /** Whether moonlight-ai-review is installed: without it the review tabs only say so. */
  reviewInstalled: boolean;
  colorBlind: boolean;
}

export interface RowModel {
  id: string;
  name: string;
  glyph: string;
  description: string;
  badge: Badge;
  /** The five phases, for the small track on a governed row. */
  phaseIndex: number | undefined;
  frozen: boolean;
  held: boolean;
  following: boolean;
  tooltip: string;
}

export interface GroupModel {
  key: string;
  label: string;
  /** Only a custom group can be renamed or deleted: a project group is derived. */
  customId: string | undefined;
  rows: RowModel[];
}

export interface PhaseStep {
  phase: controlApi.Phase;
  label: string;
  frozen: boolean;
}

export interface HoldModel {
  sessionId: string;
  name: string;
  plan: boolean;
  /** The plan's first heading, or what the gate is asking. */
  what: string;
}

export interface DetailModel {
  id: string;
  name: string;
  meta: string;
  adopted: boolean;
  phaseIndex: number;
  frozen: boolean;
  following: boolean;
  hold: HoldModel | undefined;
  /** The custom group the session is in, so "Remove from group" can say which. */
  groupName: string | undefined;
  unreviewed: number;
}

export interface PanelModel {
  tab: Tab;
  colorBlind: boolean;
  gate: { tone: 'ok' | 'mod' | 'down'; text: string };
  holds: HoldModel[];
  counts: { held: number; review: number; ai: number };
  phases: PhaseStep[];
  governed: GroupModel[];
  governedCount: number;
  /** Why the governed list is empty, when it is. */
  governedEmpty: 'backend-down' | 'no-sessions' | 'none-governed' | undefined;
  /** Whether the Claude Code plugin can be offered as the fix for a missing daemon. */
  offerMod: boolean;
  unadopted: RowModel[];
  detail: DetailModel | undefined;
  /** The session the Review and AI review tabs are about. */
  target: DetailModel | undefined;
  /** Governed sessions, for the review tabs' picker. */
  picker: { id: string; name: string }[];
  review: ReviewPanelData | undefined;
  reviewInstalled: boolean;
}

/** The review tabs' data when moonlight-ai-review could not answer: both tabs say why. */
export function reviewFailure(error: string): ReviewPanelData {
  return { files: [], ignored: 0, comments: { pending: 0, resolved: 0 }, ai: { kind: 'stale' }, error };
}

/** The first Markdown heading of a plan: its title, as the agent wrote it. */
export function planTitle(markdown: string | undefined): string | undefined {
  const heading = markdown?.split('\n').find((line) => /^#{1,3}\s+\S/.test(line));
  return heading?.replace(/^#{1,3}\s+/, '').trim();
}

/**
 * The session the review tabs work on: the one picked in Sessions when it is governed,
 * else the worst governed one — what the operator would most likely review next.
 */
export function reviewTarget(
  sessions: readonly DiscoverableSession[],
  selected: string | undefined
): DiscoverableSession | undefined {
  const picked = sessions.find((s) => s.session_id === selected && s.adopted);
  return picked ?? sessionsFor('governed', sessions)[0];
}

function row(
  session: DiscoverableSession,
  among: readonly DiscoverableSession[],
  hold: HeldApproval | undefined,
  following: boolean
): RowModel {
  const name = controlApi.sessionLabel(session, among);
  const tooltip = [
    name,
    session.adopted
      ? `Phase ${phaseLabel(session.phase)}${isFrozen(session.phase) ? ': project writes denied' : ''}`
      : 'Not adopted: the gate allows this session everything',
    `Status: ${session.status}`,
    ...(session.unreviewed_files > 0 ? [`${session.unreviewed_files} file(s) written, none reviewed`] : []),
    ...(session.root ? [`Root: ${session.root}`] : []),
    `Id: ${session.session_id}`,
    ...(following ? ['The status bar follows this session.'] : []),
  ].join('\n');
  return {
    id: session.session_id,
    name,
    glyph: statusGlyph(session.status),
    description: describe(session, hold ? { plan: hold.plan !== undefined } : undefined),
    badge: badge(session, hold !== undefined),
    phaseIndex: session.adopted ? PHASES.indexOf(session.phase) : undefined,
    frozen: session.adopted && isFrozen(session.phase),
    held: hold !== undefined,
    following,
    tooltip,
  };
}

function holdModel(hold: HeldApproval, sessions: readonly DiscoverableSession[]): HoldModel {
  const session = sessions.find((s) => s.session_id === hold.sessionId);
  return {
    sessionId: hold.sessionId,
    name: session ? controlApi.sessionLabel(session, sessions) : controlApi.shortId(hold.sessionId),
    plan: hold.plan !== undefined,
    what: (hold.plan !== undefined ? planTitle(hold.plan) : undefined) ?? hold.what,
  };
}

function detail(
  session: DiscoverableSession,
  input: PanelInput,
  holds: ReadonlyMap<string, HeldApproval>
): DetailModel {
  const hold = holds.get(session.session_id);
  return {
    id: session.session_id,
    name: controlApi.sessionLabel(session, input.sessions),
    meta: controlApi.shortId(session.session_id),
    adopted: session.adopted,
    phaseIndex: PHASES.indexOf(session.phase),
    frozen: isFrozen(session.phase),
    following: input.following === session.session_id,
    hold: hold ? holdModel(hold, input.sessions) : undefined,
    groupName: input.groups.find((g) => g.sessionIds.includes(session.session_id))?.name,
    unreviewed: session.unreviewed_files,
  };
}

export function panelModel(input: PanelInput): PanelModel {
  const holds = new Map(input.holds.map((h) => [h.sessionId, h]));
  const governedSessions = sessionsFor('governed', input.sessions);
  const unadoptedSessions = sessionsFor('unadopted', input.sessions);
  const rowOf = (s: DiscoverableSession, among: readonly DiscoverableSession[]) =>
    row(s, among, holds.get(s.session_id), input.following === s.session_id);

  const grouping = groupSessions(governedSessions, effectiveMode('governed', input.groupBy), input.groups);
  const governed: GroupModel[] =
    grouping.kind === 'flat'
      ? [{ key: 'all', label: '', customId: undefined, rows: grouping.sessions.map((s) => rowOf(s, governedSessions)) }]
      : grouping.groups.map((g) => ({
          key: g.key,
          label: g.label,
          customId: g.custom ? g.key.slice('custom:'.length) : undefined,
          rows: g.sessions.map((s) => rowOf(s, governedSessions)),
        }));

  const down = input.backendError !== undefined;
  const gate: PanelModel['gate'] = !down
    ? { tone: 'ok', text: 'Gated by the MoonlightCode daemon' }
    : input.claudeMod === 'active'
      ? { tone: 'mod', text: 'No daemon. The Claude Code plugin gates new sessions.' }
      : { tone: 'down', text: 'No backend. Sessions run ungated.' };

  const selectedSession = input.sessions.find((s) => s.session_id === input.selected);
  const target = reviewTarget(input.sessions, input.selected);
  const review = input.review;
  const aiCount = review?.ai.kind === 'mod' ? review.ai.findings.length - review.ai.dismissed : 0;

  return {
    tab: input.tab,
    colorBlind: input.colorBlind,
    gate,
    holds: input.holds.map((h) => holdModel(h, input.sessions)),
    counts: {
      held: input.holds.length,
      review: review ? review.files.length : (target?.unreviewed_files ?? 0),
      ai: aiCount,
    },
    phases: PHASES.map((phase) => ({ phase, label: phaseLabel(phase), frozen: isFrozen(phase) })),
    governed: governed.filter((g) => g.rows.length > 0 || g.customId !== undefined),
    governedCount: governedSessions.length,
    governedEmpty:
      governedSessions.length > 0
        ? undefined
        : down && input.sessions.length === 0
          ? 'backend-down'
          : input.sessions.length === 0
            ? 'no-sessions'
            : 'none-governed',
    offerMod: down && input.claudeMod !== 'active',
    unadopted: unadoptedSessions.map((s) => rowOf(s, unadoptedSessions)),
    detail: selectedSession ? detail(selectedSession, input, holds) : undefined,
    target: target ? detail(target, input, holds) : undefined,
    picker: governedSessions.map((s) => ({ id: s.session_id, name: controlApi.sessionLabel(s, governedSessions) })),
    review,
    reviewInstalled: input.reviewInstalled,
  };
}
