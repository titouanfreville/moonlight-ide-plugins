import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModReview } from 'moonlight-core';

import {
  modBaselineSource,
  modBaselineView,
  modCommentEntry,
  modCommentViews,
  modQueueItems,
  pendingCounts,
  sortedFindings,
} from './mod-review';

const review = (over: Partial<ModReview> = {}): ModReview => ({
  scope: 'session',
  files: [
    { path: 'src/a.ts', absolute: '/p/src/a.ts', status: 'M', added: 1, removed: 1, baseline: '/b/abc' },
    { path: 'src/new.ts', absolute: '/p/src/new.ts', status: 'A', added: 3, removed: 0, baseline: '/dev/null' },
    { path: 'logo.png', absolute: '/p/logo.png', status: 'M', added: 0, removed: 0, skipped: 'binary' },
  ],
  comments: [],
  findings: [],
  findingsStatus: null,
  run: null,
  skills: ['code-review'],
  ...over,
});

test('queue items: absolute paths, created and from-HEAD flags, skipped files left out', () => {
  const items = modQueueItems('s1', 'app', review());
  assert.deepEqual(items.map((i) => [i.file_path, i.created, i.from_head]), [
    ['/p/src/a.ts', false, false],
    ['/p/src/new.ts', true, false],
  ]);
  const head = modQueueItems('s1', null, review({ scope: 'head', files: [{ path: 'a', absolute: '/p/a', status: 'M', added: 1, removed: 0 }] }));
  assert.equal(head[0].from_head, true);
});

test('baselines: saved copy, created, last commit', () => {
  const r = review();
  assert.deepEqual(modBaselineSource(r.files[0]), { kind: 'copy', path: '/b/abc' });
  assert.deepEqual(modBaselineView(modBaselineSource(r.files[0]), 'old'), { kind: 'content', text: 'old' });
  assert.deepEqual(modBaselineView(modBaselineSource(r.files[1]), undefined), { kind: 'created' });
  const head = { path: 'a', absolute: '/p/a', status: 'M', added: 1, removed: 0 };
  assert.deepEqual(modBaselineView(modBaselineSource(head), 'committed'), { kind: 'from_head', text: 'committed' });
  assert.deepEqual(modBaselineView(modBaselineSource(head), undefined), { kind: 'created' });
  assert.equal(modBaselineView(modBaselineSource(undefined), undefined).kind, 'unavailable');
});

test('comments map both ways, by absolute path', () => {
  const r = review({ comments: [{ id: 'c1', path: 'src/a.ts', side: 'before', start: 2, end: 3, body: 'why?', excerpt: 'x' }] });
  const [view] = modCommentViews(r);
  assert.equal(view.path, '/p/src/a.ts');
  assert.equal(view.side, 'Before');
  assert.equal(view.anchor_text, 'x');
  assert.equal(view.parent_id, null);

  assert.deepEqual(
    modCommentEntry(r, { path: '/p/src/a.ts', side: 'After', startLine: 4, endLine: 5, body: 'tighter', anchorText: 'y' }),
    { kind: 'review-comment', path: 'src/a.ts', side: 'after', start: 4, end: 5, body: 'tighter', excerpt: 'y' }
  );
  const fileWide = modCommentEntry(r, { path: '/p/src/a.ts', side: 'After', startLine: 0, endLine: 0, body: 'split it' });
  assert.equal('kind' in fileWide && fileWide.kind === 'review-comment' && fileWide.start, 1);
  assert.ok('error' in modCommentEntry(r, { path: '/elsewhere.ts', side: 'After', startLine: 1, endLine: 1, body: 'x' }));
  assert.ok('error' in modCommentEntry(r, { path: '/p/src/a.ts', side: 'After', startLine: 0, endLine: 0, body: '  ' }));
});

test('findings: worst first; what Submit would send', () => {
  const f = (id: string, severity: 'high' | 'medium' | 'low', decision: 'keep' | 'dismiss') => ({
    id, key: id, severity, route: 'patch' as const, owner: [], file: 'a.ts', line: 1, summary: id, detail: '', decision,
  });
  const r = review({
    comments: [{ id: 'c1', path: 'src/a.ts', side: 'after', start: 1, end: 1, body: 'x' }],
    findings: [f('L', 'low', 'keep'), f('H', 'high', 'dismiss'), f('M', 'medium', 'keep')],
  });
  assert.deepEqual(sortedFindings(r.findings).map((x) => x.id), ['H', 'M', 'L']);
  assert.deepEqual(pendingCounts(r), { comments: 1, kept: 2, dismissed: 1 });
});
