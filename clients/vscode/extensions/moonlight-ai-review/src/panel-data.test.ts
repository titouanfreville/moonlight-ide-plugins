import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import type { ReviewCommentView, ReviewQueueItem } from 'moonlight-control-client';
import type { ModFinding, ModReview } from 'moonlight-core';

import { aiEntry, displayPath, panelData } from './panel-data';

const item = (file: string, over: Partial<ReviewQueueItem> = {}): ReviewQueueItem => ({
  session_id: 's1',
  session_title: 'app',
  file_path: file,
  touches: 1,
  tool: 'Edit',
  created: false,
  from_head: false,
  diff: '',
  ...over,
});

const comment = (file: string, over: Partial<ReviewCommentView> = {}): ReviewCommentView => ({
  id: file,
  scope: 'Line',
  path: file,
  side: 'After',
  start_line: 1,
  end_line: 1,
  body: 'x',
  anchor_text: null,
  sent: false,
  resolved: false,
  outdated: false,
  author: 'Operator',
  parent_id: null,
  ...over,
});

const finding = (id: string, severity: ModFinding['severity'], decision: ModFinding['decision']): ModFinding => ({
  id,
  key: id,
  severity,
  route: 'patch',
  owner: [],
  file: 'a.ts',
  line: 1,
  summary: id,
  detail: '',
  decision,
});

const review = (over: Partial<ModReview> = {}): ModReview => ({
  scope: 'session',
  files: [{ path: 'src/a.ts', absolute: '/p/src/a.ts', status: 'M', added: 4, removed: 1 }],
  comments: [],
  findings: [],
  findingsStatus: null,
  run: null,
  skills: ['code-review'],
  ...over,
});

test('display path is relative to the root only for files under it', () => {
  assert.equal(displayPath('/p/src/a.ts', '/p'), 'src/a.ts');
  assert.equal(displayPath('/q/a.ts', '/p'), '/q/a.ts');
  assert.equal(displayPath('/p/a.ts', null), '/p/a.ts');
  // A name starting with two dots is still under the root.
  assert.equal(displayPath('/p/..env.local', '/p'), '..env.local');
  assert.equal(displayPath('/p', '/p/sub'), '/p');
  // Always '/', whatever the platform's separator.
  assert.equal(displayPath(path.join('/p', 'src', 'a.ts'), '/p'), 'src/a.ts');
});

test('files: a file the session deleted is D, even when the queue saw it created', () => {
  const data = panelData({
    root: '/p',
    queue: [item('/p/src/gone.ts', { created: true })],
    comments: [],
    isMod: true,
    review: review({ files: [{ path: 'src/gone.ts', absolute: '/p/src/gone.ts', status: 'D', added: 0, removed: 9 }] }),
  });
  assert.deepEqual(data.files.map((f) => [f.display, f.status]), [['src/gone.ts', 'D']]);
});

test('files: ignored paths counted apart, created files marked A, mod line counts carried', () => {
  const data = panelData({
    root: '/p',
    queue: [
      item('/p/src/a.ts'),
      item('/p/src/new.ts', { created: true }),
      item('/p/dist/', { ignored: true, ignored_files: 12 }),
    ],
    comments: [],
    isMod: true,
    review: review(),
  });
  assert.deepEqual(data.files.map((f) => [f.display, f.status, f.added, f.removed]), [
    ['src/a.ts', 'M', 4, 1],
    ['src/new.ts', 'A', undefined, undefined],
  ]);
  assert.equal(data.ignored, 12);
});

test('comments: counted per file on thread roots, relative paths matched, pending and resolved apart', () => {
  const data = panelData({
    root: '/p',
    queue: [item('/p/src/a.ts')],
    comments: [
      comment('src/a.ts'),
      comment('/p/src/a.ts', { id: 'reply', parent_id: 'src/a.ts' }),
      comment('/p/src/a.ts', { id: 'done', resolved: true }),
      comment('/p/src/a.ts', { id: 'sent', sent: true }),
    ],
    isMod: false,
    review: undefined,
  });
  assert.equal(data.files[0].comments, 3);
  assert.deepEqual(data.comments, { pending: 2, resolved: 1 });
});

test('AI review: the daemon has none, a stale plugin says so, a mod review is sorted and counted', () => {
  const base = { root: '/p', queue: [], comments: [] };
  assert.deepEqual(panelData({ ...base, isMod: false, review: review() }).ai, { kind: 'daemon' });
  assert.deepEqual(panelData({ ...base, isMod: true, review: undefined }).ai, { kind: 'stale' });

  const ai = panelData({
    ...base,
    isMod: true,
    review: review({ findings: [finding('low', 'low', 'keep'), finding('high', 'high', 'dismiss')] }),
  }).ai;
  assert.equal(ai.kind, 'mod');
  if (ai.kind === 'mod') {
    assert.deepEqual(ai.findings.map((f) => f.id), ['high', 'low']);
    assert.equal(ai.kept, 1);
    assert.equal(ai.dismissed, 1);
  }
});

test('a note keeps the finding it is written on', () => {
  assert.deepEqual(aiEntry({ type: 'note', id: 'f1', text: 'fix it' }), {
    kind: 'finding',
    id: 'f1',
    decision: 'keep',
    note: 'fix it',
  });
  assert.deepEqual(aiEntry({ type: 'scope', scope: 'head' }), { kind: 'review-scope', scope: 'head' });
});

test('an unknown AI action is refused, never written as a half entry', () => {
  assert.throws(() => aiEntry({ type: 'wipe' } as never), /Unknown AI review action: wipe/);
});
