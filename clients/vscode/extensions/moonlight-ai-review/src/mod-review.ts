/**
 * A session the MoonlightCode mod for Claude Code governs, in the shapes the review
 * panel already speaks (the daemon's): queue items, comment views, baselines.
 *
 * The mod publishes its review in `state.json` (see `moonlight-core/src/mod-bridge.ts`):
 * the files under review with their saved copies, its comments, its AI review findings.
 * Pure, so the mapping is tested without an editor.
 */
import type { BaselineView, ReviewCommentView, ReviewQueueItem } from 'moonlight-control-client';
import type { ModEntry, ModFinding, ModReview, ModReviewFile } from 'moonlight-core';

/** The mod's files, as queue items: diffs are never inlined (the editor opens them). */
export function modQueueItems(sessionId: string, title: string | null, review: ModReview): ReviewQueueItem[] {
  return review.files
    .filter((f) => f.skipped === undefined)
    .map((f) => ({
      session_id: sessionId,
      session_title: title,
      file_path: f.absolute,
      touches: 1,
      tool: 'Edit',
      created: f.baseline === '/dev/null' || f.status === 'A' || f.status === '??',
      from_head: f.baseline === undefined,
      diff: '',
      diff_omitted: true,
    }));
}

/** The file under review at an absolute path, as the editor names it. */
export function modFileAt(review: ModReview, absolute: string): ModReviewFile | undefined {
  return review.files.find((f) => f.absolute === absolute);
}

/**
 * Where the before side comes from: the saved copy, nothing (a created file), or the
 * last commit. The reading is the caller's: this only says which.
 */
export type ModBaselineSource =
  | { kind: 'copy'; path: string }
  | { kind: 'created' }
  | { kind: 'head'; absolute: string }
  | { kind: 'unavailable'; reason: string };

export function modBaselineSource(file: ModReviewFile | undefined): ModBaselineSource {
  if (!file) {
    return { kind: 'unavailable', reason: 'the file is no longer under review' };
  }
  if (file.baseline === '/dev/null') {
    return { kind: 'created' };
  }
  return file.baseline !== undefined ? { kind: 'copy', path: file.baseline } : { kind: 'head', absolute: file.absolute };
}

/** The view a source resolves to, read text in hand. */
export function modBaselineView(source: ModBaselineSource, text: string | undefined): BaselineView {
  switch (source.kind) {
    case 'created':
      return { kind: 'created' };
    case 'unavailable':
      return source;
    case 'copy':
      return text === undefined ? { kind: 'unavailable', reason: 'the saved copy is gone' } : { kind: 'content', text };
    case 'head':
      // Not in the last commit: an untracked file, new as far as git knows.
      return text === undefined ? { kind: 'created' } : { kind: 'from_head', text };
  }
}

/**
 * The mod's comments as daemon comment views: one thread each (the mod keeps no
 * replies), never sent (a submitted comment leaves the mod's list), never resolved.
 */
export function modCommentViews(review: ModReview): ReviewCommentView[] {
  return review.comments.flatMap((c) => {
    const file = review.files.find((f) => f.path === c.path);
    if (!file) {
      return [];
    }
    return [
      {
        id: c.id,
        scope: 'Line',
        path: file.absolute,
        side: c.side === 'before' ? 'Before' : 'After',
        start_line: c.start,
        end_line: c.end,
        body: c.body,
        anchor_text: c.excerpt ?? null,
        sent: false,
        resolved: false,
        outdated: false,
        author: 'Operator',
        parent_id: null,
      },
    ];
  });
}

/**
 * A new comment, as the mod takes it. The mod anchors every comment to lines: a
 * file-wide one sits on line 1 of the side and says it is about the whole file.
 */
export function modCommentEntry(
  review: ModReview,
  input: { path: string; side: 'Before' | 'After'; startLine: number; endLine: number; body: string; anchorText?: string }
): ModEntry | { error: string } {
  const file = modFileAt(review, input.path);
  if (!file) {
    return { error: 'this file is not under review in that session' };
  }
  // Checked here: the file-wide prefix would get an empty comment past the mod's own check.
  if (input.body.trim() === '') {
    return { error: 'a comment needs some text' };
  }
  const isFileWide = input.startLine < 1;
  return {
    kind: 'review-comment',
    path: file.path,
    side: input.side === 'Before' ? 'before' : 'after',
    start: isFileWide ? 1 : input.startLine,
    end: isFileWide ? 1 : Math.max(input.endLine, input.startLine),
    body: isFileWide ? `(About the whole file) ${input.body}` : input.body,
    ...(input.anchorText && !isFileWide ? { excerpt: input.anchorText } : {}),
  };
}

const RANK: Record<ModFinding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Worst first, then by place: the order a reviewer reads them. */
export function sortedFindings(findings: readonly ModFinding[]): ModFinding[] {
  return [...findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line
  );
}

/** What Submit would send: the comments, and the findings kept. */
export function pendingCounts(review: ModReview): { comments: number; kept: number; dismissed: number } {
  return {
    comments: review.comments.length,
    kept: review.findings.filter((f) => f.decision === 'keep').length,
    dismissed: review.findings.filter((f) => f.decision === 'dismiss').length,
  };
}
