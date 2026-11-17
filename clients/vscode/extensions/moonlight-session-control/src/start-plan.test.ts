import assert from 'node:assert/strict';
import { test } from 'node:test';

import { governorFor, hostFor } from './start-plan';

test('a reachable daemon governs; without it the Claude Code plugin, when enabled; else nothing', () => {
  assert.equal(governorFor(undefined, 'missing'), 'daemon');
  assert.equal(governorFor('refused', 'active'), 'mod');
  assert.equal(governorFor('refused', 'off'), 'none');
  assert.equal(governorFor('refused', 'unknown'), 'none');
});

test('herdr is offered only while its server runs', () => {
  assert.equal(hostFor('ask', true), 'ask');
  assert.equal(hostFor('ask', false), 'terminal');
  assert.equal(hostFor('terminal', true), 'terminal');
  assert.equal(hostFor('herdr', true), 'herdr');
  // Asked for explicitly: say it is down rather than quietly using a terminal.
  assert.equal(hostFor('herdr', false), 'herdr-down');
});
