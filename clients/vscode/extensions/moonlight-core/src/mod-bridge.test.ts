import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  daemonPhase,
  entryName,
  modHold,
  modPhase,
  modSession,
  modVerdict,
  parseModState,
  readModStates,
  sendToMod,
  type ModState,
} from './mod-bridge';

const state = (over: Partial<ModState> = {}): ModState => ({
  v: 1,
  sessionId: 's1',
  root: '/work/app',
  phase: 'plan',
  pending: null,
  plan: null,
  updatedMs: 0,
  ...over,
});

test('phases map both ways', () => {
  assert.equal(daemonPhase('auto'), 'AutoImplement');
  assert.equal(modPhase('AutoImplement'), 'auto');
  assert.equal(modPhase('Commit'), 'commit');
});

test('parseModState refuses another version or a torn write', () => {
  assert.equal(parseModState(JSON.stringify(state()))?.sessionId, 's1');
  assert.equal(parseModState(JSON.stringify(state({ v: 2 }))), undefined);
  assert.equal(parseModState('{"v":1,"sessionId":"s1"'), undefined);
});

test('a mod session reads as governed, waiting when it holds', () => {
  const s = modSession(state({ phase: 'test' }));
  assert.equal(s.adopted, true);
  assert.equal(s.phase, 'Test');
  assert.equal(s.status, 'Running');
  assert.equal(s.title, 'app (Claude Code plugin)');
  assert.equal(modSession(state({ title: 'Add Jira to plan' })).title, 'Add Jira to plan');
  assert.equal(modSession(state({ pending: { to: 'auto', reason: '' } })).status, 'WaitingInput');
});

test('holds: an undecided plan first, then a phase request', () => {
  const plan = { version: 3, title: 'T', markdown: '# Plan' };
  const both = modHold(state({ plan, pending: { to: 'auto', reason: 'go' } }), 5);
  assert.equal(both?.what, 'approve plan');
  assert.equal(both?.plan, '# Plan');
  assert.equal(both?.planVersion, 3);
  const request = modHold(state({ plan: { ...plan, decided: 'refine' }, pending: { to: 'auto', reason: 'go' } }), 5);
  assert.equal(request?.what, 'phase change to AutoImplement: go');
  assert.equal(request?.plan, undefined);
  assert.equal(modHold(state(), 5), undefined);
});

test('the four editor verdicts in the mod three', () => {
  assert.equal(modVerdict('approve'), 'approve');
  assert.equal(modVerdict('open-question'), 'refine');
  assert.equal(modVerdict('refine'), 'refine');
  assert.equal(modVerdict('no-go'), 'reject');
});

test('entry names sort by time and stay one safe word', () => {
  const a = entryName(5, 'x/../y');
  assert.match(a, /^[0-9]{15}-[A-Za-z0-9]+\.json$/);
  assert.ok(entryName(10, 'a') > entryName(9, 'z'));
});

test('readModStates keeps live sessions only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-bridge-'));
  for (const [id, alive] of [['live', true], ['dead', false]] as const) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, 'state.json'), JSON.stringify(state({ sessionId: id })));
    fs.writeFileSync(path.join(dir, id, 'heartbeat'), '1');
    if (!alive) {
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, id, 'heartbeat'), old, old);
    }
  }
  assert.deepEqual(readModStates(dir, Date.now()).map((s) => s.sessionId), ['live']);
  assert.deepEqual(readModStates(path.join(dir, 'missing'), Date.now()), []);
});

test('sendToMod writes the entry, waits for the answer, then cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-bridge-'));
  // A stand-in for the mod's tick: answers whatever lands in the inbox.
  const mod = setInterval(() => {
    const inbox = path.join(dir, 's1', 'inbox');
    for (const name of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
      if (!name.endsWith('.json')) continue;
      const entry = JSON.parse(fs.readFileSync(path.join(inbox, name), 'utf8'));
      fs.mkdirSync(path.join(dir, 's1', 'outbox'), { recursive: true });
      fs.writeFileSync(path.join(dir, 's1', 'outbox', name), JSON.stringify({ v: 1, ok: entry.v === 1, message: entry.kind }));
    }
  }, 20);
  try {
    assert.deepEqual(await sendToMod(dir, 's1', { kind: 'phase', to: 'auto' }), { ok: true, message: 'phase' });
    assert.deepEqual(fs.readdirSync(path.join(dir, 's1', 'inbox')), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, 's1', 'outbox')), []);
  } finally {
    clearInterval(mod);
  }
});

test('sendToMod withdraws an entry nobody took', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-bridge-'));
  const answer = await sendToMod(dir, 's1', { kind: 'request', approve: true }, 300);
  assert.equal(answer.ok, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 's1', 'inbox')), []);
});
