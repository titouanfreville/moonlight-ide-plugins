import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DiscoverableSession } from 'moonlight-control-client';

import { badge, describe, phaseLabel, sessionsFor } from './rows';

function session(over: Partial<DiscoverableSession> = {}): DiscoverableSession {
  return {
    session_id: 's',
    title: 's',
    root: '/p',
    adopted: true,
    status: 'Idle',
    phase: 'AutoImplement',
    unreviewed_files: 0,
    ...over,
  };
}

test('a governed row leads with the phase, and a frozen one says writes are denied', () => {
  assert.equal(describe(session({ status: 'Running' }), undefined), 'Auto, working');
  assert.equal(describe(session({ phase: 'Commit' }), undefined), 'Commit, writes denied');
});

test('a hold outranks the phase, and an ungoverned row says nothing gates it', () => {
  assert.equal(describe(session(), { plan: true }), 'Plan waiting on you');
  assert.equal(describe(session(), { plan: false }), 'Waiting on you');
  assert.equal(describe(session({ adopted: false }), undefined), 'not gated, idle');
});

test('badge priority: hold, then unreviewed files, then the status', () => {
  assert.deepEqual(badge(session({ unreviewed_files: 3 }), true), { text: '!', tone: 'held' });
  assert.deepEqual(badge(session({ unreviewed_files: 3 }), false), { text: '3', tone: 'info' });
  assert.deepEqual(badge(session({ unreviewed_files: 250 }), false), { text: '99+', tone: 'info' });
  assert.deepEqual(badge(session({ status: 'Errored' }), false), { text: '✕', tone: 'error' });
  // An ungoverned session's unreviewed files are not a call to action here.
  assert.deepEqual(badge(session({ adopted: false, unreviewed_files: 3 }), false), { text: '○', tone: 'muted' });
});

test('lists are split by adoption and sorted worst first', () => {
  const all = [
    session({ session_id: 'idle', status: 'Idle' }),
    session({ session_id: 'blocked', status: 'WaitingInput' }),
    session({ session_id: 'free', adopted: false }),
    session({ session_id: 'broken', status: 'Errored' }),
  ];
  assert.deepEqual(sessionsFor('governed', all).map((s) => s.session_id), ['blocked', 'broken', 'idle']);
  assert.deepEqual(sessionsFor('unadopted', all).map((s) => s.session_id), ['free']);
});

test('AutoImplement reads as Auto', () => {
  assert.equal(phaseLabel('AutoImplement'), 'Auto');
  assert.equal(phaseLabel('Review'), 'Review');
});
