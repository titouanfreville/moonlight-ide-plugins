// Pure policy of the MoonlightCode gate. No `$` here, so it is unit-testable.

// The daemon's workflow (crates/domain/src/phase.rs), in order. Plan and
// Commit are read-only; Commit also freezes the notes folders, until the
// operator commits. `next` is cyclic: Commit → Plan starts the next unit of work.
export type Phase = 'plan' | 'auto' | 'test' | 'review' | 'commit'

export const PHASES: readonly Phase[] = ['plan', 'auto', 'test', 'review', 'commit']

export type SandboxWriteLists = {
  denyWrite: readonly string[]
  allowWrite: readonly string[]
}

export const DEFAULT_WRITABLE: readonly string[] = ['.ai', '.bmad-output', '.bmad']

// A project's folder name under ~/.moonlight/mod/projects/, encoded the way
// Claude Code names its own project folders (`/a/b.c` → `-a-b-c`).
export const projectKey = (root: string): string => root.replace(/[^A-Za-z0-9]/g, '-')

// Project files are writable.
export const allowsWrites = (phase: Phase): boolean => phase === 'auto' || phase === 'test' || phase === 'review'

// The notes folders are writable: every phase but the commit gate.
export const allowsNotes = (phase: Phase): boolean => phase !== 'commit'

export const nextPhase = (phase: Phase): Phase => PHASES[(PHASES.indexOf(phase) + 1) % PHASES.length]!

// A phase as typed or requested, with the daemon's aliases; undefined for
// anything else (`next` included: the caller resolves it against the current phase).
export const phaseFromToken = (raw: string | undefined): Phase | undefined => {
  const token = raw?.trim().toLowerCase()
  if (token === 'plan' || token === 'discovery' || token === 'discover') return 'plan'
  if (token === 'auto' || token === 'implement' || token === 'autoimplement' || token === 'auto-implement') return 'auto'
  return token === 'test' || token === 'review' || token === 'commit' ? token : undefined
}

// The phase file: anything unreadable stays Plan, the safe default.
export const parsePhase = (raw: string | undefined): Phase => phaseFromToken(raw) ?? 'plan'

export const phaseLabel = (phase: Phase): string => phase.charAt(0).toUpperCase() + phase.slice(1)

// What the phase allows, as the hint line, the pane and the messages say it.
export const phaseRule = (phase: Phase): string =>
  phase === 'plan' ? 'project read-only' : phase === 'commit' ? 'everything frozen until you commit' : 'project writable'

// The notes folders open in this phase.
export const notesFor = (phase: Phase, writable: readonly string[]): readonly string[] =>
  allowsNotes(phase) ? writable : []

// Paths are written to the project's .claude/settings.local.json, where `./x`
// resolves under the project root.
//
// In the sandbox a denyWrite always wins over an allowWrite, however narrow the
// allow is, so the root cannot be denied with the notes folders re-opened.
// A read-only phase instead denies every top-level entry except the notes
// folders it leaves open (none in Commit). The root itself stays writable: a
// new top-level entry is caught after the call.
//
// The project's .moonlight/ holds the gate's own config: it is write-denied in
// every phase, so an Auto session cannot widen the next Plan.
export const PROJECT_CONFIG_DIR = '.moonlight'

// Claude Code's project settings: they hold the sandbox lists the gate writes,
// and hooks that would run outside it. Write-denied in every phase, so an Auto
// session cannot widen the next Plan either.
export const PROJECT_SETTINGS: readonly string[] = ['.claude/settings.json', '.claude/settings.local.json']

export const sandboxListsFor = (
  phase: Phase,
  writable: readonly string[],
  rootEntries: readonly string[],
): SandboxWriteLists => {
  const always = [`./${PROJECT_CONFIG_DIR}`, ...PROJECT_SETTINGS.map(file => `./${file}`)]
  if (allowsWrites(phase)) return { denyWrite: always, allowWrite: [] }
  const open = notesFor(phase, writable)
  const entries = rootEntries.filter(name => !open.includes(name)).map(name => `./${name}`)
  return { denyWrite: [...always, ...entries.filter(e => !always.includes(e))], allowWrite: [] }
}

// Everything a phase could have added for this root: what counts as the mod's
// own when there is no record of what it added last.
export const ownedByAnyPhase = (writable: readonly string[], rootEntries: readonly string[]): SandboxWriteLists => {
  const lists = PHASES.map(phase => sandboxListsFor(phase, writable, rootEntries))
  return {
    denyWrite: [...new Set(lists.flatMap(l => l.denyWrite))],
    allowWrite: [...new Set(lists.flatMap(l => l.allowWrite))],
  }
}

// Top-level entries that appeared since the deny list was built.
export const newRootEntries = (
  rootEntries: readonly string[],
  denied: readonly string[],
  writable: readonly string[],
): string[] =>
  rootEntries.filter(name => !writable.includes(name) && !denied.includes(`./${name}`))

// Replaces the entries this mod added last time with the new ones, keeping
// whatever the user put there themselves.
export const mergeOwned = (
  existing: readonly string[],
  previouslyOwned: readonly string[],
  owned: readonly string[],
): string[] => {
  const kept = existing.filter(p => !previouslyOwned.includes(p))
  return [...kept, ...owned.filter(p => !kept.includes(p))]
}

// In a read-only phase (Plan, Commit), a tool runs only when it is listed here. Everything else is
// denied: unknown MCP tools (they run outside the sandbox), cross-session and
// remote tools (another session could write for this one), schedulers.
// Bash / Monitor / Edit / Write / NotebookEdit are listed because their own hooks gate them.
const PLAN_ALLOWED_TOOLS: readonly string[] = [
  'Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ToolSearch',
  'TodoWrite', 'AskUserQuestion', 'Skill', 'Agent', 'Task', 'TaskStop', 'Monitor',
  'Bash', 'Edit', 'Write', 'NotebookEdit',
  'mcp__moonlightcode__request_phase', 'mcp__moonlightcode__present_plan',
]

// Claude Code's own plan mode leaves auto mode: in Plan, plans go through
// present_plan instead, so these are refused with a pointer to it.
export const CLAUDE_PLAN_MODE_TOOLS: readonly string[] = ['EnterPlanMode', 'ExitPlanMode']

// Read-only MCP tools, by exact name or by prefix (ending in `__` or `_`).
const PLAN_ALLOWED_MCP: readonly string[] = [
  'mcp__moonlight__phase_status', 'mcp__moonlight__request_phase',
  'mcp__moonlight__present_plan', 'mcp__moonlight__report_blocked',
  'mcp__codegraph__', 'mcp__context7__', 'mcp__exa__',
  'mcp__github__get_', 'mcp__github__list_', 'mcp__github__search_',
]

export const isAllowedInPlan = (tool: string, extra: readonly string[] = []): boolean => {
  if (PLAN_ALLOWED_TOOLS.includes(tool)) return true
  return [...PLAN_ALLOWED_MCP, ...extra].some(entry =>
    entry.endsWith('_') ? tool.startsWith(entry) : tool === entry,
  )
}

export const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

export const isUnderAny = (path: string, roots: readonly string[]): boolean =>
  roots.some(r => isUnder(path, r))

export type SandboxHealth = { isSafe: true } | { isSafe: false; reason: string }

// Fail closed: Plan only trusts Bash when the sandbox cannot be bypassed.
export const checkSandbox = (settings: Readonly<Record<string, unknown>>): SandboxHealth => {
  const sandbox = (settings.sandbox ?? {}) as Record<string, unknown>
  if (sandbox.enabled !== true) return { isSafe: false, reason: 'sandbox.enabled is not true' }
  if (sandbox.allowUnsandboxedCommands !== false)
    return { isSafe: false, reason: 'sandbox.allowUnsandboxedCommands is not false' }
  const excluded = sandbox.excludedCommands
  if (Array.isArray(excluded) && excluded.length > 0)
    return { isSafe: false, reason: `sandbox.excludedCommands is set (${excluded.join(', ')})` }
  const filesystem = (sandbox.filesystem ?? {}) as Record<string, unknown>
  if (filesystem.disabled === true)
    return { isSafe: false, reason: 'sandbox.filesystem.disabled is true' }
  return { isSafe: true }
}

// The project's .claude/settings.local.json, as the gate edits it: an object
// whose `sandbox.filesystem` lists are string arrays. Anything else is
// refused, so the gate fails closed instead of writing over what it misreads.
export const parseSettings = (text: string): { settings: Record<string, any> } | { error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim() === '' ? '{}' : text)
  } catch (error) {
    return { error: `it is not valid JSON (${String(error)})` }
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(parsed)) return { error: 'it is not a JSON object' }
  const sandbox = parsed.sandbox
  if (sandbox !== undefined && !isObject(sandbox)) return { error: '`sandbox` is not an object' }
  const filesystem = sandbox?.filesystem
  if (filesystem !== undefined && !isObject(filesystem)) return { error: '`sandbox.filesystem` is not an object' }
  for (const key of ['denyWrite', 'allowWrite']) {
    const list = filesystem?.[key]
    if (list !== undefined && !(Array.isArray(list) && list.every(item => typeof item === 'string')))
      return { error: `\`sandbox.filesystem.${key}\` is not a list of paths` }
  }
  return { settings: parsed }
}

// Why a gate hook that failed refuses its call: the engine skips a failed hook
// that has no handler, which for a gate would let the call through.
export const gateFailure = (failure: { kind: 'throw' | 'timeout'; message?: string }): string =>
  'Moonlight: the gate could not check this call ' +
  (failure.kind === 'timeout' ? '(it ran out of time)' : `(${failure.message ?? 'it failed'})`) +
  ', so it is refused. Ask the operator.'

// An `allowWrite` entry of the effective sandbox that opens a protected folder
// (the entry lies under it, or holds it): with it, a sandboxed command could
// write the gate's own files. `~` and `./` are expanded as the sandbox does.
export const allowWriteBreach = (
  allowWrite: readonly unknown[],
  home: string,
  projectRoot: string,
  protectedRoots: readonly string[],
): string | undefined =>
  allowWrite
    .filter((entry): entry is string => typeof entry === 'string')
    .find(entry => {
      const path = entry.startsWith('~')
        ? `${home}${entry.slice(1)}`
        : entry.startsWith('/')
          ? entry
          : `${projectRoot}/${entry.replace(/^\.\//, '')}`
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path
      return protectedRoots.some(r => isUnder(clean, r) || isUnder(r, clean))
    })
