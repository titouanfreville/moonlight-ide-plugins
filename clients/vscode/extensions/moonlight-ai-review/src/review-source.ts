/**
 * The review calls of this extension, on whichever backend governs the session: the
 * daemon (its control API), or the MoonlightCode mod inside Claude Code (its review in
 * `state.json`, its decisions through the inbox; see `mod-review.ts`).
 *
 * Same names and shapes as `moonlight-control-client`'s review functions, so the
 * panel code only swaps `controlApi.x` for `source.x`.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as controlApi from 'moonlight-control-client';
import type { ModEntry, MoonlightApi } from 'moonlight-core';

import { modBaselineSource, modBaselineView, modCommentEntry, modCommentViews, modFileAt, modQueueItems } from './mod-review';

let core: MoonlightApi | undefined;

/** Called once core is known: until then every session is the daemon's. */
export function setReviewCore(api: MoonlightApi | undefined): void {
  core = api;
}

export function isModSession(sessionId: string): boolean {
  return core?.governor?.(sessionId) === 'mod';
}

const modReviewOf = (sessionId: string) => core?.modReview?.(sessionId);

const NOT_FOR_MOD = 'not available for sessions the Claude Code plugin governs';

async function send(sessionId: string, entry: ModEntry): Promise<string> {
  if (!core?.sendToMod) {
    throw new Error('MoonlightCode Core is too old to reach the Claude Code plugin: update the extensions together.');
  }
  const answer = await core.sendToMod(sessionId, entry);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.message;
}

/** Every session the mod governs that has a review, as queue items. */
function modQueue(opts: { session?: string; path?: string }): controlApi.ReviewQueueItem[] {
  const sessions = (core?.sessions() ?? []).filter((s) => isModSession(s.session_id));
  return sessions.flatMap((s) => {
    const review = modReviewOf(s.session_id);
    return review ? modQueueItems(s.session_id, s.title, review) : [];
  }).filter((i) => (!opts.session || i.session_id === opts.session) && (!opts.path || i.file_path === opts.path));
}

export async function reviewQueue(
  opts: { session?: string; path?: string; diffs?: boolean } = {}
): Promise<controlApi.ReviewQueueItem[]> {
  const fromMod = modQueue(opts);
  if (opts.session && isModSession(opts.session)) {
    return fromMod;
  }
  try {
    return [...(await controlApi.reviewQueue(opts)), ...fromMod];
  } catch (err) {
    // No daemon: the mod's sessions are still reviewable. With none, say why.
    if (fromMod.length > 0 || (core?.sessions() ?? []).some((s) => isModSession(s.session_id))) {
      return fromMod;
    }
    throw err;
  }
}

function gitShowHead(absolute: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['show', `HEAD:./${path.basename(absolute)}`],
      { cwd: path.dirname(absolute), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout)
    );
  });
}

export async function baseline(sessionId: string, filePath: string): Promise<controlApi.BaselineView> {
  const review = modReviewOf(sessionId);
  if (!isModSession(sessionId) || !review) {
    return controlApi.baseline(sessionId, filePath);
  }
  const source = modBaselineSource(modFileAt(review, filePath));
  const text =
    source.kind === 'copy'
      ? await fs.promises.readFile(source.path, 'utf8').catch(() => undefined)
      : source.kind === 'head'
        ? await gitShowHead(source.absolute)
        : undefined;
  return modBaselineView(source, text);
}

export async function comments(sessionId: string): Promise<controlApi.ReviewCommentView[]> {
  if (!isModSession(sessionId)) {
    return controlApi.comments(sessionId);
  }
  const review = modReviewOf(sessionId);
  return review ? modCommentViews(review) : [];
}

export async function addComment(input: Parameters<typeof controlApi.addComment>[0]): Promise<void> {
  if (!isModSession(input.sessionId)) {
    await controlApi.addComment(input);
    return;
  }
  if (input.parentId) {
    throw new Error(`Replies are ${NOT_FOR_MOD}: edit the comment instead.`);
  }
  const review = modReviewOf(input.sessionId);
  const entry = review ? modCommentEntry(review, input) : { error: 'no review in that session' };
  if ('error' in entry) {
    throw new Error(entry.error);
  }
  await send(input.sessionId, entry);
}

export async function updateComment(sessionId: string, id: string, patch: { body?: string; resolved?: boolean }): Promise<void> {
  if (!isModSession(sessionId)) {
    await controlApi.updateComment(sessionId, id, patch);
    return;
  }
  if (patch.resolved !== undefined) {
    throw new Error(`Resolving is ${NOT_FOR_MOD}: delete the comment instead.`);
  }
  if (patch.body !== undefined) {
    await send(sessionId, { kind: 'review-comment-edit', id, body: patch.body });
  }
}

export async function deleteComment(sessionId: string, id: string): Promise<void> {
  if (!isModSession(sessionId)) {
    await controlApi.deleteComment(sessionId, id);
    return;
  }
  await send(sessionId, { kind: 'review-uncomment', id });
}

/**
 * The daemon writes the review to a file and someone delivers a pointer to it; the
 * mod prompts the agent itself, so its review is always delivered (`queued`).
 */
export async function submitReview(sessionId: string): Promise<controlApi.SubmitReviewResponse | undefined> {
  if (!isModSession(sessionId)) {
    return controlApi.submitReview(sessionId);
  }
  const review = modReviewOf(sessionId);
  const count = (review?.comments.length ?? 0) + (review?.findings.filter((f) => f.decision === 'keep').length ?? 0);
  if (count === 0) {
    return undefined;
  }
  await send(sessionId, { kind: 'review-submit' });
  return { comment_count: count, comment_ids: [], review_path: null, feedback: { status: 'queued' } };
}

export async function markDelivered(sessionId: string, commentIds: string[]): Promise<void> {
  if (!isModSession(sessionId)) {
    await controlApi.markDelivered(sessionId, commentIds);
  }
}

export async function accept(sessionId: string, filePath: string): Promise<void> {
  if (!isModSession(sessionId)) {
    await controlApi.accept(sessionId, filePath);
    return;
  }
  const file = modReviewOf(sessionId) && modFileAt(modReviewOf(sessionId)!, filePath);
  if (!file) {
    throw new Error('this file is not under review in that session');
  }
  await send(sessionId, { kind: 'review-accept-file', path: file.path });
}

/** Under the mod, a reject is a comment on the file, sent at once. */
export async function reject(sessionId: string, filePath: string, message: string): Promise<controlApi.RejectResponse> {
  if (!isModSession(sessionId)) {
    return controlApi.reject(sessionId, filePath, message);
  }
  // The message goes to the session at once; the file stays in the queue, so the
  // agent's fix is reviewed against the same starting point. A blank reject would
  // change nothing, so it is refused.
  if (message.trim() === '') {
    throw new Error('Write what the session should do about this file: a reject without a message changes nothing.');
  }
  await addComment({ sessionId, scope: 'File', path: filePath, side: 'After', startLine: 0, endLine: 0, body: message });
  await send(sessionId, { kind: 'review-submit' });
  return { reviewed: false, feedback: { status: 'queued' } };
}

export async function setIgnored(sessionId: string, filePath: string, ignored: boolean): Promise<void> {
  if (isModSession(sessionId)) {
    throw new Error(`Ignore is ${NOT_FOR_MOD}.`);
  }
  await controlApi.setIgnored(sessionId, filePath, ignored);
}

/** One AI review decision for a mod session (run, cancel, triage, submit, accept). */
export function sendAiReview(sessionId: string, entry: ModEntry): Promise<string> {
  return send(sessionId, entry);
}
