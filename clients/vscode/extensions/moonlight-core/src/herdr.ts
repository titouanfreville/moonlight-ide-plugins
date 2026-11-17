/**
 * herdr, the terminal workspace manager, as a place to run Claude Code sessions: what its
 * JSON says, which of its workspaces belong to the repository open here, and the exact
 * arguments that start a session in one. Pure, so the rules are tested rather than
 * eyeballed; `herdr-cli.ts` runs the commands.
 *
 * A session started in herdr lives in a pane of the herdr server, not in the editor:
 * it survives closing the editor, can be reattached from any terminal, and shows in
 * herdr's sidebar like any other agent. herdr's Claude integration reports each
 * session's id (`agent_session.value`), which is MoonlightCode's session id too — that is
 * what ties a pane to a session, with no guessing.
 */
import * as path from 'path';

export interface HerdrWorkspace {
  id: string;
  label: string;
  number: number;
  focused: boolean;
}

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** The pane's folder, when herdr knows it. */
  cwd: string | undefined;
  /** The Claude Code session in the pane, from herdr's Claude integration. */
  sessionId: string | undefined;
  focused: boolean;
}

/** Where a new session goes: beside an existing workspace's work, or a workspace of its own. */
export type Placement =
  | { kind: 'tab'; workspace: HerdrWorkspace; inRepo: boolean }
  | { kind: 'split'; workspace: HerdrWorkspace; pane: string; inRepo: boolean }
  | { kind: 'workspace'; label: string };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** `herdr workspace list`. Entries without an id are dropped rather than guessed. */
export function parseWorkspaces(json: unknown): HerdrWorkspace[] {
  const list = obj(obj(json).result).workspaces;
  return (Array.isArray(list) ? list : []).flatMap((w): HerdrWorkspace[] => {
    const id = str(obj(w).workspace_id);
    if (!id) {
      return [];
    }
    const e = obj(w);
    return [{ id, label: str(e.label) ?? id, number: typeof e.number === 'number' ? e.number : 0, focused: e.focused === true }];
  });
}

/** `herdr pane list`. */
export function parsePanes(json: unknown): HerdrPane[] {
  const list = obj(obj(json).result).panes;
  return (Array.isArray(list) ? list : []).flatMap((p): HerdrPane[] => {
    const e = obj(p);
    const paneId = str(e.pane_id);
    const workspaceId = str(e.workspace_id);
    if (!paneId || !workspaceId) {
      return [];
    }
    return [
      {
        paneId,
        workspaceId,
        tabId: str(e.tab_id) ?? '',
        cwd: str(e.foreground_cwd) ?? str(e.cwd),
        sessionId: str(obj(e.agent_session).value),
        focused: e.focused === true,
      },
    ];
  });
}

/** Whether `dir` is `root` or inside it. */
export function isInside(dir: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(dir));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * The choices for a new session, best first.
 *
 * herdr does not tie workspaces to folders, so the repository decides: a workspace with a
 * pane in it (or in one of its worktrees, `roots`) is this repository's. Those come first
 * — the one last used here, else the one with most panes in the repository — then every
 * other workspace, then a new workspace named after the repository.
 */
export function placements(
  roots: readonly string[],
  workspaces: readonly HerdrWorkspace[],
  panes: readonly HerdrPane[],
  lastUsed: string | undefined,
  repoName: string
): Placement[] {
  const inRepo = (p: HerdrPane): boolean => p.cwd !== undefined && roots.some((r) => isInside(p.cwd as string, r));
  const score = (w: HerdrWorkspace): number => panes.filter((p) => p.workspaceId === w.id && inRepo(p)).length;
  const ordered = [...workspaces].sort((a, b) => {
    const rank = (w: HerdrWorkspace): number => (w.id === lastUsed && score(w) > 0 ? 1000 : 0) + score(w);
    return rank(b) - rank(a) || a.number - b.number;
  });
  const choices: Placement[] = [];
  for (const workspace of ordered) {
    const matches = score(workspace) > 0;
    choices.push({ kind: 'tab', workspace, inRepo: matches });
    // Split beside the pane you would be looking at: the focused one, else one in the repository.
    const beside =
      panes.find((p) => p.workspaceId === workspace.id && p.focused) ??
      panes.find((p) => p.workspaceId === workspace.id && inRepo(p)) ??
      panes.find((p) => p.workspaceId === workspace.id);
    if (beside) {
      choices.push({ kind: 'split', workspace, pane: beside.paneId, inRepo: matches });
    }
  }
  // With no workspace in the repository, its own workspace is the natural first choice.
  const fresh: Placement = { kind: 'workspace', label: repoName };
  return ordered.some((w) => score(w) > 0) ? [...choices, fresh] : [fresh, ...choices];
}

/** A herdr agent name for a session: `ml-` and the id's first block, herdr's `[a-z][a-z0-9_-]{0,31}`. */
export function agentName(sessionId: string): string {
  return `ml-${sessionId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/**
 * The `herdr` arguments that make the pane a placement needs, in `cwd`, with the launch
 * variable set for the shell the agent starts in. Never takes focus: starting a session
 * from the editor should not move any herdr window; the editor offers to show it.
 */
export function createArgs(placement: Placement, cwd: string, env: Readonly<Record<string, string>>): string[] {
  const vars = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
  switch (placement.kind) {
    case 'tab':
      return ['tab', 'create', '--workspace', placement.workspace.id, '--cwd', cwd, ...vars, '--no-focus'];
    case 'split':
      return ['pane', 'split', placement.pane, '--direction', 'right', '--cwd', cwd, ...vars, '--no-focus'];
    case 'workspace':
      return ['workspace', 'create', '--cwd', cwd, '--label', placement.label, ...vars, '--no-focus'];
  }
}

/** The pane a creation command answered with: `root_pane` for a tab or workspace, `pane` for a split. */
export function createdPane(json: unknown): string | undefined {
  const result = obj(obj(json).result);
  return str(obj(result.root_pane).pane_id) ?? str(obj(result.pane).pane_id);
}

/**
 * `herdr agent start` for a session: Claude Code, with our session id, and the daemon's
 * MCP config when the daemon governs. Arguments after `--` go to Claude Code as a list —
 * no shell line is built, so the JSON needs no quoting.
 */
export function agentStartArgs(sessionId: string, pane: string, mcpJson: string | undefined): string[] {
  return [
    'agent', 'start', agentName(sessionId), '--kind', 'claude', '--pane', pane, '--timeout', '60000',
    '--', '--session-id', sessionId, ...(mcpJson ? ['--mcp-config', mcpJson] : []),
  ];
}

/** How a placement reads in a picker. */
export function placementLabel(p: Placement): string {
  switch (p.kind) {
    case 'tab':
      return `${p.workspace.label}: new tab`;
    case 'split':
      return `${p.workspace.label}: split beside ${p.pane}`;
    case 'workspace':
      return `New workspace "${p.label}"`;
  }
}

/** The error message herdr printed (JSON on stderr), or the raw text. */
export function herdrError(stderr: string): string {
  try {
    const e = obj(obj(JSON.parse(stderr)).error);
    return str(e.message) ?? str(e.code) ?? stderr.trim();
  } catch {
    return stderr.trim();
  }
}

/**
 * The `herdr` binary: the configured path, else the first on PATH or in the usual install
 * folders. An editor started from the Dock gets a short PATH without Homebrew's folder, so
 * PATH alone would say "not installed" for an installed herdr.
 */
export function findHerdr(configured: string, envPath: string | undefined, home: string, exists: (p: string) => boolean): string | undefined {
  if (configured) {
    return exists(configured) ? configured : undefined;
  }
  const dirs = [
    ...(envPath ?? '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
  ];
  return dirs.map((d) => path.join(d, 'herdr')).find(exists);
}
