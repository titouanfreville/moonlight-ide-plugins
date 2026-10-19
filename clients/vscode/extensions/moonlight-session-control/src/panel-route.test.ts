import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DiscoverableSession } from 'moonlight-control-client';

import { isAiAction, isTab, nodeSession, phaseMove, routeOf } from './panel-route';

const session = (over: Partial<DiscoverableSession> = {}): DiscoverableSession => ({
  session_id: 's1',
  title: 's1',
  root: '/p',
  adopted: true,
  status: 'Idle',
  phase: 'Review',
  unreviewed_files: 0,
  ...over,
});

test('session commands get the session as a tree node, and nothing when it is gone', () => {
  const s = session();
  const route = routeOf({ type: 'command', command: 'adopt', id: 's1' }, s);
  assert.equal(route?.command, 'moonlight.sessions.adopt');
  assert.equal(nodeSession(route?.args[0]), s);
  assert.equal(routeOf({ type: 'command', command: 'follow', id: 'gone' }, undefined), undefined);
});

test('a hold button answers the hold it names', () => {
  assert.deepEqual(routeOf({ type: 'command', command: 'reviewPlan', id: 's1' }, undefined), {
    command: 'moonlight.sessions.reviewPlan',
    args: ['s1'],
  });
  assert.deepEqual(routeOf({ type: 'command', command: 'answerHold', id: 's1' }, undefined), {
    command: 'moonlight.sessions.answerHold',
    args: ['s1'],
  });
  // Plain commands carry no session.
  assert.deepEqual(routeOf({ type: 'command', command: 'refresh', id: 's1' }, undefined), {
    command: 'moonlight.sessions.refresh',
    args: [],
  });
});

test('group, review and file messages reach their commands', () => {
  assert.deepEqual(routeOf({ type: 'command', command: 'renameGroup', groupId: 'g' }, undefined), {
    command: 'moonlight.sessions.renameGroup',
    args: [{ kind: 'group', group: { key: 'custom:g', custom: true } }],
  });
  assert.equal(routeOf({ type: 'command', command: 'deleteGroup' }, undefined), undefined);
  assert.deepEqual(routeOf({ type: 'command', command: 'submitReview', id: 's1' }, undefined), {
    command: 'moonlight.review.submit',
    args: ['s1'],
  });
  assert.deepEqual(routeOf({ type: 'commentFile', id: 's1', path: '/p/a' }, undefined), {
    command: 'moonlight.review.commentOnQueuedFile',
    args: ['s1', '/p/a'],
  });
  assert.deepEqual(routeOf({ type: 'openFinding', id: 's1', file: 'a.ts', line: 3 }, undefined), {
    command: 'moonlight.review.openFinding',
    args: ['s1', 'a.ts', 3],
  });
  assert.deepEqual(routeOf({ type: 'ai', id: 's1', action: { type: 'submit' } }, undefined), {
    command: 'moonlight.review.aiAction',
    args: ['s1', { type: 'submit' }],
  });
});

test('the command list is closed: unknown and inherited names run nothing', () => {
  assert.equal(routeOf({ type: 'command', command: 'workbench.action.quit' }, session()), undefined);
  assert.equal(routeOf({ type: 'command', command: 'toString' }, session()), undefined);
  assert.equal(routeOf({ type: 'command', command: 'constructor', id: 's1' }, session()), undefined);
});

test('a rail click moves the phase, except onto the current one or for a gone session', () => {
  assert.equal(phaseMove('Test', session({ phase: 'Review' })), 'Test');
  // The lit disc: moving there would pin the phase and stop auto-advance.
  assert.equal(phaseMove('Review', session({ phase: 'Review' })), undefined);
  assert.equal(phaseMove('Test', undefined), undefined);
  assert.equal(phaseMove('Deploy', session()), undefined);
});

test('only the three tabs are tabs', () => {
  assert.ok(isTab('sessions') && isTab('review') && isTab('ai'));
  assert.ok(!isTab('settings') && !isTab(undefined));
});

test('AI review actions are checked before they reach the mod', () => {
  assert.ok(isAiAction({ type: 'decide', id: 'f1', decision: 'dismiss' }));
  assert.ok(isAiAction({ type: 'scope', scope: 'head' }));
  assert.ok(isAiAction({ type: 'note', id: 'f1', text: '' }));
  assert.ok(!isAiAction({ type: 'decide', id: 'f1', decision: 'maybe' }));
  assert.ok(!isAiAction({ type: 'scope', scope: 'everything' }));
  assert.ok(!isAiAction({ type: 'note', id: 1, text: 'x' }));
  assert.ok(!isAiAction({ type: 'delete-all' }));
  assert.ok(!isAiAction(undefined));
  assert.equal(routeOf({ type: 'ai', id: 's1', action: { type: 'wipe' } as never }, undefined), undefined);
});
