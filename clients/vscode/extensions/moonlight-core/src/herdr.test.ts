import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentName,
  agentStartArgs,
  createArgs,
  createdPane,
  findHerdr,
  herdrError,
  isInside,
  parsePanes,
  parseWorkspaces,
  placementLabel,
  placements,
  type HerdrPane,
  type HerdrWorkspace,
} from './herdr';

// Shaped like the herdr 0.9.5 responses this was written against.
const WORKSPACES = {
  result: {
    type: 'workspace_list',
    workspaces: [
      { workspace_id: 'w9', label: 'partoo', number: 1, focused: true },
      { workspace_id: 'wA', label: 'ml-test', number: 2, focused: false },
      { label: 'no id' },
    ],
  },
};
const PANES = {
  result: {
    panes: [
      { pane_id: 'w9:p1', workspace_id: 'w9', tab_id: 'w9:t1', cwd: '/home/me/partoo', focused: true, agent_session: { value: '12b59906-a06f' } },
      { pane_id: 'wA:p1', workspace_id: 'wA', tab_id: 'wA:t1', cwd: '/home/me/ml', foreground_cwd: '/home/me/ml/crates' },
    ],
  },
};

test('herdr JSON: workspaces and panes, entries without ids dropped', () => {
  assert.deepEqual(parseWorkspaces(WORKSPACES).map((w) => [w.id, w.label, w.focused]), [
    ['w9', 'partoo', true],
    ['wA', 'ml-test', false],
  ]);
  const panes = parsePanes(PANES);
  assert.deepEqual(panes.map((p) => [p.paneId, p.cwd, p.sessionId]), [
    ['w9:p1', '/home/me/partoo', '12b59906-a06f'],
    // The folder the shell is in now, over the one it started in.
    ['wA:p1', '/home/me/ml/crates', undefined],
  ]);
  assert.deepEqual(parseWorkspaces({}), []);
  assert.deepEqual(parsePanes('nonsense'), []);
});

test('inside a folder means the folder or below it, not a sibling with the same prefix', () => {
  assert.ok(isInside('/home/me/ml', '/home/me/ml'));
  assert.ok(isInside('/home/me/ml/crates/core', '/home/me/ml'));
  assert.ok(!isInside('/home/me/ml-other', '/home/me/ml'));
  assert.ok(!isInside('/home/me', '/home/me/ml'));
});

const ws = (id: string, number: number, focused = false): HerdrWorkspace => ({ id, label: id, number, focused });
const pane = (paneId: string, workspaceId: string, cwd: string, focused = false): HerdrPane => ({
  paneId, workspaceId, tabId: `${workspaceId}:t1`, cwd, sessionId: undefined, focused,
});

test("the repository's workspaces come first, the one last used here before the busiest", () => {
  const workspaces = [ws('w1', 1, true), ws('w2', 2), ws('w3', 3)];
  const panes = [
    pane('w1:p1', 'w1', '/elsewhere', true),
    pane('w2:p1', 'w2', '/repo'),
    pane('w3:p1', 'w3', '/repo/a'),
    pane('w3:p2', 'w3', '/repo/b'),
  ];
  const order = (last?: string) =>
    placements(['/repo'], workspaces, panes, last, 'repo').filter((p) => p.kind === 'tab').map((p) => (p.kind === 'tab' ? p.workspace.id : ''));
  assert.deepEqual(order(), ['w3', 'w2', 'w1']);
  assert.deepEqual(order('w2'), ['w2', 'w3', 'w1']);
  // A remembered workspace that no longer works here does not jump the queue.
  assert.deepEqual(order('w1'), ['w3', 'w2', 'w1']);
  const all = placements(['/repo'], workspaces, panes, undefined, 'repo');
  assert.deepEqual(all.at(-1), { kind: 'workspace', label: 'repo' });
});

test('with no workspace in the repository, a workspace of its own comes first', () => {
  const all = placements(['/repo'], [ws('w1', 1, true)], [pane('w1:p1', 'w1', '/elsewhere', true)], undefined, 'repo');
  assert.deepEqual(all[0], { kind: 'workspace', label: 'repo' });
  assert.equal(placementLabel(all[0]), 'New workspace "repo"');
});

test('a worktree of the repository counts as the repository', () => {
  const all = placements(['/repo', '/wt/feature'], [ws('w1', 1), ws('w2', 2)], [pane('w2:p1', 'w2', '/wt/feature/src')], undefined, 'repo');
  assert.deepEqual(all[0], { kind: 'tab', workspace: ws('w2', 2), inRepo: true });
});

test('a split goes beside the focused pane, else one in the repository', () => {
  const panes = [pane('w1:p1', 'w1', '/elsewhere'), pane('w1:p2', 'w1', '/repo')];
  const split = placements(['/repo'], [ws('w1', 1)], panes, undefined, 'repo').find((p) => p.kind === 'split');
  assert.equal(split?.kind === 'split' ? split.pane : '', 'w1:p2');
  const focused = [pane('w1:p1', 'w1', '/elsewhere', true), pane('w1:p2', 'w1', '/repo')];
  const beside = placements(['/repo'], [ws('w1', 1)], focused, undefined, 'repo').find((p) => p.kind === 'split');
  assert.equal(beside?.kind === 'split' ? beside.pane : '', 'w1:p1');
});

test('creation commands never take focus and carry the launch variable', () => {
  const env = { MOONLIGHT_LAUNCH_ID: 'abc' };
  assert.deepEqual(createArgs({ kind: 'tab', workspace: ws('w9', 1), inRepo: true }, '/repo', env), [
    'tab', 'create', '--workspace', 'w9', '--cwd', '/repo', '--env', 'MOONLIGHT_LAUNCH_ID=abc', '--no-focus',
  ]);
  assert.deepEqual(createArgs({ kind: 'split', workspace: ws('w9', 1), pane: 'w9:p1', inRepo: true }, '/repo', env), [
    'pane', 'split', 'w9:p1', '--direction', 'right', '--cwd', '/repo', '--env', 'MOONLIGHT_LAUNCH_ID=abc', '--no-focus',
  ]);
  assert.deepEqual(createArgs({ kind: 'workspace', label: 'repo' }, '/repo', env), [
    'workspace', 'create', '--cwd', '/repo', '--label', 'repo', '--env', 'MOONLIGHT_LAUNCH_ID=abc', '--no-focus',
  ]);
});

test('the new pane is read from either creation answer', () => {
  assert.equal(createdPane({ result: { workspace: { workspace_id: 'wA' }, root_pane: { pane_id: 'wA:p1' } } }), 'wA:p1');
  assert.equal(createdPane({ result: { pane: { pane_id: 'w9:p3' } } }), 'w9:p3');
  assert.equal(createdPane({ result: {} }), undefined);
});

test('agent start: our session id, and the MCP config only when the daemon governs', () => {
  const id = '72362684-0115-4749-a4ad-dcfbef32e279';
  assert.equal(agentName(id), 'ml-72362684');
  assert.deepEqual(agentStartArgs(id, 'wA:p1', undefined), [
    'agent', 'start', 'ml-72362684', '--kind', 'claude', '--pane', 'wA:p1', '--timeout', '60000', '--', '--session-id', id,
  ]);
  assert.deepEqual(agentStartArgs(id, 'wA:p1', '{"mcpServers":{}}').slice(-2), ['--mcp-config', '{"mcpServers":{}}']);
});

test("herdr's error JSON reads as its message", () => {
  assert.equal(herdrError('{"error":{"code":"pane_not_found","message":"no pane w9:p7"}}'), 'no pane w9:p7');
  assert.equal(herdrError('plain failure\n'), 'plain failure');
});

test('herdr is found on PATH, else where Homebrew and friends put it', () => {
  const at = (...have: string[]) => (p: string) => have.includes(p);
  assert.equal(findHerdr('', '/usr/bin:/bin', '/home/me', at('/opt/homebrew/bin/herdr')), '/opt/homebrew/bin/herdr');
  assert.equal(findHerdr('', '/tools:/bin', '/home/me', at('/tools/herdr', '/opt/homebrew/bin/herdr')), '/tools/herdr');
  assert.equal(findHerdr('', '', '/home/me', at('/home/me/.local/bin/herdr')), '/home/me/.local/bin/herdr');
  // A configured path is the answer, or there is none: never silently another herdr.
  assert.equal(findHerdr('/x/herdr', '', '/home/me', at('/opt/homebrew/bin/herdr')), undefined);
  assert.equal(findHerdr('', '', '/home/me', at()), undefined);
});
