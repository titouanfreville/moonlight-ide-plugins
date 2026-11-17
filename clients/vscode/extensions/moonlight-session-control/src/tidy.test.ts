import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DiscoverableSession } from 'moonlight-control-client';

import { emptyGroups, HIDDEN_CAP, isLive, reconcileHidden, tidyBlocker } from './tidy';

const session = (id: string, over: Partial<DiscoverableSession> = {}): DiscoverableSession => ({
  session_id: id,
  title: id,
  root: '/p',
  adopted: true,
  status: 'Idle',
  phase: 'Review',
  unreviewed_files: 0,
  ...over,
});

test('working, waiting on the operator or holding an answer: never tidied away', () => {
  assert.ok(isLive(session('a', { status: 'Running' }), false));
  assert.ok(isLive(session('a', { status: 'WaitingInput' }), false));
  assert.ok(isLive(session('a'), true));
  assert.ok(!isLive(session('a', { status: 'Done' }), false));
  assert.equal(tidyBlocker(session('a', { status: 'Running' }), false), 'It is working.');
  assert.equal(tidyBlocker(session('a'), true), 'It is waiting on you: answer it first.');
  assert.equal(tidyBlocker(session('a', { status: 'Errored' }), false), undefined);
});

test('a hidden session is visible again once it works again, and stays visible', () => {
  const hidden = { quiet: 1, back: 2, held: 3 };
  const sessions = [session('quiet'), session('back', { status: 'Running' }), session('held')];
  const next = reconcileHidden(hidden, sessions, new Set(['held']));
  assert.deepEqual(next.hidden, { quiet: 1 });
  assert.ok(next.changed);
  // Nothing moved: nothing to save.
  assert.equal(reconcileHidden({ quiet: 1 }, [session('quiet')], new Set()).changed, false);
});

test('an id no longer listed stays hidden: a daemon restart lists nothing for a moment', () => {
  assert.deepEqual(reconcileHidden({ gone: 5 }, [], new Set()).hidden, { gone: 5 });
});

test('the hidden list is capped, the most recently hidden kept', () => {
  const many = Object.fromEntries(Array.from({ length: HIDDEN_CAP + 2 }, (_, i) => [`s${i}`, i]));
  const next = reconcileHidden(many, [], new Set());
  assert.equal(Object.keys(next.hidden).length, HIDDEN_CAP);
  assert.ok(!('s0' in next.hidden) && !('s1' in next.hidden) && `s${HIDDEN_CAP + 1}` in next.hidden);
});

test('a custom group is empty when none of its sessions is known any more', () => {
  const groups = [
    { id: 'g1', name: 'Release', sessionIds: ['a', 'old'] },
    { id: 'g2', name: 'Stale', sessionIds: ['old'] },
    { id: 'g3', name: 'New', sessionIds: [] },
  ];
  assert.deepEqual(emptyGroups(groups, [session('a')]).map((g) => g.id), ['g2', 'g3']);
});
