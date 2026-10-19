import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DiscoverableSession } from 'moonlight-control-client';
import type { HeldApproval, ReviewPanelData } from 'moonlight-core';

import { panelModel, planTitle, reviewTarget, type PanelInput } from './panel-model';

function session(id: string, over: Partial<DiscoverableSession> = {}): DiscoverableSession {
  return {
    session_id: id,
    title: id,
    root: '/p',
    adopted: true,
    status: 'Idle',
    phase: 'Review',
    unreviewed_files: 0,
    ...over,
  };
}

const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  sessions: [],
  holds: [],
  backendError: undefined,
  claudeMod: 'unknown',
  following: undefined,
  groupBy: 'none',
  groups: [],
  tab: 'sessions',
  selected: undefined,
  review: undefined,
  reviewInstalled: true,
  colorBlind: false,
  ...over,
});

const hold = (sessionId: string, plan?: string): HeldApproval => ({
  sessionId,
  what: 'ExitPlanMode',
  plan,
  mcpTool: undefined,
  sinceMs: 0,
});

test('the review tabs follow a governed pick, else the worst governed session', () => {
  const sessions = [
    session('idle'),
    session('blocked', { status: 'WaitingInput' }),
    session('free', { adopted: false }),
  ];
  assert.equal(reviewTarget(sessions, 'idle')?.session_id, 'idle');
  // An ungoverned pick has no review to show: fall back rather than show nothing.
  assert.equal(reviewTarget(sessions, 'free')?.session_id, 'blocked');
  assert.equal(reviewTarget(sessions, undefined)?.session_id, 'blocked');
  assert.equal(reviewTarget([session('x', { adopted: false })], 'x'), undefined);
});

test('a plan hold is named by its first heading', () => {
  assert.equal(planTitle('Intro\n## Anchor comments to hunks\n- step'), 'Anchor comments to hunks');
  assert.equal(planTitle('no heading'), undefined);
  const model = panelModel(input({ sessions: [session('a')], holds: [hold('a', '# Ship it\n1. go')] }));
  assert.deepEqual(model.holds.map((h) => [h.sessionId, h.plan, h.what]), [['a', true, 'Ship it']]);
  assert.equal(model.counts.held, 1);
  assert.equal(model.governed[0].rows[0].description, 'Plan waiting on you');
});

test('tab counts: files waiting for review, and findings not dismissed', () => {
  const review: ReviewPanelData = {
    files: [{ path: '/p/a', display: 'a', status: 'M', comments: 0, fromHead: false }],
    ignored: 0,
    comments: { pending: 0, resolved: 0 },
    ai: { kind: 'mod', scope: 'session', run: null, skills: [], status: null, findings: [
      { id: '1', key: '1', severity: 'high', route: 'patch', owner: [], file: 'a', line: 1, summary: '', detail: '', decision: 'keep' },
      { id: '2', key: '2', severity: 'low', route: 'patch', owner: [], file: 'a', line: 2, summary: '', detail: '', decision: 'dismiss' },
    ], kept: 1, dismissed: 1, comments: 0 },
  };
  const model = panelModel(input({ sessions: [session('a', { unreviewed_files: 7 })], review }));
  assert.deepEqual(model.counts, { held: 0, review: 1, ai: 1 });
  // Without the review answered yet, the count comes from the poll.
  assert.equal(panelModel(input({ sessions: [session('a', { unreviewed_files: 7 })] })).counts.review, 7);
});

test('an empty governed list says why', () => {
  assert.equal(panelModel(input({ backendError: 'refused' })).governedEmpty, 'backend-down');
  assert.equal(panelModel(input()).governedEmpty, 'no-sessions');
  assert.equal(panelModel(input({ sessions: [session('f', { adopted: false })] })).governedEmpty, 'none-governed');
  assert.equal(panelModel(input({ sessions: [session('a')] })).governedEmpty, undefined);
});

test('the gate line says who governs', () => {
  assert.equal(panelModel(input()).gate.tone, 'ok');
  assert.equal(panelModel(input({ backendError: 'x', claudeMod: 'active' })).gate.tone, 'mod');
  const down = panelModel(input({ backendError: 'x', claudeMod: 'missing' }));
  assert.equal(down.gate.tone, 'down');
  assert.equal(down.offerMod, true);
});

test('custom groups keep an empty group and name the one a session is in', () => {
  const model = panelModel(input({
    sessions: [session('a'), session('b', { root: '/q' })],
    groupBy: 'custom',
    groups: [{ id: 'g1', name: 'Release', sessionIds: ['a'] }, { id: 'g2', name: 'Empty', sessionIds: [] }],
    selected: 'a',
  }));
  assert.deepEqual(model.governed.map((g) => [g.label, g.customId, g.rows.length]), [
    ['Release', 'g1', 1],
    ['Empty', 'g2', 0],
    ['q', undefined, 1],
  ]);
  assert.equal(model.detail?.groupName, 'Release');
});
