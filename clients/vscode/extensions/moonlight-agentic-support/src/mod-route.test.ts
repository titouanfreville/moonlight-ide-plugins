import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { modPlanEntry } from './mod-route';

const plan = '# Plan\n\nWrap the client.';

test('a bare approval carries no note', () => {
  assert.deepEqual(modPlanEntry(2, plan, new Map(), 'approve'), { kind: 'plan', version: 2, verdict: 'approve', note: '' });
});

test('an approval with notes keeps them', () => {
  assert.match(modPlanEntry(2, plan, new Map([[0, 'mind the TTL']]), 'approve').note, /mind the TTL/);
});

test('the four verdicts in the mod three, the editor tag kept', () => {
  const tagged = (v: 'open-question' | 'refine' | 'no-go') => modPlanEntry(1, plan, new Map([[0, 'why?']]), v);
  assert.equal(tagged('open-question').verdict, 'refine');
  assert.equal(tagged('refine').verdict, 'refine');
  assert.equal(tagged('no-go').verdict, 'reject');
  assert.match(tagged('no-go').note, /\[verdict: no-go\]/);
});

test('a rejection always has a reason, even with no comments', () => {
  assert.ok(modPlanEntry(1, plan, new Map(), 'no-go').note.trim().length > 0);
});
