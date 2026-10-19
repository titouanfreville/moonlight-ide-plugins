/**
 * What the sidebar page's messages turn into: the command each click runs, with which
 * arguments. Pure, so the routing is tested without a webview; `panel-view.ts` only
 * executes what this returns.
 */
import type { DiscoverableSession, Phase } from 'moonlight-control-client';
import type { AiReviewAction } from 'moonlight-core';

import type { Tab } from './panel-model';
import { PHASES } from './rows';

export type Inbound =
  | { type: 'ready' }
  | { type: 'tab'; tab: Tab }
  | { type: 'select'; id: string }
  | { type: 'phase'; id: string; phase: string }
  | { type: 'next'; id: string }
  | { type: 'command'; command: string; id?: string; groupId?: string }
  | { type: 'openFile'; id: string; path: string }
  | { type: 'acceptFile'; id: string; path: string }
  | { type: 'commentFile'; id: string; path: string }
  | { type: 'ai'; id: string; action: AiReviewAction }
  | { type: 'openFinding'; id: string; file: string; line: number };

/** The node shape session commands take — what a tree row used to hand them. */
interface SessionNode {
  kind: 'session';
  session: DiscoverableSession;
}

export function sessionNode(session: DiscoverableSession): SessionNode {
  return { kind: 'session', session };
}

/** The session a command was invoked on, or `undefined` when it came from the palette. */
export function nodeSession(node: unknown): DiscoverableSession | undefined {
  const candidate = node as SessionNode | undefined;
  return candidate?.kind === 'session' ? candidate.session : undefined;
}

/** A custom group, in the node shape the group commands take. */
function groupNode(groupId: string): unknown {
  return { kind: 'group', group: { key: `custom:${groupId}`, custom: true } };
}

/**
 * Commands the webview may run with a session, and nothing else. A message carries a
 * command name, so the list is closed rather than trusting what the page asks for.
 */
const SESSION_COMMANDS: Record<string, string> = {
  adopt: 'moonlight.sessions.adopt',
  follow: 'moonlight.sessions.setActive',
  addToGroup: 'moonlight.sessions.addToGroup',
  removeFromGroup: 'moonlight.sessions.removeFromGroup',
};

const PLAIN_COMMANDS: Record<string, string> = {
  startSession: 'moonlight.sessionControl.startSession',
  refresh: 'moonlight.sessions.refresh',
  createGroup: 'moonlight.sessions.createGroup',
  installMod: 'moonlight.core.installClaudeMod',
  reviewPlan: 'moonlight.sessions.reviewPlan',
  answerHold: 'moonlight.sessions.answerHold',
};

/** Own keys only: `toString` is in every object, and is not a command. */
const lookup = (table: Record<string, string>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

export interface Route {
  command: string;
  args: unknown[];
}

/**
 * The command a click runs. `session` is the session the message names, when it exists;
 * `undefined` means the message runs nothing (unknown, or about a session gone since).
 */
export function routeOf(m: Inbound, session: DiscoverableSession | undefined): Route | undefined {
  switch (m.type) {
    case 'command': {
      const withSession = lookup(SESSION_COMMANDS, m.command);
      if (withSession) {
        return session ? { command: withSession, args: [sessionNode(session)] } : undefined;
      }
      if (m.command === 'renameGroup' || m.command === 'deleteGroup') {
        return m.groupId ? { command: `moonlight.sessions.${m.command}`, args: [groupNode(m.groupId)] } : undefined;
      }
      if (m.command === 'openReview' || m.command === 'submitReview') {
        const command = m.command === 'openReview' ? 'moonlight.review.openSession' : 'moonlight.review.submit';
        return m.id ? { command, args: [m.id] } : undefined;
      }
      const plain = lookup(PLAIN_COMMANDS, m.command);
      if (!plain) {
        return undefined;
      }
      // A hold names its session: answer that one, not whichever agentic-support would pick.
      const holdOf = (m.command === 'reviewPlan' || m.command === 'answerHold') && m.id ? [m.id] : [];
      return { command: plain, args: holdOf };
    }
    case 'openFile':
      return { command: 'moonlight.review.openFile', args: [m.id, m.path] };
    case 'acceptFile':
      return { command: 'moonlight.review.acceptFile', args: [m.id, m.path] };
    case 'commentFile':
      return { command: 'moonlight.review.commentOnQueuedFile', args: [m.id, m.path] };
    case 'ai':
      return isAiAction(m.action) ? { command: 'moonlight.review.aiAction', args: [m.id, m.action] } : undefined;
    case 'openFinding':
      return { command: 'moonlight.review.openFinding', args: [m.id, m.file, m.line] };
    default:
      return undefined;
  }
}

/**
 * The phase a rail click moves the session to, or `undefined` for no move: an unknown
 * phase, a session gone since, or the current phase — clicking the lit disc would pin it
 * and stop auto-advance, which nobody means by it.
 */
export function phaseMove(phase: string, session: DiscoverableSession | undefined): Phase | undefined {
  const known = PHASES.find((p) => p === phase);
  return known && session && session.phase !== known ? known : undefined;
}

/**
 * An AI review decision as the page may send it, checked at runtime: the message crosses
 * from the webview, and the mod writes what it receives into its inbox. Unknown kinds and
 * out-of-range values are dropped rather than forwarded.
 */
export function isAiAction(action: unknown): action is AiReviewAction {
  if (typeof action !== 'object' || action === null) {
    return false;
  }
  const a = action as Record<string, unknown>;
  const text = (v: unknown): boolean => typeof v === 'string';
  switch (a.type) {
    case 'cancel':
    case 'submit':
    case 'accept':
      return true;
    case 'run':
      return text(a.skill);
    case 'scope':
      return a.scope === 'session' || a.scope === 'head';
    case 'decide':
      return text(a.id) && (a.decision === 'keep' || a.decision === 'dismiss');
    case 'note':
      return text(a.id) && text(a.text);
    default:
      return false;
  }
}

/** The tabs a message may switch to: the saved state must never hold anything else. */
export function isTab(tab: unknown): tab is Tab {
  return tab === 'sessions' || tab === 'review' || tab === 'ai';
}
