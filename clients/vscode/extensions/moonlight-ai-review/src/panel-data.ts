/**
 * One session's review, in the shape the MoonlightCode sidebar draws (see
 * `ReviewPanelData` in moonlight-core): built here because only this extension knows
 * where a session's review lives, drawn by moonlight-session-control.
 *
 * Pure, so the mapping is tested without an editor.
 */
import * as path from 'path';
import type { ReviewCommentView, ReviewQueueItem } from 'moonlight-control-client';
import type { AiReviewAction, ModEntry, ModReview, ReviewPanelAi, ReviewPanelData } from 'moonlight-core';

import { pendingCounts, sortedFindings } from './mod-review';

export interface PanelDataInput {
  root: string | null;
  /** This session's queue, ignored items included. */
  queue: readonly ReviewQueueItem[];
  comments: readonly ReviewCommentView[];
  isMod: boolean;
  review: ModReview | undefined;
  error?: string;
}

/** Relative to the root when the file is under it: the root is the same on every row. */
export function displayPath(file: string, root: string | null): string {
  if (root && path.isAbsolute(file)) {
    const relative = path.relative(root, file);
    // Outside the root is `..` or `../…`; `..env.local` is a file in it.
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`);
    if (relative && !outside && !path.isAbsolute(relative)) {
      // Always '/': the page splits folder from file name on it, on Windows too.
      return relative.split(path.sep).join('/');
    }
  }
  return file;
}

export function panelData(input: PanelDataInput): ReviewPanelData {
  const { root, queue, comments, isMod, review } = input;
  const modFiles = new Map((review?.files ?? []).map((f) => [f.absolute, f]));
  const files = queue
    .filter((item) => !item.ignored)
    .map((item) => {
      const mod = modFiles.get(item.file_path);
      return {
        path: item.file_path,
        display: displayPath(item.file_path, root),
        status: mod?.status === 'D' ? 'D' : item.created ? 'A' : 'M',
        added: mod?.added,
        removed: mod?.removed,
        // Matched on either spelling: the daemon records the path the session wrote,
        // which can be relative to its root.
        comments: comments.filter(
          (c) => c.parent_id === null && (c.path === item.file_path || (root !== null && path.resolve(root, c.path) === item.file_path))
        ).length,
        fromHead: item.from_head,
      };
    });
  return {
    files,
    ignored: queue.filter((item) => item.ignored).reduce((n, item) => n + (item.ignored_files ?? 1), 0),
    comments: {
      pending: comments.filter((c) => !c.sent && !c.resolved).length,
      resolved: comments.filter((c) => c.resolved).length,
    },
    ai: aiData(isMod, review),
    ...(input.error ? { error: input.error } : {}),
  };
}

function aiData(isMod: boolean, review: ModReview | undefined): ReviewPanelAi {
  if (!isMod) {
    return { kind: 'daemon' };
  }
  if (!review) {
    return { kind: 'stale' };
  }
  const counts = pendingCounts(review);
  return {
    kind: 'mod',
    scope: review.scope,
    run: review.run,
    skills: review.skills,
    status: review.findingsStatus,
    findings: sortedFindings(review.findings),
    kept: counts.kept,
    dismissed: counts.dismissed,
    comments: counts.comments,
  };
}

/** The mod's inbox entry for one sidebar decision. */
export function aiEntry(action: AiReviewAction): ModEntry {
  switch (action.type) {
    case 'run':
      return { kind: 'review-run', skill: action.skill };
    case 'cancel':
      return { kind: 'review-cancel' };
    case 'scope':
      return { kind: 'review-scope', scope: action.scope };
    case 'decide':
      return { kind: 'finding', id: action.id, decision: action.decision };
    // A note keeps the finding: it is what the agent is asked to act on.
    case 'note':
      return { kind: 'finding', id: action.id, decision: 'keep', note: action.text };
    case 'submit':
      return { kind: 'review-submit' };
    case 'accept':
      return { kind: 'review-accept' };
    default:
      // Never an entry the mod cannot read: the sidebar checks actions, this is the backstop.
      throw new Error(`Unknown AI review action: ${String((action as { type?: unknown }).type)}`);
  }
}
