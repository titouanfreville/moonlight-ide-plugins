import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModEntry, MoonlightApi } from 'moonlight-core';

import { modPhaseOf, nextPhase, setSessionPhase } from './phase-route';

test('phases in the mod names, and the daemon order', () => {
  assert.equal(modPhaseOf('AutoImplement'), 'auto');
  assert.equal(nextPhase('Plan'), 'AutoImplement');
  assert.equal(nextPhase('Commit'), 'Plan');
});

test('a mod session gets an inbox entry, and a refusal is an error', async () => {
  const sent: ModEntry[] = [];
  let ok = true;
  const core = {
    governor: () => 'mod',
    sendToMod: async (_id: string, entry: ModEntry) => {
      sent.push(entry);
      return { ok, message: ok ? 'The phase is test.' : 'busy' };
    },
  } as unknown as MoonlightApi;
  await setSessionPhase(core, 's1', 'Test');
  assert.deepEqual(sent, [{ kind: 'phase', to: 'test' }]);
  ok = false;
  await assert.rejects(setSessionPhase(core, 's1', 'Plan'), /busy/);
});
