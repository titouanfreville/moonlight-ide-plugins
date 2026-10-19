import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { MoonlightcodePhaseRequest, MoonlightcodePlan, MoonlightcodeReviewView } from '../types'
import {
  anchorLabel,
  anchorOf,
  anchorOfRows,
  continueDraft,
  excerptOf,
  excerptOfRows,
  nextRowSelection,
  type RowRange,
  formatReview,
  inRepo,
  isInAnchor,
  isSplit,
  lineHunk,
  parseChangedFiles,
  parseFileDiff,
  parseRepoDirs,
  REPO_SEARCH_DEPTH,
  REPO_SEARCH_SKIP,
  toSplitRows,
  baselineOf,
  baselineStatus,
  contentHash,
  effectiveScope,
  parseBaselineIndex,
  parseNumstat,
  type BaselineEntry,
  type BaselineIndex,
  type ChangedFile,
  type DiffLine,
  type Repo,
  type ReviewScope,
  type ReviewLayout,
  counted,
  untrackedCount,
  UNTRACKED_COUNT_MAX,
} from './review'
import {
  canSend,
  drawable,
  formatVerdict,
  isTableRow,
  parsePlan,
  planExcerpt,
  planSpan,
  presentedAnswer,
  type PlanComment,
  type PlanLine,
  type PlanVerdict,
} from './plan'
import { countColors, isColorBlindOption, PHASE_GLYPH, phaseBadge, phaseColor, severityLabel } from './palette'
import { answer, BRIDGE_VERSION, type InboxEntry, parseInboxEntry, pendingEntries, type ReviewEntry, sessionTitleFrom, titleFromTranscript } from './bridge'
import { controlUrl, countMisses, discoveryFile, type Governor, hooksInstalled, isHealthy, nextGovernor } from './daemon'
import {
  allowWriteBreach,
  checkSandbox,
  CLAUDE_PLAN_MODE_TOOLS,
  gateFailure,
  parseSettings,
  allowsNotes,
  allowsWrites,
  DEFAULT_WRITABLE,
  isAllowedInPlan,
  writesGateFiles,
  nextPhase,
  notesFor,
  phaseFromToken,
  phaseLabel,
  PHASES,
  phaseRule,
  isUnderAny,
  mergeOwned,
  ownedByAnyPhase,
  newRootEntries,
  parsePhase,
  PROJECT_CONFIG_DIR,
  PROJECT_SETTINGS,
  projectKey,
  sandboxListsFor,
  type Phase,
  type SandboxWriteLists,
} from './policy'
import {
  DEFAULT_ATTACHED,
  findingPlace,
  findingsContract,
  formatFinding,
  installedSkills,
  isAttached,
  parseFindings,
  parseSkillList,
  sortFindings,
  type TriagedFinding,
} from './findings'

// MoonlightCode for Claude Code. Everything that touches `$` lives in this one
// file: the validator follows `$` only into functions declared in the same
// module. Pure logic is in policy.ts, review.ts, findings.ts and plan.ts.
//
// The daemon's five phases: Plan → Auto → Test → Review → Commit → Plan.
// In the read-only ones (Plan, Commit), project files stay read-only:
// - Bash runs under Claude Code's own sandbox, configured here per phase;
// - Edit / Write / NotebookEdit are checked against the notes folders (open
//   in Plan, frozen in Commit) and /tmp;
// - any other tool runs only when it is on the read-only allow-list.
// The phase is per project (Plan by default), since the sandbox config it
// drives is per project too: ~/.moonlight/mod/projects/<root>/phase, which only this mod writes:
// /phase (typed by the operator) or request_phase (the agent asks, the
// operator approves). In every phase, the gate's own files (the mod,
// ~/.moonlight, the project's .moonlight/) are never writable by the agent.
// To develop the mod, its own folder is unlocked while
// ~/.moonlight/mod/dev-unlock exists, a file only the operator can create.

type $ = EngineInterface

const OWNED_KEY = 'owned-sandbox-lists'
const POLL_MS = 2000
// The phase view: a band above the prompt where the surface draws one
// (terminal, desktop), and this pane everywhere (VS Code and mobile have no band).
const PANE = 'moonlight-phase'
const SURFACES_WITHOUT_BAND: readonly string[] = ['vscode', 'mobile']
const TOOL = 'request_phase'

let root: string | undefined
let appliedPhase: Phase | undefined
let deniedEntries: readonly string[] = []
// The notes folders, and the scratch folders (/tmp, TMPDIR) open in every phase.
let noteRoots: string[] = []
let scratchRoots: string[] = []
let home: string | undefined
let projectDir: string | undefined
let modRoot: string | undefined
// Who governs this session: the daemon (the mod stands by) or the mod. Unset
// until session.start decides; the gate hooks govern unless it is 'daemon'.
let governor: Governor | undefined
let probing = false
let missedProbes = 0
let protectedRoots: string[] = []

// What the band and the dialog draw from: written on change, read while drawing.
const phaseState = atom({ plugin: 'moonlightcode', key: 'phase' } as const, 'plan' as Phase)

// Each phase's badge and colour, on the hint line, the pane and the status.
// The colour-blind mode (the `colorBlind` option): Okabe–Ito colours. The
// symbols and marks that carry each meaning stay in every mode (palette.ts).
let isColorBlind = false

const phaseStyle = (phase: Phase): { badge: string; color: string } => ({
  badge: phaseBadge(phase),
  color: phaseColor(phase, isColorBlind),
})
const governorState = atom({ plugin: 'moonlightcode', key: 'governor' } as const, null as Governor | null)
const pendingState = atom({ plugin: 'moonlightcode', key: 'pending' } as const, null)
const mcpAllowedState = atom({ plugin: 'moonlightcode', key: 'mcpAllowed' } as const, [] as string[])
const sessionTitleState = atom({ plugin: 'moonlightcode', key: 'sessionTitle' } as const, null as string | null)

const MCP_ALLOW_ONCE = 'Allow once'
const MCP_ALLOW_SESSION = 'Allow for this session'
const MCP_DENY = 'Deny'

// An MCP tool a read-only phase does not list: the operator decides, since only
// they know what that server does. Their answer, a refusal when the dialog is
// dismissed or there is no one to ask (a -p run).
const askForMcpTool = async ($: $, tool: string, label: string): Promise<{ allowed: boolean; said: string }> => {
  if ((await read($, mcpAllowedState)).includes(tool)) return { allowed: true, said: MCP_ALLOW_SESSION }
  const said = await $.ui
    .ask(`Moonlight (${label}) is read-only, and ${tool} is not on its read-only list. Let it run?`, {
      header: 'MCP tool',
      options: [MCP_ALLOW_ONCE, MCP_ALLOW_SESSION, MCP_DENY],
    })
    .catch(() => MCP_DENY)
  if (said === MCP_ALLOW_SESSION) await update($, mcpAllowedState, list => [...(list ?? []), tool])
  return { allowed: said === MCP_ALLOW_ONCE || said === MCP_ALLOW_SESSION, said }
}

let pending: MoonlightcodePhaseRequest | undefined

const setPending = async ($: $, request: MoonlightcodePhaseRequest | undefined): Promise<void> => {
  pending = request
  await update($, pendingState, () => request ?? null)
  void publishState($).catch(() => undefined)
}

// ---- Paths ----

// A deny-list on spellings is best effort: compare without case, since a case
// alias keeps its own spelling on a case-insensitive disk.
const isUnderAnyFolded = (path: string, roots: readonly string[]): boolean =>
  isUnderAny(path.toLowerCase(), roots.map(r => r.toLowerCase()))

const isDevUnlocked = async ($: $): Promise<boolean> =>
  home !== undefined && (await $.fs.exists(`${home}/.moonlight/mod/dev-unlock`))

const listRoot = async ($: $, projectRoot: string): Promise<string[]> =>
  (await $.fs.list(projectRoot)).map(entry => entry.name)

const realPathOf = async ($: $, path: string): Promise<string | undefined> => {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.realPath
}

// A notes folder that is a symlink could point into src/: it is skipped.
const resolveNoteRoots = async ($: $, projectRoot: string): Promise<string[]> => {
  const roots: string[] = []
  for (const name of DEFAULT_WRITABLE) {
    const path = `${projectRoot}/${name}`
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat === undefined) roots.push(path)
    else if (stat.isLink) $.ui.toast(`Moonlight: ${name} is a symlink, not writable in Plan`)
    else roots.push(path)
  }
  return roots
}

const resolveScratchRoots = async ($: $): Promise<string[]> => {
  const roots: string[] = []
  for (const tmp of ['/tmp', await $.env.get('TMPDIR')]) {
    if (tmp === undefined || tmp === '') continue
    const real = await realPathOf($, tmp)
    if (real !== undefined) roots.push(real)
  }
  return roots
}

// Where a write would land: the nearest existing ancestor's realPath plus the
// segments that do not exist yet. Undefined when it cannot be told safely.
const resolveTarget = async ($: $, path: string): Promise<string | undefined> => {
  if (root === undefined) return undefined
  let current = path.startsWith('/') ? path : `${root}/${path}`
  const missing: string[] = []
  while (current !== '' && current !== '/') {
    const stat = await $.fs.stat(current, { resolve: true }).catch(() => undefined)
    if (stat !== undefined) {
      if (stat.realPath === undefined) return undefined
      if (missing.some(s => s === '..' || s === '.')) return undefined
      return [stat.realPath, ...missing].join('/')
    }
    const cut = current.lastIndexOf('/')
    missing.unshift(current.slice(cut + 1))
    current = current.slice(0, cut)
  }
  return undefined
}

// ---- Phase and sandbox ----

// No project known yet reads as Plan, the safe default.
const readPhase = async ($: $): Promise<Phase> =>
  projectDir === undefined ? 'plan' : parsePhase(await $.fs.read(`${projectDir}/phase`).catch(() => undefined))

const settingsPath = (projectRoot: string): string => `${projectRoot}/.claude/settings.local.json`

// Per project: the store is the plugin's, shared by every session on the
// machine, and one key for all let another project's lists stand for this
// one's (its own stale entries then stayed, read as the user's).
const ownedKey = (projectRoot: string): string => `${OWNED_KEY}:${projectKey(projectRoot)}`

// Puts the mod's lists for this project in its settings, replacing what the mod
// added last time and keeping the user's own entries. With no record for the
// project, whatever a phase would have added here counts as the mod's.
// `isOff`: shell commands run outside the sandbox (the writable phases).
const writeSandboxLists = async (
  $: $,
  projectRoot: string,
  owned: (entries: string[]) => SandboxWriteLists,
  isOff = false,
): Promise<SandboxWriteLists> => {
  const path = settingsPath(projectRoot)
  const text = await $.fs.read(path).catch(() => '{}')
  const parsed = parseSettings(text)
  if ('error' in parsed) {
    // Thrown: the gate hooks' handlers then refuse every call they guard.
    $.ui.toast(`Moonlight: ${path} cannot be read (${parsed.error}). Fix it: until then the gate refuses tools.`)
    throw new Error(`${path}: ${parsed.error}`)
  }
  const settings = parsed.settings
  const sandbox = (settings.sandbox ??= {})
  sandbox.enabled = !isOff
  sandbox.allowUnsandboxedCommands = isOff
  const filesystem = (sandbox.filesystem ??= {})
  const entries = await listRoot($, projectRoot)
  const recorded = (await $.store.get(ownedKey(projectRoot))) as SandboxWriteLists | undefined
  const previous = recorded ?? ownedByAnyPhase(DEFAULT_WRITABLE, entries)
  const lists = owned(entries)
  filesystem.denyWrite = mergeOwned(filesystem.denyWrite ?? [], previous.denyWrite, lists.denyWrite)
  filesystem.allowWrite = mergeOwned(filesystem.allowWrite ?? [], previous.allowWrite, lists.allowWrite)
  const next = `${JSON.stringify(settings, null, 2)}\n`
  if (next !== text) await $.fs.write(path, next)
  await $.store.set(ownedKey(projectRoot), lists)
  return lists
}

const applySandbox = async ($: $, phase: Phase): Promise<void> => {
  if (root === undefined) return
  // The writable phases run shell commands outside the sandbox: gh, nx and the
  // like need the network, sockets and folders outside the project, and the
  // phase already lets the agent write. Plan and Commit keep it.
  const owned = await writeSandboxLists($, root, entries => sandboxListsFor(phase, DEFAULT_WRITABLE, entries), allowsWrites(phase))
  deniedEntries = owned.denyWrite
  appliedPhase = phase
  await update($, phaseState, () => phase)
  // The hint line under the prompt shows the phase where it draws; the status
  // only where it does not (the VS Code extension today), never both.
  const surfaces = await $.session.surfaces().catch(() => [] as string[])
  if (surfaces.some(s => SURFACES_WITHOUT_BAND.includes(s)))
    $.ui.status(`Moonlight: ${phaseStyle(phase).badge.trim()} (${phaseRule(phase)})`)
}

const syncPhase = async ($: $): Promise<Phase> => {
  const phase = await readPhase($)
  if (phase !== appliedPhase) await applySandbox($, phase)
  return phase
}

// Only the mod changes the phase: the agent's tools cannot write the file.
const setPhase = async ($: $, to: Phase): Promise<Phase> => {
  if (projectDir === undefined) return 'plan'
  await $.fs.write(`${projectDir}/phase`, `${to}\n`)
  return syncPhase($)
}

// Where things are, for the gate and the Review panel alike.
const initPaths = async ($: $): Promise<void> => {
  // The project root, not the cwd: a shell `cd` moves the cwd, not the root.
  root = await realPathOf($, await $.session.root())
  home = await $.env.get('HOME')
  if (home !== undefined && root !== undefined) projectDir = `${home}/.moonlight/mod/projects/${projectKey(root)}`
  modRoot = (await realPathOf($, $.plugin.root)) ?? $.plugin.root
  protectedRoots = [modRoot]
  if (home !== undefined) {
    protectedRoots.push((await realPathOf($, `${home}/.moonlight`)) ?? `${home}/.moonlight`)
    // Where the backstop is registered.
    protectedRoots.push(`${home}/.claude/settings.json`)
  }
  if (root !== undefined) {
    protectedRoots.push(`${root}/${PROJECT_CONFIG_DIR}`, ...PROJECT_SETTINGS.map(file => `${root}/${file}`))
    noteRoots = await resolveNoteRoots($, root)
    scratchRoots = await resolveScratchRoots($)
  }
}

const initGate = async ($: $): Promise<void> => {
  await initPaths($)
  if (root !== undefined) await syncPhase($)
}

// ---- Daemon hand-over ----

const PROBE_TIMEOUT_MS = 3000

// Whether the MoonlightCode daemon governs Claude Code right now: it answers
// on loopback and reports its hooks installed. Any doubt reads as no, so the
// mod keeps the gate.
// `watch`: the daemon is known to govern, so its health is enough (cheap); at
// session start, its hooks must be installed too.
const daemonGoverns = async ($: $, watch = false): Promise<boolean> => {
  const file = discoveryFile(await $.env.get('HOME'), await $.env.get('MOONLIGHT_HOME'))
  if (file === undefined || !(await $.fs.exists(file))) return false
  const url = controlUrl(await $.fs.read(file))
  if (url === undefined) return false
  const answer = $.http
    .fetch(`${url}/control/${watch ? 'health' : 'gating-status'}`)
    .then(response => response.ok && (watch ? isHealthy(response.text) : hooksInstalled(response.text)))
    .catch(() => false)
  const late = $.clock.sleep(PROBE_TIMEOUT_MS).then(() => false)
  return Promise.race([answer, late])
}

// Whether another session on this project is governed by the mod right now:
// its state is published (only a governing mod publishes) and its heartbeat fresh.
const projectGovernedElsewhere = async ($: $): Promise<boolean> => {
  const sessions = await sessionsDir($)
  if (sessions === undefined || root === undefined || !(await $.fs.exists(sessions))) return false
  const me = await $.session.id()
  const now = await $.clock.now()
  for (const entry of await $.fs.list(sessions)) {
    if (entry.kind !== 'dir' || entry.name === me) continue
    try {
      const lastBeat = await $.fs.stat(`${sessions}/${entry.name}/heartbeat`)
      if (now - lastBeat.mtimeMs > HEARTBEAT_FRESH_MS) continue
      const state = JSON.parse(await $.fs.read(`${sessions}/${entry.name}/state.json`)) as { root?: unknown }
      if (state.root === root) return true
    } catch {
      // No heartbeat or no state: not a session the mod governs.
    }
  }
  return false
}

// The backstop's own limit (hooks/backstop.sh): a fresher beat is a live mod.
const HEARTBEAT_FRESH_MS = 10_000

// While the daemon governs, the mod's own deny entries come out of the project's
// sandbox (the gate's own files stay denied): leftovers from an earlier phase
// would block the session the daemon governs.
const releaseSandbox = async ($: $): Promise<void> => {
  if (root === undefined) return
  await writeSandboxLists($, root, entries => sandboxListsFor('auto', DEFAULT_WRITABLE, entries))
}

const setGovernor = async ($: $, to: Governor): Promise<void> => {
  governor = to
  await update($, governorState, () => to)
}

// While the daemon governs, the mod checks on it each tick, and takes the
// session over once it has stopped (TAKEOVER_AFTER_MISSES probes in a row), in Plan: the stored phase is not trusted, since
// the mod's sandbox did not guard it while the daemon governed. The operator
// and the agent are told.
const watchDaemon = async ($: $): Promise<void> => {
  if (governor !== 'daemon' || probing) return
  probing = true
  try {
    const governs = await daemonGoverns($, true).catch(() => false)
    missedProbes = countMisses(missedProbes, governs)
    if (nextGovernor(governor, governs, missedProbes) === 'daemon') return
    await setGovernor($, 'mod')
    await tryStart($, 'the gate', async () => {
      await initPaths($)
      // The phase is the project's: another live session the mod governs here
      // has kept it guarded, so it stands; otherwise it is not trusted.
      if (await projectGovernedElsewhere($)) await syncPhase($)
      else await setPhase($, 'plan')
    })
    await startGoverned($)
    const phase = await read($, phaseState)
    $.ui.toast(`Moonlight: the daemon stopped governing; this session is now gated by the mod (${phaseLabel(phase)})`)
    await tellModel(
      $,
      `[moonlight] The MoonlightCode daemon stopped answering: this session is now governed by the moonlightcode mod, ` +
        `in the ${phaseLabel(phase)} phase (${phaseRule(phase)}). Use mcp__moonlightcode__request_phase and ` +
        'mcp__moonlightcode__present_plan from now on, not the mcp__moonlight__ verbs.',
    )
  } finally {
    probing = false
  }
}

// ---- Write guard ----

const denyWrite = (path: string, phase: Phase): { deny: string } => ({
  deny:
    phase === 'commit'
      ? `Moonlight (Commit): ${path} cannot be written: the commit gate freezes everything until you commit, ` +
        `${DEFAULT_WRITABLE.map(w => `${w}/`).join(', ')} included. Only /tmp stays writable. ` +
        'Wait for the operator to commit, or ask with request_phase.'
      : `Moonlight (${phaseLabel(phase)}): ${path} is a project file and ${phaseLabel(phase)} is read-only. ` +
        `Write notes under ${DEFAULT_WRITABLE.map(w => `${w}/`).join(', ')} or /tmp, ` +
        'then propose the plan.',
})

const guardSelf = async ($: $, path: string, target: string | undefined): Promise<{ deny: string } | undefined> => {
  const asGiven = path.startsWith('/') ? path : root === undefined ? undefined : `${root}/${path}`
  const candidates = [target, asGiven].filter((c): c is string => c !== undefined)
  const unlocked = await isDevUnlocked($)
  const roots = protectedRoots.filter(r => !(unlocked && r === modRoot))
  if (!candidates.some(c => isUnderAnyFolded(c, roots))) return undefined
  return {
    deny:
      `Moonlight: ${path} belongs to the gate itself (the mod, ~/.moonlight, ${PROJECT_CONFIG_DIR}/ or Claude Code's settings) ` +
      'and is never writable by the agent, in any phase. Ask the operator.',
  }
}

const guardWrite = async ($: $, path: string): Promise<{ deny: string } | undefined> => {
  // The daemon's own hooks gate this session; the mod still keeps its own files
  // out of the file tools' reach, since a takeover reads them.
  if (governor === 'daemon') return guardSelf($, path, await resolveTarget($, path))
  const phase = await syncPhase($)
  const target = await resolveTarget($, path)
  const self = await guardSelf($, path, target)
  if (self !== undefined) return self
  if (allowsWrites(phase)) return undefined
  const open = allowsNotes(phase) ? [...noteRoots, ...scratchRoots] : scratchRoots
  if (target === undefined || !isUnderAny(target, open)) return denyWrite(path, phase)
  return undefined
}

// ---- Shell gate (Bash, Monitor) ----

// Why a shell command must not run now, if it must not: the sandbox is not
// safe, an allowWrite opens the gate's own files, or the deny list this mod
// applied is not the one the engine runs under (fail closed).
// Outside the sandbox, the gate's own files (the phase, the project settings)
// are kept out of reach by reading the command: a write to them is refused.
const gateFilesRefusal = (command: string, tool: string, phase: Phase): { deny: string } | undefined =>
  writesGateFiles(command)
    ? {
        deny:
          `Moonlight (${phaseLabel(phase)}): ${tool} refused, it would write the gate's own files ` +
          '(.moonlight, .claude/settings). Only the operator changes the phase and the settings.',
      }
    : undefined

const shellRefusal = async ($: $, tool: string, phase: Phase): Promise<{ deny: string } | undefined> => {
  const settings = await $.settings.read()
  const health = checkSandbox(settings)
  if (!health.isSafe) return { deny: `Moonlight (${phase}): ${tool} refused, the sandbox is not safe: ${health.reason}.` }
  const allowed = ((settings.sandbox as any)?.filesystem?.allowWrite ?? []) as unknown[]
  const breach =
    home !== undefined && root !== undefined
      ? allowWriteBreach(Array.isArray(allowed) ? allowed : [], home, root, protectedRoots)
      : undefined
  if (breach !== undefined)
    return {
      deny:
        `Moonlight (${phase}): ${tool} refused, the sandbox's allowWrite entry ${breach} opens the gate's own files. ` +
        'Ask the operator to remove it from the settings.',
    }
  const effective = ((settings.sandbox as any)?.filesystem?.denyWrite ?? []) as string[]
  const missing = deniedEntries.filter(entry => !effective.includes(entry))
  if (appliedPhase !== phase || missing.length > 0)
    return { deny: `Moonlight (${phase}): ${tool} refused, the deny list is not in force yet.` }
  return undefined
}

// After a shell command in a read-only phase. The root stays writable to the
// sandbox: any top-level entry the command created is denied from now on, and
// the agent is told.
const afterShell = async <R extends { deny?: string }>($: $, phase: Phase, ran: R): Promise<R> => {
  if (allowsWrites(phase) || root === undefined || ran.deny !== undefined) return ran
  const created = newRootEntries(await listRoot($, root), deniedEntries, notesFor(phase, DEFAULT_WRITABLE))
  if (created.length === 0) return ran
  await applySandbox($, phase)
  const names = created.join(', ')
  const label = phaseLabel(phase)
  $.ui.toast(`Moonlight: ${label} — new top-level entry created: ${names}`)
  return {
    ...ran,
    context: [
      `Moonlight (${label}): this command created ${names} at the project root. ` +
        `${label} is read-only (${phaseRule(phase)}): it is now write-denied and left for the operator to review. ` +
        (allowsNotes(phase) ? `Write notes under ${DEFAULT_WRITABLE.map(w => `${w}/`).join(', ')} instead.` : 'Only /tmp stays writable.'),
    ],
  }
}

// ---- Heartbeat ----

// The backstop (hooks/backstop.sh, a classic PreToolUse hook outside this mod)
// denies writes for a session whose heartbeat is missing or stale: no mod
// loaded means no gate, so fail closed.
const beat = async ($: $): Promise<void> => {
  if (home === undefined) return
  const id = await $.session.id()
  if (!SESSION_ID.test(id)) return
  await $.fs.write(`${home}/.moonlight/mod/sessions/${id}/heartbeat`, `${await $.clock.now()}\n`)
}

const tick = async ($: $): Promise<void> => {
  if (governor === 'daemon') await watchDaemon($)
  else await syncPhase($)
  await beat($)
  if (governor === 'mod') {
    await applyInbox($)
    await refreshReview($)
    await refreshTitle($)
    await publishState($)
  }
}

// The session's name, from its transcript every TITLE_REFRESH_TICKS ticks (and
// at the first): Claude Code names a session after a turn or two, and the
// operator may rename it at any time. Not left to the classic hooks: they do
// not reach every session.
const TITLE_REFRESH_TICKS = 15
let titleTicks = 0
let transcriptPath: string | undefined

const refreshTitle = async ($: $): Promise<void> => {
  titleTicks += 1
  if (titleTicks % TITLE_REFRESH_TICKS !== 1) return
  const path = await findTranscript($).catch(() => undefined)
  if (path !== undefined) await noteTitle($, undefined, path).catch(() => undefined)
}

// Where Claude Code keeps this session's transcript: under its project folder,
// named after the session; searched for once when the launch folder differs
// from the root.
const findTranscript = async ($: $): Promise<string | undefined> => {
  if (transcriptPath !== undefined) return transcriptPath
  const id = await $.session.id()
  if (home === undefined || !SESSION_ID.test(id)) return undefined
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
  const guess = root === undefined ? undefined : `${config}/projects/${projectKey(root)}/${id}.jsonl`
  if (guess !== undefined && (await $.fs.exists(guess))) return (transcriptPath = guess)
  const found = await $.process.run(['find', `${config}/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
  const first = found.stdout.split('\n').find(line => line.trim() !== '')
  return first === undefined ? undefined : (transcriptPath = first.trim())
}

// The review the IDE shows: recomputed when a baseline was taken or a decision
// applied, and every REVIEW_REFRESH_TICKS ticks for what changed otherwise
// (a shell command, an edit outside the session). git runs only then.
const REVIEW_REFRESH_TICKS = 5
let reviewDirty = true
let reviewTicks = 0
let bridgeSkills: string[] = []

const refreshReview = async ($: $): Promise<void> => {
  reviewTicks += 1
  if (!reviewDirty && reviewTicks % REVIEW_REFRESH_TICKS !== 0) return
  reviewDirty = false
  // A failed refresh keeps the last list: the phase and plan still publish.
  await loadChangedFiles($).catch(() => undefined)
  bridgeSkills = await runnableSkills($).then(r => r.runnable, () => bridgeSkills)
}

// ---- IDE bridge (bridge.ts) ----

// The session's own folder, beside its heartbeat.
const sessionFolder = async ($: $): Promise<{ dir: string; id: string } | undefined> => {
  const sessions = await sessionsDir($)
  const id = await $.session.id()
  return sessions === undefined || !SESSION_ID.test(id) ? undefined : { dir: `${sessions}/${id}`, id }
}

let publishedState: string | undefined

// What the IDE panels show, written while the mod governs and only when it
// changed: the phase, the request waiting, the latest plan.
const publishState = async ($: $): Promise<void> => {
  if (governor !== 'mod') return
  const at = await sessionFolder($)
  if (at === undefined) return
  const doc = await read($, planDocState)
  const state = {
    v: BRIDGE_VERSION,
    sessionId: at.id,
    root: root ?? null,
    phase: await read($, phaseState),
    title: await read($, sessionTitleState),
    pending: pending === undefined ? null : { to: pending.to, reason: pending.reason },
    plan: doc === null ? null : doc,
    review: await reviewForIde($),
  }
  const key = JSON.stringify(state)
  if (key === publishedState) return
  await $.fs.write(`${at.dir}/state.json`, `${JSON.stringify({ ...state, updatedMs: await $.clock.now() })}\n`)
  publishedState = key
}

// The session's name, as the IDE panels list it: Claude Code's own title once it
// has one; until then the first line of the operator's first prompt, which is
// what the title is made from anyway.
// `transcript`: where Claude Code keeps the name it shows (the operator's rename,
// else the one it generated); read with grep, since a transcript runs to megabytes.
const noteTitle = async ($: $, title: string | undefined, transcript: string | undefined, prompt?: string): Promise<void> => {
  let given = title?.trim() || undefined
  if (given === undefined && transcript !== undefined && transcript !== '') {
    const found = await $.process
      .run(['grep', '-h', '-E', '"type":"(custom-title|ai-title)"', '--', transcript])
      .catch(() => undefined)
    given = found === undefined ? undefined : titleFromTranscript(found.stdout)
  }
  const named = sessionTitleFrom(given, prompt, await read($, sessionTitleState))
  if (named === (await read($, sessionTitleState))) return
  await update($, sessionTitleState, () => named)
  await publishState($)
}

const reviewForIde = async ($: $) => {
  const run = await read($, reviewRunState)
  return {
    scope: effectiveScope(await read($, reviewScopeState), await read($, reviewHasBaselinesState)),
    files: (await read($, reviewFilesState)).map(f => ({
      path: f.path,
      absolute: `${f.repo}/${f.repoPath}`,
      status: f.status,
      added: f.added,
      removed: f.removed,
      ...(f.baseline !== undefined ? { baseline: f.baseline } : {}),
      ...(f.skipped !== undefined ? { skipped: f.skipped } : {}),
    })),
    comments: await read($, reviewCommentsState),
    findings: await read($, reviewFindingsState),
    findingsStatus: await read($, reviewFindingsStatusState),
    run: run === null ? null : { skill: run.skill },
    skills: bridgeSkills,
  }
}

// The operator's decisions from the IDE, oldest first, each answered in the
// outbox; the IDE removes both files once it has read the answer.
const applyInbox = async ($: $): Promise<void> => {
  const at = await sessionFolder($)
  if (at === undefined || !(await $.fs.exists(`${at.dir}/inbox`))) return
  const names = async (dir: string) =>
    (await $.fs.exists(dir)) ? (await $.fs.list(dir)).filter(e => e.kind === 'file').map(e => e.name) : []
  const answered: { name: string; ok: boolean; message: string }[] = []
  for (const name of pendingEntries(await names(`${at.dir}/inbox`), await names(`${at.dir}/outbox`))) {
    try {
      const entry = parseInboxEntry(await $.fs.read(`${at.dir}/inbox/${name}`))
      answered.push({ name, ...('error' in entry ? { ok: false, message: entry.error } : await applyEntry($, entry)) })
    } catch (error) {
      answered.push({ name, ok: false, message: String(error) })
    }
  }
  if (answered.length === 0) return
  // The state first, the answers after: an IDE that reads its answer then the
  // state must find the change it asked for already there.
  reviewDirty = true
  await refreshReview($)
  await publishState($)
  for (const a of answered) await $.fs.write(`${at.dir}/outbox/${a.name}`, answer(a.ok, a.message))
}

// One review decision, through the functions the Review panel calls.
const applyReviewEntry = async ($: $, entry: ReviewEntry): Promise<{ ok: boolean; message: string }> => {
  reviewDirty = true
  switch (entry.kind) {
    case 'review-comment': {
      if (!(await read($, reviewFilesState)).some(f => f.path === entry.path))
        return { ok: false, message: `${entry.path} is not among the files under review.` }
      const id = `c${await $.clock.now()}`
      const { kind: _kind, ...comment } = entry
      await update($, reviewCommentsState, list => [...(list ?? []), { ...comment, id }])
      return { ok: true, message: id }
    }
    case 'review-comment-edit': {
      let found = false
      await update($, reviewCommentsState, list =>
        (list ?? []).map(c => (c.id === entry.id ? ((found = true), { ...c, body: entry.body }) : c)),
      )
      return found ? { ok: true, message: 'Comment updated.' } : { ok: false, message: 'No such comment: it was sent or removed.' }
    }
    case 'review-uncomment':
      await removeReviewComment($, entry.id)
      return { ok: true, message: 'Comment removed.' }
    case 'review-submit': {
      const message = await submitReview($, entry.summary)
      return { ok: message.startsWith('Review submitted'), message }
    }
    case 'review-accept': {
      const message = await acceptReview($)
      return { ok: message.startsWith('Review accepted'), message }
    }
    case 'review-accept-file':
      return acceptReviewFile($, entry.path)
    case 'review-run': {
      const { runnable } = await runnableSkills($)
      if (!runnable.includes(entry.skill))
        return { ok: false, message: `${entry.skill} is not a review skill this session can run (${runnable.join(', ') || 'none'}).` }
      const message = await runReviewSkill($, entry.skill)
      return { ok: (await read($, reviewRunState))?.skill === entry.skill, message }
    }
    case 'review-cancel':
      await cancelAiReview($)
      return { ok: true, message: 'AI review cancelled.' }
    case 'review-scope':
      await update($, reviewScopeState, () => entry.scope)
      await loadChangedFiles($)
      return { ok: true, message: `Review scope: ${entry.scope === 'session' ? 'changes made in this session' : 'changes since the last commit'}.` }
    case 'finding': {
      if (!(await read($, reviewFindingsState)).some(f => f.id === entry.id))
        return { ok: false, message: 'No such finding: the review was sent or replaced.' }
      await decideFinding($, entry.id, entry.decision)
      if (entry.note !== undefined) await saveFindingNote($, entry.id, entry.note)
      return { ok: true, message: 'Finding updated.' }
    }
  }
}

// One decision, through the functions the panes call.
const applyEntry = async ($: $, entry: InboxEntry): Promise<{ ok: boolean; message: string }> => {
  if (entry.kind !== 'phase' && entry.kind !== 'request' && entry.kind !== 'plan') return applyReviewEntry($, entry)
  if (entry.kind === 'phase') {
    const now = await operatorSetPhase($, entry.to)
    $.ui.toast(`Moonlight: phase is now ${phaseLabel(now)} (set from the IDE)`)
    return { ok: now === entry.to, message: `The phase is ${now}.` }
  }
  if (entry.kind === 'request') {
    if (pending === undefined) return { ok: false, message: 'No phase request is waiting: it was answered already.' }
    await decide($, entry.approve, entry.reason)
    return { ok: true, message: entry.approve ? `The phase is ${await readPhase($)}.` : 'Denied: the agent was told.' }
  }
  const doc = await read($, planDocState)
  if (doc === null || doc.version !== entry.version)
    return { ok: false, message: `Plan v${entry.version} is not the current plan${doc !== null ? ` (v${doc.version} is)` : ''}.` }
  if (doc.decided !== undefined) return { ok: false, message: `Plan v${doc.version} is already ${VERDICT_WORD[doc.decided]}.` }
  const count = parsePlan(doc.markdown).length
  const outside = entry.comments.find(c => c.start < 1 || c.end < c.start || c.end > count)
  if (outside !== undefined) return { ok: false, message: `No such lines ${outside.start}-${outside.end}: the plan has ${count}.` }
  for (const c of entry.comments) await addPlanComment($, c.start, c.end, c.body)
  // A rejection's reason is its own text; any other note joins the panel's.
  if (entry.verdict !== 'reject' && entry.note !== '')
    await update($, planNoteState, current => [current.trim(), entry.note].filter(t => t !== '').join('\n\n'))
  const message = await sendPlanVerdict($, entry.verdict, entry.verdict === 'reject' ? entry.note : undefined)
  return { ok: (await read($, planDocState))?.decided === entry.verdict, message }
}

// ---- Phase control ----

// A note the model reads at its next turn; starts none.
const tellModel = async ($: $, text: string): Promise<void> => {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

// A prompt the model acts on: a turn of its own, once the session is idle.
const askModel = async ($: $, text: string): Promise<void> => {
  await $.prompt.submit({ text })
}

// `reason`: why the operator denied it, when they said (the IDE asks).
const decide = async ($: $, isApproved: boolean, reason?: string): Promise<void> => {
  const request = pending
  await setPending($, undefined)
  if (request === undefined) return
  if (!isApproved) {
    $.ui.toast(`Moonlight: phase change to ${request.to} denied`)
    const denied =
      `[moonlight] The operator DENIED the phase change to ${request.to}` +
      (reason !== undefined ? `: ${reason}` : '') +
      '. Stay in the current phase.'
    // The agent may be idle, waiting on this answer: a prompt wakes it.
    void askModel($, denied).catch(() => tellModel($, denied))
    return
  }
  const now = await setPhase($, request.to)
  $.ui.toast(`Moonlight: phase is now ${phaseLabel(now)} (${phaseRule(now)})`)
  const told = `[moonlight] The operator APPROVED the phase change. The phase is now ${now}: ${phaseRule(now)}.`
  void askModel($, told).catch(() => tellModel($, told))
}

// The operator's own change (/phase, the hint, the pane): any pending request
// is moot, and the agent learns the new rule at its next turn, from a note
// that starts no turn of its own.
const operatorSetPhase = async ($: $, to: Phase): Promise<Phase> => {
  const before = await readPhase($)
  await setPending($, undefined)
  const now = await setPhase($, to)
  if (now !== before)
    await tellModel($, `[moonlight] The operator changed the phase to ${now}: ${phaseRule(now)}.`).catch(() => undefined)
  return now
}

// Says where the pane stands: a surface may place no panes at all.
// A pane that cannot open never fails what opened it (a request, a command).
const openPhasePane = async ($: $, isFocused: boolean): Promise<string> => {
  try {
    const opened = await $.ui.open(isFocused ? { id: PANE, title: 'Moonlight', focus: true } : { id: PANE, title: 'Moonlight' })
    return opened.isPlaced ? 'pane placed' : `pane not placed: ${opened.reason}`
  } catch (error) {
    return `pane not opened: ${String(error)}`
  }
}

// ---- Review panel ----

// A pane docked on the right in the terminal's fullscreen layout (inline
// elsewhere): the changed files, then one file's diff where a click on a line
// number anchors a comment (a second click extends it to a range).
const REVIEW_PANE = 'moonlight-review'
const reviewViewState = atom({ plugin: 'moonlightcode', key: 'reviewView' } as const, { kind: 'files' } as MoonlightcodeReviewView)
const reviewFilesState = atom({ plugin: 'moonlightcode', key: 'reviewFiles' } as const, [])
const reviewRowsState = atom({ plugin: 'moonlightcode', key: 'reviewRows' } as const, [])
const reviewSelectionState = atom({ plugin: 'moonlightcode', key: 'reviewSelection' } as const, null)
const reviewCommentsState = atom({ plugin: 'moonlightcode', key: 'reviewComments' } as const, [])
// Why there is nothing to review, when it is not simply "no changes".
const reviewProblemState = atom({ plugin: 'moonlightcode', key: 'reviewProblem' } as const, null)
// Unified or side by side; `auto` picks side by side when the panel is wide enough.
const reviewLayoutState = atom({ plugin: 'moonlightcode', key: 'reviewLayout' } as const, 'auto' as ReviewLayout)
// Docked panel opened at the terminal's full width, like a modal.
const reviewExpandedState = atom({ plugin: 'moonlightcode', key: 'reviewExpanded' } as const, false)
// This session's changes (against baselines) or everything against HEAD.
const reviewScopeState = atom({ plugin: 'moonlightcode', key: 'reviewScope' } as const, 'auto' as ReviewScope)
const reviewHasBaselinesState = atom({ plugin: 'moonlightcode', key: 'reviewHasBaselines' } as const, false)
// The lines of a comment being written, before its last one.
const reviewDraftState = atom({ plugin: 'moonlightcode', key: 'reviewDraft' } as const, [] as string[])
// The rows picked in the open file's diff; `reviewSelection` is their anchor.
const reviewRowSelectionState = atom({ plugin: 'moonlightcode', key: 'reviewRowSelection' } as const, null as RowRange | null)
// What an attached review skill found, with the operator's triage.
const reviewFindingsState = atom({ plugin: 'moonlightcode', key: 'reviewFindings' } as const, [] as TriagedFinding[])
const reviewFindingsStatusState = atom({ plugin: 'moonlightcode', key: 'reviewFindingsStatus' } as const, null as string | null)
const reviewNoteForState = atom({ plugin: 'moonlightcode', key: 'reviewNoteFor' } as const, null as string | null)
// One AI review at a time; only its skill's prompt gets the contract.
const reviewRunState = atom(
  { plugin: 'moonlightcode', key: 'reviewRun' } as const,
  null as { skill: string; isPrompted: boolean; isFromPanel?: boolean; turnId?: string } | null,
)

// The prompt a panel run submits; `turn.start` knows the run's turn by it.
const runPrompt = (skill: string): string => `Run the ${skill} skill to review my changes.`

// The latest turn to start: where a skill started by hand runs.
let lastTurnId: string | undefined
const reviewPickingState = atom({ plugin: 'moonlightcode', key: 'reviewPicking' } as const, false)

// Resolved on first use, so the panel works before or without the gate's init.
let reviewRoot: string | undefined

// The session's project root; the plugin test kit's engine has no `root()`,
// so fall back to the cwd there.
const sessionRoot = async ($: $): Promise<string> => {
  try {
    return await $.session.root()
  } catch {
    return await $.session.cwd()
  }
}

const resolveReviewRoot = async ($: $): Promise<string | undefined> =>
  (reviewRoot ??= root ?? (await realPathOf($, await sessionRoot($))))

// Runs git in `cwd`, the session root by default.
const git = async ($: $, args: readonly string[], cwd?: string): Promise<string> => {
  const where = cwd ?? (await resolveReviewRoot($))
  if (where === undefined) return ''
  const ran = await $.process.run(['git', ...args], { cwd: where })
  return ran.stdout
}

// ---- Baselines ----

// Each file as it was before the agent first changed it this session, so a
// review shows the agent's changes, git or not. Under ~/.moonlight, which the
// agent cannot write. Dropped on Accept and on /clear; a session left without
// either is swept once stale.
const BASELINE_STALE_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_ID = /^[A-Za-z0-9_-]+$/

// HOME is read here too, so the panel works before or without the gate's init.
const sessionsDir = async ($: $): Promise<string | undefined> => {
  const at = home ?? (await $.env.get('HOME').catch(() => undefined))
  return at === undefined || at === '' ? undefined : `${at}/.moonlight/mod/sessions`
}

const baselineDir = async ($: $, sessionId?: string): Promise<string | undefined> => {
  const sessions = await sessionsDir($)
  if (sessions === undefined) return undefined
  const id = sessionId ?? (await $.session.id())
  return SESSION_ID.test(id) ? `${sessions}/${id}/baseline` : undefined
}

const readBaselineIndex = async ($: $): Promise<BaselineIndex> => {
  const dir = await baselineDir($)
  if (dir === undefined || !(await $.fs.exists(`${dir}/index.json`))) return {}
  return parseBaselineIndex(await $.fs.read(`${dir}/index.json`))
}

// Called before an Edit, Write or NotebookEdit runs; only the first change of
// a file is kept. A failure here never blocks the tool: that file then shows
// against HEAD.
// The file as it is now, as a baseline: a copy, `absent` when it does not
// exist, or why it was not copied.
const snapshotOf = async ($: $, dir: string, absolute: string): Promise<BaselineEntry> => {
  if (!(await $.fs.exists(absolute))) return { kind: 'absent' }
  const kept = baselineOf(await $.fs.read(absolute))
  if ('reason' in kept) return { kind: 'skipped', reason: kept.reason }
  const blob = `${dir}/blobs/${contentHash(kept.text)}`
  if (!(await $.fs.exists(blob))) await $.fs.write(blob, kept.text)
  return { kind: 'copy', blob }
}

const captureBaseline = async ($: $, path: string | undefined): Promise<void> => {
  try {
    const dir = await baselineDir($)
    const at = await resolveReviewRoot($)
    if (dir === undefined || at === undefined || path === undefined) return
    const given = path.startsWith('/') ? path : `${at}/${path}`
    // The root is a real path: so is the key, when the file exists.
    const absolute = (await $.fs.exists(given)) ? ((await realPathOf($, given)) ?? given) : given
    const index = await readBaselineIndex($)
    if (index[absolute] !== undefined) return
    const entry = await snapshotOf($, dir, absolute)
    await $.fs.write(`${dir}/index.json`, JSON.stringify({ ...index, [absolute]: entry }))
    reviewDirty = true
  } catch (error) {
    $.ui.toast(`Moonlight: no baseline for ${path}: ${String(error)}`)
  }
}

// `$.fs` has no delete: `rm -r`, on a session's baseline folder only.
const dropBaseline = async ($: $, sessionId?: string): Promise<void> => {
  const dir = await baselineDir($, sessionId)
  if (dir === undefined || !(await $.fs.exists(dir))) return
  await $.process.run(['rm', '-r', '--', dir])
}

// Baselines of sessions whose heartbeat is older than a week: never accepted
// nor cleared, and not coming back.
const sweepStaleBaselines = async ($: $): Promise<void> => {
  const sessions = await sessionsDir($)
  if (sessions === undefined || !(await $.fs.exists(sessions))) return
  const now = await $.clock.now()
  const current = await $.session.id()
  for (const entry of await $.fs.list(sessions)) {
    if (entry.name === current || !SESSION_ID.test(entry.name)) continue
    if (!(await $.fs.exists(`${sessions}/${entry.name}/baseline`))) continue
    const heartbeat = `${sessions}/${entry.name}/heartbeat`
    const seenAt = (await $.fs.exists(heartbeat)) ? (await $.fs.stat(heartbeat)).mtimeMs : 0
    if (now - seenAt > BASELINE_STALE_MS) await dropBaseline($, entry.name)
  }
}

// The files changed since their baselines, under the session root.
const baselineFiles = async ($: $, at: string): Promise<ChangedFile[]> => {
  const files: ChangedFile[] = []
  for (const [absolute, entry] of Object.entries(await readBaselineIndex($))) {
    if (!absolute.startsWith(`${at}/`)) continue
    const path = absolute.slice(at.length + 1)
    const isPresent = await $.fs.exists(absolute)
    const place = { path, repo: at, repoPath: path, status: baselineStatus(entry, isPresent) }
    if (entry.kind === 'skipped') {
      files.push({ ...place, added: 0, removed: 0, skipped: entry.reason })
      continue
    }
    const before = entry.kind === 'copy' ? entry.blob : '/dev/null'
    if (!isPresent && before === '/dev/null') continue
    const stat = parseNumstat(await git($, ['diff', '--no-index', '--numstat', '--', before, isPresent ? absolute : '/dev/null'], at))
    if (stat.added === 0 && stat.removed === 0) continue
    files.push({ ...place, ...stat, baseline: before })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// The repositories to review: the one the root is in, else every one found in
// its subfolders (a session opened on a folder of projects).
const findRepos = async ($: $): Promise<Repo[]> => {
  const at = await resolveReviewRoot($)
  if (at === undefined) return []
  if ((await git($, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true') {
    const top = (await git($, ['rev-parse', '--show-toplevel'])).trim()
    return [{ dir: top.startsWith('/') ? top : at, prefix: '' }]
  }
  const skip = REPO_SEARCH_SKIP.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
  const found = await $.process.run(
    ['find', at, '-maxdepth', String(REPO_SEARCH_DEPTH), '(', ...skip, ')', '-prune', '-o', '-name', '.git', '-print', '-prune'],
    { cwd: at },
  )
  return parseRepoDirs(found.stdout, at)
}

const loadChangedFiles = async ($: $): Promise<void> => {
  const at = await resolveReviewRoot($)
  const sinceBaselines = at === undefined ? [] : await baselineFiles($, at)
  const hasBaselines = Object.keys(await readBaselineIndex($)).length > 0
  await update($, reviewHasBaselinesState, () => hasBaselines)
  if (effectiveScope(await read($, reviewScopeState), hasBaselines) === 'session') {
    await update($, reviewProblemState, () => null)
    await update($, reviewFilesState, () => sinceBaselines)
    return
  }
  const repos = await findRepos($)
  await update($, reviewProblemState, () =>
    repos.length > 0
      ? null
      : `No git repository in ${reviewRoot ?? 'this project'} or its subfolders (${REPO_SEARCH_DEPTH} levels): nothing to diff against.`,
  )
  const files: ChangedFile[] = []
  for (const repo of repos) {
    const numstat = await git($, ['diff', '--numstat', 'HEAD'], repo.dir)
    const porcelain = await git($, ['status', '--porcelain', '--untracked-files=all'], repo.dir)
    const listed = parseChangedFiles(numstat, porcelain)
    // `git diff --numstat HEAD` leaves untracked files out: count their lines
    // as a diff from nothing, up to a cap.
    let counted = 0
    for (const file of listed) {
      if (file.status !== '??' || file.added !== 0 || file.removed !== 0) continue
      if (counted >= UNTRACKED_COUNT_MAX) {
        file.skipped = `not counted (over ${UNTRACKED_COUNT_MAX} untracked files)`
        continue
      }
      counted += 1
      Object.assign(file, untrackedCount(await git($, ['diff', '--no-index', '--numstat', '--', '/dev/null', file.path], repo.dir)))
    }
    files.push(...inRepo(listed, repo))
  }
  await update($, reviewFilesState, () => files)
}

const diffAgainstHead = async ($: $, inside: string, cwd: string | undefined): Promise<string> => {
  const tracked = await git($, ['diff', 'HEAD', '--', inside], cwd)
  // An untracked file has no diff against HEAD: show it whole, as added.
  return tracked !== '' ? tracked : await git($, ['diff', '--no-index', '--', '/dev/null', inside], cwd)
}

// Only a file under review: a finding names its file, and the model wrote it.
const openReviewFile = async ($: $, path: string): Promise<void> => {
  const file = (await read($, reviewFilesState)).find(f => f.path === path)
  if (file === undefined) {
    $.ui.toast(`Moonlight: ${path} is not among the files under review`)
    return
  }
  const cwd = file?.repo
  const inside = file?.repoPath ?? path
  const diff =
    file?.skipped !== undefined
      ? ''
      : file?.baseline !== undefined
        ? await git($, ['diff', '--no-index', '--', file.baseline, file.status === 'D' ? '/dev/null' : inside], cwd)
        : await diffAgainstHead($, inside, cwd)
  await update($, reviewRowsState, () => parseFileDiff(diff))
  await clearSelection($)
  await update($, reviewViewState, () => ({ kind: 'file', path }))
}

const showReviewFiles = async ($: $): Promise<void> => {
  await clearSelection($)
  await update($, reviewViewState, () => ({ kind: 'files' }))
  await loadChangedFiles($)
}

const clearSelection = async ($: $): Promise<void> => {
  await update($, reviewRowSelectionState, () => null)
  await update($, reviewSelectionState, () => null)
}

// A click picks the row; a second one extends to every row between, removed,
// added and context alike. The anchor the comment gets follows from them.
// `index`: the row's place in the file's rows, as the render drew them (a
// state read hands back copies, so rows are not found by identity here).
const clickReviewLine = async ($: $, path: string, index: number): Promise<void> => {
  const rows = await read($, reviewRowsState)
  const row = rows[index]
  if (row === undefined || anchorOf(row) === undefined) return
  const range = nextRowSelection(await read($, reviewRowSelectionState), index)
  await update($, reviewRowSelectionState, () => range)
  await update($, reviewSelectionState, () => (range === null ? null : anchorOfRows(rows, path, range)))
  await update($, reviewDraftState, () => [])
}

// The comment field's Enter: a line ending with `\` joins the draft, any
// other line ends the comment.
const submitCommentLine = async ($: $, value: string): Promise<void> => {
  const next = continueDraft(await read($, reviewDraftState), value)
  if ('draft' in next) {
    await update($, reviewDraftState, () => next.draft)
    return
  }
  await update($, reviewDraftState, () => [])
  await addReviewComment($, next.body)
}

const addReviewComment = async ($: $, body: string): Promise<void> => {
  const text = body.trim()
  const anchor = await read($, reviewSelectionState)
  if (text === '' || anchor === null) return
  const id = `c${await $.clock.now()}`
  // The loaded rows are the open file's: from /ml-review comment on another
  // file, there is no excerpt.
  const view = await read($, reviewViewState)
  const picked = await read($, reviewRowSelectionState)
  const rows = await read($, reviewRowsState)
  const excerpt =
    view.kind !== 'file' || view.path !== anchor.path
      ? ''
      : picked !== null
        ? excerptOfRows(rows, picked)
        : excerptOf(rows, anchor)
  await update($, reviewCommentsState, list => [
    ...(list ?? []),
    { ...anchor, id, body: text, ...(excerpt !== '' ? { excerpt } : {}) },
  ])
  await clearSelection($)
}

const removeReviewComment = async ($: $, id: string): Promise<void> => {
  await update($, reviewCommentsState, list => (list ?? []).filter(c => c.id !== id))
}

// Every file under review, reviewed as it is now.
const rebaseAll = async ($: $): Promise<void> => {
  const dir = await baselineDir($)
  if (dir === undefined) return
  const index = await readBaselineIndex($)
  const next: BaselineIndex = {}
  for (const [absolute, entry] of Object.entries(index)) {
    // A file that could not be copied stays listed whatever happens: forgotten.
    if (entry.kind === 'skipped') continue
    const now = await snapshotOf($, dir, absolute)
    if (now.kind !== 'skipped') next[absolute] = now
  }
  await $.fs.write(`${dir}/index.json`, JSON.stringify(next))
}

// Closes the review: every file's baseline becomes its current content, so the
// next review shows only what the agent changes from here, by any tool; stays
// on this session's changes, not HEAD's.
const acceptReview = async ($: $): Promise<string> => {
  const comments = await read($, reviewCommentsState)
  const kept = (await read($, reviewFindingsState)).filter(f => f.decision === 'keep')
  if (comments.length > 0 || kept.length > 0) {
    const pending = [
      ...(comments.length > 0 ? [counted(comments.length, 'comment')] : []),
      ...(kept.length > 0 ? [counted(kept.length, 'kept finding')] : []),
    ].join(' and ')
    const refused = `Not accepted: ${pending} pending. Send them, or remove or dismiss them first.`
    $.ui.toast(`Moonlight: ${refused}`)
    return refused
  }
  await update($, reviewFindingsState, () => [])
  await update($, reviewFindingsStatusState, () => null)
  await rebaseAll($)
  await update($, reviewScopeState, () => 'session')
  await clearSelection($)
  await update($, reviewDraftState, () => [])
  await update($, reviewViewState, () => ({ kind: 'files' }))
  await loadChangedFiles($)
  try {
    // A note, not a prompt: there is nothing left for the agent to do.
    await tellModel(
      $,
      '[moonlight] Review ACCEPTED: the operator reviewed your changes and all is good, nothing to change. ' +
        'The next review starts from here.',
    )
  } catch {
    // The review is closed whether or not the note reaches the agent.
  }
  $.ui.toast('Moonlight: all good, review accepted')
  return 'Review accepted, all good: the next review starts from here.'
}

// "Mark reviewed" for one file (the IDE's per-file accept): its baseline goes,
// so it leaves the list until the agent changes it again. Session scope only:
// against HEAD there is no baseline to drop.
const acceptReviewFile = async ($: $, path: string): Promise<{ ok: boolean; message: string }> => {
  const file = (await read($, reviewFilesState)).find(f => f.path === path)
  if (file === undefined) return { ok: false, message: `${path} is not among the files under review.` }
  // Its comments are the operator's words, not yet sent: never dropped unasked.
  const waiting = (await read($, reviewCommentsState)).filter(c => c.path === path).length
  if (waiting > 0)
    return { ok: false, message: `${path} has ${counted(waiting, 'comment')} not sent yet: send the review, or remove them first.` }
  const dir = await baselineDir($)
  const absolute = `${file.repo}/${file.repoPath}`
  const index = await readBaselineIndex($)
  if (dir === undefined || index[absolute] === undefined)
    return { ok: false, message: `${path} is reviewed against the last commit: commit it, or accept the whole review.` }
  // Reviewed as it is now: it leaves the list, and comes back with the next
  // change, whichever tool makes it (a shell script included, which no write
  // hook sees). Forgetting the file instead would lose those for good.
  // A file that cannot be copied would stay listed whatever happens: forgotten.
  const { [absolute]: _accepted, ...rest } = index
  const now = await snapshotOf($, dir, absolute)
  await $.fs.write(`${dir}/index.json`, JSON.stringify(now.kind === 'skipped' ? rest : { ...rest, [absolute]: now }))
  await loadChangedFiles($)
  return { ok: true, message: `${path} marked reviewed.` }
}

// Sends every comment and every kept finding to the agent as one message,
// then starts a new review.
const submitReview = async ($: $, summary: string): Promise<string> => {
  const comments = await read($, reviewCommentsState)
  const findings = await read($, reviewFindingsState)
  const kept = findings.filter(f => f.decision === 'keep')
  if (comments.length === 0 && kept.length === 0) return 'Nothing to submit: add a comment, or keep a finding.'
  // Taken off the panel at once, so a second press sends nothing twice; the
  // prompt enters once the session is idle, and a failure puts them back.
  await update($, reviewCommentsState, () => [])
  await update($, reviewFindingsState, () => [])
  await update($, reviewNoteForState, () => null)
  await clearSelection($)
  const sent = comments.map(c => c.id)
  const what = [
    ...(kept.length > 0 ? [counted(kept.length, 'finding')] : []),
    ...(comments.length > 0 ? [counted(comments.length, 'comment')] : []),
  ].join(', ')
  void askModel($, formatReview(comments, summary, kept.map(formatFinding))).then(
    () => $.ui.toast(`Moonlight: review sent (${what})`),
    async error => {
      await update($, reviewCommentsState, list => [...comments, ...(list ?? []).filter(c => !sent.includes(c.id))])
      await update($, reviewFindingsState, list => ((list ?? []).length > 0 ? (list ?? []) : findings))
      $.ui.toast(`Moonlight: review not sent, kept on the panel: ${String(error)}`)
    },
  )
  return `Review submitted: ${what}. The agent starts on it once it is idle.`
}

// ---- Findings: an existing review skill, attached ----

// Review skills whose prompt gets the scope and the findings contract.
const ATTACHED_KEY = 'attachedReviewSkills'

// An unreadable store must not take the panel down: the defaults stand in.
// The `reviewSkills` plugin option (a team's choice, e.g. in managed
// settings), read at load; the built-in defaults when unset.
let configuredSkills: string[] = [...DEFAULT_ATTACHED]

// The operator's own list (attach/detach) wins over the option.
const attachedSkills = async ($: $): Promise<string[]> => {
  try {
    return ((await $.store.get(ATTACHED_KEY)) as string[] | undefined) ?? [...configuredSkills]
  } catch {
    return [...configuredSkills]
  }
}

// The attached skills this session can run, and the ones it cannot: an
// attached skill that is not installed is not offered.
const runnableSkills = async ($: $): Promise<{ runnable: string[]; missing: string[] }> => {
  const attached = await attachedSkills($)
  const commands = await $.command
    .list()
    .then(list => list.map(c => c.name))
    .catch(() => undefined)
  const runnable = installedSkills(attached, commands !== undefined && commands.length > 0 ? commands : undefined)
  return { runnable, missing: attached.filter(s => !runnable.includes(s)) }
}

const setAttached = async ($: $, change: (list: string[]) => string[]): Promise<string[]> => {
  const next = change(await attachedSkills($))
  await $.store.set(ATTACHED_KEY, next)
  return next
}

// What the attached skill is to review: the panel's files in its scope.
const contractFor = async ($: $): Promise<string> => {
  await loadChangedFiles($)
  const at = (await resolveReviewRoot($)) ?? '.'
  const scope = effectiveScope(await read($, reviewScopeState), await read($, reviewHasBaselinesState))
  const files = (await read($, reviewFilesState)).map(f => ({
    path: f.path,
    status: f.status,
    ...(f.baseline !== undefined ? { baseline: f.baseline } : {}),
  }))
  return findingsContract(at, scope, files)
}

// Asks the agent to run a review skill; the skill's own prompt then carries
// the contract, through the `skill.prompt` hook.
const runReviewSkill = async ($: $, skill: string): Promise<string> => {
  await update($, reviewPickingState, () => false)
  const running = await read($, reviewRunState)
  if (running !== null) {
    const refused = `${running.skill} is already running: wait for its findings, or cancel it.`
    $.ui.toast(`Moonlight: ${refused}`)
    return refused
  }
  // The contract rides in the run's own prompt, so the run does not depend on
  // the skill's prompt hook firing; marked as given, the hook adds no second.
  await update($, reviewRunState, () => ({ skill, isPrompted: true, isFromPanel: true }))
  await update($, reviewFindingsStatusState, () => `Running ${skill}…`)
  void (async () => askModel($, `${runPrompt(skill)}\n${await contractFor($)}`))().catch(async error => {
    await update($, reviewRunState, () => null)
    await update($, reviewFindingsStatusState, () => `Could not start ${skill}: ${String(error)}`)
  })
  return `Asked the agent to run ${skill}; its findings land in the Review panel.`
}

// "Run AI review": the one attached skill at once, else the picker.
const startAiReview = async ($: $): Promise<void> => {
  const { runnable } = await runnableSkills($)
  if (runnable.length === 1) await runReviewSkill($, runnable[0]!)
  else await update($, reviewPickingState, () => runnable.length > 1)
}

// Frees the panel from a review that will not answer (interrupted, gone off
// track); a block it still sends is read all the same.
const cancelAiReview = async ($: $): Promise<void> => {
  const running = await read($, reviewRunState)
  await update($, reviewRunState, () => null)
  await update($, reviewPickingState, () => false)
  if (running !== null) await update($, reviewFindingsStatusState, () => `${running.skill}: cancelled.`)
}

// The skill prompt to give the contract to: the running review's skill, once
// (not a nested attached skill it calls); with no review running, an attached
// skill started by hand becomes the run.
const claimsContract = async ($: $, skill: string): Promise<boolean> => {
  const running = await read($, reviewRunState)
  if (running === null) {
    if (!isAttached(skill, await attachedSkills($))) return false
    await update($, reviewRunState, () => ({ skill, isPrompted: true, ...(lastTurnId !== undefined ? { turnId: lastTurnId } : {}) }))
    await update($, reviewFindingsStatusState, () => `Running ${skill}…`)
    return true
  }
  if (running.isPrompted || !isAttached(skill, [running.skill])) return false
  const turnId = running.turnId ?? lastTurnId
  await update($, reviewRunState, () => ({ ...running, isPrompted: true, ...(turnId !== undefined ? { turnId } : {}) }))
  return true
}

// An answer that carries a findings block: loads it for triage. Any answer
// may, so a review run by hand counts too.
// `turn`: the turn that ended, as `turn.complete` has it.
const ingestAnswer = async (
  $: $,
  answer: string,
  turn: { turnId: string; isMainLoop: boolean; isAborted: boolean },
): Promise<void> => {
  const running = await read($, reviewRunState)
  if (!answer.includes('```moonlight-findings')) {
    // The running review's turn ended with no block: say so, rather than
    // leaving "Running…" up. Its turn is known by id. A skill started by hand
    // with no id known ends on the first main-loop end after it started; a
    // panel run waits for its own turn (the session may be busy with another).
    const isItsEnd =
      running !== null &&
      (running.turnId !== undefined
        ? running.turnId === turn.turnId
        : running.isFromPanel !== true && turn.isMainLoop && running.isPrompted)
    if (isItsEnd) {
      await update($, reviewRunState, () => null)
      await update($, reviewFindingsStatusState, () =>
        turn.isAborted
          ? `${running.skill} was interrupted: nothing to triage.`
          : `${running.skill} ended without a moonlight-findings block. If it runs in the background, ` +
            'its findings land here when the agent reports them.',
      )
    }
    return
  }
  // A block outside a review run must not erase triage in progress: notes
  // written, findings dismissed. The running review's own answer replaces it.
  const triage = await read($, reviewFindingsState)
  if (running === null && triage.some(f => f.note !== undefined || f.decision === 'dismiss')) {
    $.ui.toast('Moonlight: a findings block arrived outside a review run; your triage is kept. Send it or clear it first.')
    return
  }
  await update($, reviewRunState, () => null)
  const report = parseFindings(answer)
  if ('error' in report) {
    await update($, reviewFindingsStatusState, () => `AI review unreadable: ${report.error}`)
    $.ui.toast('Moonlight: the AI review could not be read: see the Review panel')
    return
  }
  const stamp = await $.clock.now()
  await update($, reviewFindingsState, () =>
    report.findings.map((f, i) => ({ ...f, id: `${f.key}-${stamp}-${i}`, decision: 'keep' as const })),
  )
  const failed = report.lanesFailed.length > 0 ? ` Failed: ${report.lanesFailed.join(', ')}.` : ''
  await update($, reviewFindingsStatusState, () => `${report.notes}${failed}`.trim() || null)
  $.ui.toast(`Moonlight: AI review done, ${counted(report.findings.length, 'finding')}: /ml-review`)
}

const decideFinding = async ($: $, id: string, decision: 'keep' | 'dismiss'): Promise<void> => {
  await update($, reviewFindingsState, list => (list ?? []).map(f => (f.id === id ? { ...f, decision } : f)))
  if (decision === 'dismiss') await update($, reviewNoteForState, current => (current === id ? null : (current ?? null)))
}

// The operator's decision about a finding; an empty note clears it. A note
// keeps the finding: it is what the agent is asked to act on.
const saveFindingNote = async ($: $, id: string, text: string): Promise<void> => {
  const note = text.trim()
  await update($, reviewFindingsState, list =>
    (list ?? []).map(f => {
      if (f.id !== id) return f
      const { note: _old, ...rest } = f
      return note === '' ? rest : { ...rest, note, decision: 'keep' as const }
    }),
  )
  await update($, reviewNoteForState, () => null)
}

// The dock takes a width request (the person's own resize wins): the terminal's
// full width to expand, none to go back to the dock's share.
const setReviewExpanded = async ($: $, isExpanded: boolean, terminalColumns: number): Promise<void> => {
  await update($, reviewExpandedState, () => isExpanded)
  await $.ui.open(
    isExpanded
      ? { id: REVIEW_PANE, title: 'Review', focus: true, columns: terminalColumns }
      : { id: REVIEW_PANE, title: 'Review', focus: true },
  )
}

const toggleReviewPane = async ($: $): Promise<string> => {
  const isOpen = (await $.ui.panes()).some(p => p.id === REVIEW_PANE)
  if (isOpen) {
    await $.ui.close({ id: REVIEW_PANE })
    return 'Review panel closed.'
  }
  await showReviewFiles($)
  const opened = await $.ui.open({ id: REVIEW_PANE, title: 'Review', focus: true })
  return opened.isPlaced ? 'Review panel open.' : `Review panel open but not drawn: ${opened.reason}`
}

// ---- Plan panel ----

// The agent presents its plan with present_plan (Claude Code's own plan mode
// would leave auto mode); the operator comments its lines and answers Approve,
// Refine or Reject. The verdict goes in as a prompt, so it wakes the agent.
const PLAN_PANE = 'moonlight-plan'
const PLAN_TOOL = 'present_plan'
const planDocState = atom({ plugin: 'moonlightcode', key: 'planDoc' } as const, null as MoonlightcodePlan | null)
const planCommentsState = atom({ plugin: 'moonlightcode', key: 'planComments' } as const, [] as PlanComment[])
// The plan's rows picked by clicks, 0-based; a comment anchors on their lines.
const planRowSelectionState = atom({ plugin: 'moonlightcode', key: 'planRowSelection' } as const, null as RowRange | null)
const planDraftState = atom({ plugin: 'moonlightcode', key: 'planDraft' } as const, [] as string[])
const planNoteState = atom({ plugin: 'moonlightcode', key: 'planNote' } as const, '')
const planRejectingState = atom({ plugin: 'moonlightcode', key: 'planRejecting' } as const, false)

const VERDICT_WORD = { approve: 'approved', refine: 'sent back for changes', reject: 'rejected' } as const

const openPlanPane = async ($: $): Promise<string> => {
  try {
    const opened = await $.ui.open({ id: PLAN_PANE, title: 'Plan', focus: true })
    return opened.isPlaced ? 'Plan panel open.' : `Plan panel open but not drawn: ${opened.reason}`
  } catch (error) {
    return `Plan panel not opened: ${String(error)}`
  }
}

const togglePlanPane = async ($: $): Promise<string> => {
  if ((await $.ui.panes()).some(p => p.id === PLAN_PANE)) {
    await $.ui.close({ id: PLAN_PANE })
    return 'Plan panel closed.'
  }
  return openPlanPane($)
}

// Stores the plan as the session's next version, in state and on disk, and
// starts its review afresh: the last version's comments do not carry over.
const presentPlan = async ($: $, markdown: string, title: string): Promise<number> => {
  const version = ((await read($, planDocState))?.version ?? 0) + 1
  await update($, planDocState, () => ({ version, title, markdown }))
  void publishState($).catch(() => undefined)
  await update($, planCommentsState, () => [])
  await update($, planRowSelectionState, () => null)
  await update($, planDraftState, () => [])
  await update($, planNoteState, () => '')
  await update($, planRejectingState, () => false)
  try {
    const sessions = await sessionsDir($)
    const id = await $.session.id()
    if (sessions !== undefined && SESSION_ID.test(id)) await $.fs.write(`${sessions}/${id}/plan/v${version}.md`, markdown)
  } catch (error) {
    // The panel holds the plan whether or not the copy on disk is written.
    $.ui.toast(`Moonlight: plan v${version} not saved to disk: ${String(error)}`)
  }
  return version
}

const clickPlanLine = async ($: $, index: number): Promise<void> => {
  await update($, planRowSelectionState, current => nextRowSelection(current ?? null, index))
  await update($, planDraftState, () => [])
}

// `start`-`end`: 1-based plan lines. The excerpt is quoted to the agent.
const addPlanComment = async ($: $, start: number, end: number, body: string): Promise<string | undefined> => {
  const doc = await read($, planDocState)
  const text = body.trim()
  if (doc === null || text === '') return undefined
  const count = parsePlan(doc.markdown).length
  if (start < 1 || end < start || end > count) return `No such lines: the plan has ${count}.`
  const id = `p${await $.clock.now()}`
  const excerpt = planExcerpt(doc.markdown, start, end)
  await update($, planCommentsState, list => [...(list ?? []), { id, start, end, body: text, ...(excerpt !== '' ? { excerpt } : {}) }])
  await update($, planRowSelectionState, () => null)
  return undefined
}

const submitPlanCommentLine = async ($: $, value: string): Promise<void> => {
  const next = continueDraft(await read($, planDraftState), value)
  if ('draft' in next) {
    await update($, planDraftState, () => next.draft)
    return
  }
  await update($, planDraftState, () => [])
  const picked = await read($, planRowSelectionState)
  const refused =
    picked === null ? 'click + on a line first' : await addPlanComment($, picked.from + 1, picked.to + 1, next.body)
  if (refused !== undefined) $.ui.toast(`Moonlight: comment not added: ${refused}`)
}

const removePlanComment = async ($: $, id: string): Promise<void> => {
  await update($, planCommentsState, list => (list ?? []).filter(c => c.id !== id))
}

// Sends the verdict as a prompt; an approval moves a read-only phase to Auto
// first. The version is marked decided before anything else is awaited, so a
// second press sends nothing twice. A refused send undoes the mark and the
// phase change, and puts the comments and the note back on that same version.
// `said`: the verdict's own text (a reject reason, a /ml-plan note), sent with
// the note saved on the panel.
const sendPlanVerdict = async ($: $, verdict: PlanVerdict, said?: string): Promise<string> => {
  const doc = await read($, planDocState)
  if (doc === null) return 'No plan to answer: the agent has not presented one.'
  if (doc.decided !== undefined) return `Plan v${doc.version} is already ${VERDICT_WORD[doc.decided]}.`
  const refuse = (why: string): string => {
    $.ui.toast(`Moonlight: ${why}`)
    return why
  }
  if (verdict === 'reject' && (said ?? '').trim() === '') return refuse('A rejection needs a reason.')
  const comments = await read($, planCommentsState)
  const saved = await read($, planNoteState)
  const note = [saved, said ?? ''].map(t => t.trim()).filter(t => t !== '').join('\n\n')
  if (!canSend(verdict, comments, note)) return refuse('Nothing to refine: comment a line or write a note first.')
  let isMine = false
  await update($, planDocState, current => {
    if (current === null || current.version !== doc.version || current.decided !== undefined) return current ?? null
    isMine = true
    return { ...current, decided: verdict }
  })
  if (!isMine) return `Plan v${doc.version} is already answered.`
  const before = await readPhase($)
  // Implementing needs writes: an approval leaves any read-only phase for Auto.
  const phase = verdict === 'approve' && !allowsWrites(before) ? await setPhase($, 'auto') : before
  const text = formatVerdict(verdict, doc.version, comments, note, phase)
  await update($, planCommentsState, () => [])
  await update($, planNoteState, () => '')
  await update($, planRejectingState, () => false)
  await update($, planRowSelectionState, () => null)
  void askModel($, text).then(
    () => $.ui.toast(`Moonlight: plan v${doc.version} ${VERDICT_WORD[verdict]}`),
    async error => {
      // The agent never heard of the approval: the project goes back to read-only.
      if (phase !== before) await setPhase($, before)
      const isSameVersion = (await read($, planDocState))?.version === doc.version
      await update($, planDocState, current => {
        if (current?.version !== doc.version) return current ?? null
        const { decided: _sent, ...rest } = current
        return rest
      })
      // A newer version has its own review: the old comments do not fit its lines.
      if (isSameVersion) {
        await update($, planCommentsState, list => [...comments, ...(list ?? []).filter(c => !comments.some(k => k.id === c.id))])
        await update($, planNoteState, current => (current !== '' ? current : saved))
      }
      $.ui.toast(`Moonlight: plan verdict not sent${isSameVersion ? ', kept on the panel' : ''}: ${String(error)}`)
    },
  )
  return `Plan v${doc.version} ${VERDICT_WORD[verdict]}${verdict === 'approve' ? `; the phase is ${phase}` : ''}. The agent starts on it once it is idle.`
}

// The plan as text, numbered for /ml-plan comment: the way in where no panel
// draws (the VS Code extension).
const planReport = async ($: $): Promise<string[]> => {
  const doc = await read($, planDocState)
  if (doc === null) return ["No plan yet. In the Plan phase, the agent's plan shows up here for you to approve."]
  const comments = await read($, planCommentsState)
  const note = await read($, planNoteState)
  const lines = parsePlan(doc.markdown)
  const width = String(lines.length).length
  return [
    `Plan v${doc.version}${doc.title !== '' ? `  ${doc.title}` : ''}, ${doc.decided !== undefined ? VERDICT_WORD[doc.decided] : 'waiting for you'}, ${counted(comments.length, 'comment')}`,
    ...lines.map(l => `  ${String(l.line).padStart(width)}  ${l.text}`),
    ...(comments.length > 0 ? ['Comments:', ...comments.map(c => `  [${c.id}] ${planSpan(c)}: ${c.body.replace(/\n/g, ' · ')}`)] : []),
    ...(note !== '' ? [`Note: ${note}`] : []),
  ]
}

// One registration that fails (a name already taken, say) must not take the
// others down: each is tried on its own and a failure is shown, not thrown.
const tryStart = async ($: $, what: string, start: () => Promise<unknown>): Promise<void> => {
  try {
    await start()
  } catch (error) {
    $.ui.toast(`Moonlight: ${what} unavailable: ${String(error)}`)
  }
}

// What only a governing mod offers: the phase, the plan and their tools.
const startGoverned = async ($: $): Promise<void> => {
  await tryStart($, '/phase', () =>
    $.command.register({
      name: 'phase',
      description: 'Set the Moonlight phase (operator only)',
      argumentHint: `${PHASES.join('|')}|next|approve|deny`,
    }),
  )
  await tryStart($, '/ml-plan', () =>
    $.command.register({
      name: 'ml-plan',
      description: "Moonlight: open or close the Plan panel; answer the agent's plan (operator only)",
      argumentHint: '[approve [note] | refine <note> | reject <reason> | comment <line[-end]> <text> | uncomment <id>]',
    }),
  )
  await tryStart($, 'present_plan', () => $.tool.register({
    name: PLAN_TOOL,
    description:
      'Present your plan to the operator for review in the Moonlight Plan panel. In the Plan phase, this is how a ' +
      'plan is proposed: write it as Markdown, call this tool, then stop and wait (do not use EnterPlanMode or ' +
      'ExitPlanMode). Returns at once; the operator comments lines and answers, and the verdict arrives later as a ' +
      '[moonlight] prompt: APPROVED (the phase moves to auto: implement it), REFINEMENT (call present_plan again ' +
      'with the whole revised plan) or REJECTED (stop).',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The whole plan, as Markdown' },
        title: { type: 'string', description: 'A short title shown in the panel header' },
      },
      required: ['plan'],
    },
  }))
  await tryStart($, 'request_phase', () => $.tool.register({
    name: TOOL,
    description:
      'Ask the operator to change the Moonlight workflow phase: plan (project read-only), auto, test, review ' +
      '(project writable), commit (everything frozen until the operator commits), or next (the following one; ' +
      'commit is followed by plan). ' +
      'Returns at once; the operator approves or denies in a dialog, and the decision arrives as a ' +
      '[moonlight] note. Never assume the phase changed before that note.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['plan', 'auto', 'test', 'review', 'commit', 'next'] },
        reason: { type: 'string', description: 'Why the change is needed, shown to the operator' },
      },
      required: ['phase'],
    },
  }))
  const surfaces = await $.session.surfaces()
  if (surfaces.some(s => SURFACES_WITHOUT_BAND.includes(s))) await openPhasePane($, false)
}

// The Review panel works under either governor: it reads git and the
// baselines the mod keeps.
const startReview = async ($: $): Promise<void> => {
  // Not `/review`: that is the built-in /code-review's alias.
  await tryStart($, '/ml-review', () =>
    $.command.register({
      name: 'ml-review',
      description: 'Moonlight: open or close the Review panel; comment a diff line (operator only)',
      argumentHint:
        '[comment <path:line[-end]> <text> | uncomment <id> | submit [summary] | accept | scope session|head | ' +
        'run [skill] | cancel | attach <skill> | detach <skill> | skills [reset]]',
    }),
  )
}

// ---- Hooks ----

export const register: Register = (on, options) => {
  configuredSkills = parseSkillList((options as Record<string, unknown> | undefined)?.reviewSkills) ?? [...DEFAULT_ATTACHED]
  isColorBlind = isColorBlindOption((options as Record<string, unknown> | undefined)?.colorBlind)

  on('classic.SessionStart', async ($, e, next) => {
    await noteTitle($, e.session_title, e.transcript_path).catch(() => undefined)
    return next(e)
  })
  // The operator's prompts only: an IDE's Claude Code panel submits as `sdk`.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const isOperator = e.source === undefined || e.source === 'user' || e.source === 'sdk'
    await noteTitle($, e.session_title, e.transcript_path, isOperator ? e.prompt : undefined).catch(() => undefined)
    return next(e)
  })
  // Claude Code names the session after a turn or two; a turn's end picks it up.
  on('classic.Stop', async ($, e, next) => {
    await noteTitle($, undefined, e.transcript_path).catch(() => undefined)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A daemon that governs keeps the session; the mod then stands by. Any
    // doubt (no answer, no hooks, a probe that fails) leaves the gate to the mod.
    await setGovernor($, nextGovernor(undefined, await daemonGoverns($).catch(() => false)))
    if (governor === 'daemon') {
      await tryStart($, 'the review', () => initPaths($))
      await tryStart($, 'the sandbox release', () => releaseSandbox($))
    } else {
      // The gate first: whatever fails after it, the project stays governed.
      // A gate that cannot start still registers the commands and the heartbeat:
      // its hooks then refuse what they guard (each has a fail-closed handler).
      await tryStart($, 'the gate', () => initGate($))
    }
    await tryStart($, 'the heartbeat', () => beat($))
    $.clock.every(POLL_MS, () => void tick($).catch(() => undefined))
    if (governor !== 'daemon') await startGoverned($)
    await startReview($)
    await tryStart($, 'baseline sweep', () => sweepStaleBaselines($))
    return started
  })

  on('command.run', { command: 'phase' }, async ($, e) => {
    if (e.origin.kind !== 'composer')
      return { text: `Refused: /phase only runs when the operator types it (origin: ${e.origin.kind}).` }
    const word = e.args.trim().toLowerCase()
    // Where no surface draws the band or the pane (the VS Code extension today),
    // the operator answers a request_phase here.
    if (word === 'approve' || word === 'deny') {
      if (pending === undefined) return { text: 'No pending phase request.' }
      const to = pending.to
      await decide($, word === 'approve')
      return { text: word === 'approve' ? `Approved: phase is now ${await readPhase($)}.` : `Denied the switch to ${to}.` }
    }
    const current = await readPhase($)
    const to = word === 'next' ? nextPhase(current) : phaseFromToken(word)
    if (to === undefined) {
      const placement = await openPhasePane($, true)
      const surfaces = (await $.session.surfaces()).join(', ') || 'none'
      return {
        text:
          `Phase is ${current} (${phaseRule(current)}); next: ${nextPhase(current)}. ` +
          `Usage: /phase ${PHASES.join('|')}|next. [${placement}; surfaces: ${surfaces}]`,
      }
    }
    const now = await operatorSetPhase($, to)
    return { text: `Moonlight phase set to ${now} (${phaseRule(now)}).` }
  })

  // The same actions as the Review panel, as text: the way in where no surface
  // draws the panel (the VS Code extension today), and a feature on its own.
  on('command.run', { command: 'ml-review' }, async ($, e) => {
    if (e.origin.kind !== 'composer')
      return { text: `Refused: /ml-review only runs when the operator types it (origin: ${e.origin.kind}).` }
    const [verb = '', target = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'comment') {
      const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(target)
      if (match === null || rest.length === 0) return { text: 'Usage: /ml-review comment <path:line[-end]> <text>' }
      const start = Number(match[2])
      // The typed lines, not rows still picked in the panel, give the excerpt.
      await update($, reviewRowSelectionState, () => null)
      await update($, reviewSelectionState, () => ({
        path: match[1]!, side: 'after', start, end: match[3] === undefined ? start : Number(match[3]),
      }))
      // `\n` in the text starts a new line of the comment.
      await addReviewComment($, rest.join(' ').replace(/\\n/g, '\n'))
      return { text: `Comment added on ${target}.` }
    }
    if (verb === 'uncomment') {
      await removeReviewComment($, target)
      return { text: `Comment ${target} removed.` }
    }
    if (verb === 'submit') return { text: await submitReview($, [target, ...rest].join(' ')) }
    if (verb === 'accept') return { text: await acceptReview($) }
    if (verb === 'attach' || verb === 'detach') {
      if (target === '') return { text: `Usage: /ml-review ${verb} <skill>` }
      const list = await setAttached($, current =>
        verb === 'attach' ? [...current.filter(s => s !== target), target] : current.filter(s => s !== target),
      )
      return { text: `Attached review skills: ${list.join(', ') || 'none'}.` }
    }
    if (verb === 'skills') {
      if (target === 'reset') {
        await $.store.set(ATTACHED_KEY, undefined)
        return { text: `Back to the configured review skills: ${configuredSkills.join(', ') || 'none'}.` }
      }
      const { runnable, missing } = await runnableSkills($)
      return {
        text:
          `Review skills: ${runnable.join(', ') || 'none installed'}.` +
          (missing.length > 0 ? ` Attached but not installed: ${missing.join(', ')}.` : ''),
      }
    }
    if (verb === 'run') {
      const { runnable } = await runnableSkills($)
      if (target === '' && runnable.length !== 1)
        return {
          text:
            runnable.length === 0
              ? 'No review skill installed among the attached ones: /ml-review skills'
              : `Which review? /ml-review run <skill>, one of: ${runnable.join(', ')}`,
        }
      const skill = target !== '' ? target : runnable[0]!
      // Run, not attach: the run's own prompt carries the contract, and the
      // operator's list (which overrides the team's) stays as it is.
      const commands = await $.command.list().then(list => list.map(c => c.name)).catch(() => undefined)
      if (commands !== undefined && commands.length > 0 && installedSkills([skill], commands).length === 0)
        return { text: `${skill} is not installed in this session.` }
      return { text: await runReviewSkill($, skill) }
    }
    if (verb === 'cancel') {
      await cancelAiReview($)
      return { text: 'No AI review running now.' }
    }
    if (verb === 'scope') {
      if (target !== 'session' && target !== 'head') return { text: 'Usage: /ml-review scope session|head' }
      await update($, reviewScopeState, () => target)
      await loadChangedFiles($)
      return { text: `Review scope: ${target === 'session' ? "changes made in this session" : 'changes since the last commit'}.` }
    }
    const placement = await toggleReviewPane($)
    const files = await read($, reviewFilesState)
    const comments = await read($, reviewCommentsState)
    const lines = files.map(f => {
      const count = comments.filter(c => c.path === f.path).length
      return `  ${f.status.padEnd(2)} ${f.path}  +${f.added} -${f.removed}${count > 0 ? `  (${count} comment${count > 1 ? 's' : ''})` : ''}`
    })
    const listed = comments.map(c => `  [${c.id}] ${anchorLabel(c)}: ${c.body}`)
    return {
      text: [
        `${placement} ${counted(files.length, 'changed file')}, ${counted(comments.length, 'comment')}.`,
        ...lines,
        ...(listed.length > 0 ? ['Comments:', ...listed] : []),
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: REVIEW_PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Code } = $.ui.resolve(e)
    const view = await read($, reviewViewState)
    const comments = await read($, reviewCommentsState)
    const width = Math.max(20, e.props.bodyColumns)
    const findings = await read($, reviewFindingsState)
    const noteFor = await read($, reviewNoteForState)
    const kept = findings.filter(f => f.decision === 'keep')

    // One finding, as the list and the diff draw it: its claim, then Keep or
    // Dismiss and a note, the operator's decision about it.
    const finding = (f: TriagedFinding, withPlace: boolean) => {
      const isDismissed = f.decision === 'dismiss'
      return (
        <Box flexDirection="column" paddingLeft={withPlace ? 0 : 2}>
          {/* Short items on the first row (a button does not shrink); the summary wraps on its own line. */}
          <Box flexDirection="row">
            {/* Severity as a mark and a word: red and yellow belong to the phases. */}
            <Text bold={f.severity === 'high'} dimColor={isDismissed || f.severity === 'low'}>{`🤖 ${severityLabel(f.severity)}  `}</Text>
            {withPlace && (
              <Button key={`goto:${f.id}`} plain dimColor={isDismissed} label={findingPlace(f.file, f.line)} onPress={() => void openReviewFile($, f.file)} />
            )}
          </Box>
          <Box paddingLeft={3}>
            <Text dimColor={isDismissed} wrap="wrap">{f.summary}</Text>
          </Box>
          {/* The whole detail and fix, wrapped: the operator triages on them. */}
          {!isDismissed && f.detail !== '' && (
            <Box paddingLeft={3} flexDirection="column">
              {f.detail.split('\n').map(line => (
                <Text dimColor wrap="wrap">{line === '' ? ' ' : line}</Text>
              ))}
            </Box>
          )}
          {!isDismissed && f.fix !== undefined && (
            <Box paddingLeft={3}>
              <Text color="green" dimColor wrap="wrap">{`Fix: ${f.fix}`}</Text>
            </Box>
          )}
          {f.note !== undefined && (
            <Box paddingLeft={3}>
              <Text bold wrap="wrap">{`You: ${f.note}`}</Text>
            </Box>
          )}
          <Box flexDirection="row" paddingLeft={3}>
            <Button
              key={`${isDismissed ? 'keep' : 'dismiss'}:${f.id}`}
              plain
              label={isDismissed ? '↺ Keep' : '✕ Dismiss'}
              onPress={() => void decideFinding($, f.id, isDismissed ? 'keep' : 'dismiss')}
            />
            <Text> </Text>
            <Button
              key={`note:${f.id}`}
              plain
              label={f.note === undefined ? '✎ Note' : '✎ Edit note'}
              onPress={() => void update($, reviewNoteForState, current => (current === f.id ? null : f.id))}
            />
            {isDismissed && <Text dimColor>  dismissed</Text>}
          </Box>
          {noteFor === f.id && (
            <Input
              key={`note-input:${f.id}`}
              value={f.note ?? ''}
              label="   Your decision"
              placeholder="What the agent should do about it. Enter saves"
              autoFocus
              onSubmit={value => void saveFindingNote($, f.id, value)}
            />
          )}
        </Box>
      )
    }

    if (view.kind === 'files') {
      const files = await read($, reviewFilesState)
      const problem = await read($, reviewProblemState)
      const hasSeveralRepos = new Set(files.map(f => f.repo)).size > 1
      const hasBaselines = await read($, reviewHasBaselinesState)
      const scope = effectiveScope(await read($, reviewScopeState), hasBaselines)
      const isSession = scope === 'session'
      // Something to close: changes shown, or copies kept for a review.
      const canAccept = comments.length === 0 && kept.length === 0 && (files.length > 0 || hasBaselines)
      const toSend = comments.length + kept.length
      // Only the installed ones are offered.
      const { runnable: skills, missing } = await runnableSkills($)
      const status = await read($, reviewFindingsStatusState)
      const run = await read($, reviewRunState)
      const isPicking = await read($, reviewPickingState)
      // Kept first, worst first; the dismissed ones after, to bring back.
      const listed = [...sortFindings(kept), ...sortFindings(findings.filter(f => f.decision === 'dismiss'))]
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Text bold color="cyan">Review</Text>
            <Text dimColor>{isSession ? '  changes made in this session' : '  changes since the last commit'}</Text>
          </Box>
          <Text dimColor>
            {`${counted(files.length, 'file')}${hasSeveralRepos ? ` in ${counted(new Set(files.map(f => f.repo)).size, 'repo')}` : ''}, ${counted(comments.length, 'comment')}`}
          </Text>
          {problem !== null && <Text color="yellow">{problem}</Text>}
          {problem === null && files.length === 0 && (
            <Text dimColor>{isSession ? 'The agent has changed nothing yet.' : 'Nothing changed since the last commit.'}</Text>
          )}
          {files.map((file, index) => {
            const count = comments.filter(c => c.path === file.path).length
            // Several repos: a heading where each one's files start.
            const isFirstOfRepo = hasSeveralRepos && (index === 0 || files[index - 1]!.repo !== file.repo)
            const repoLabel = file.path.slice(0, file.path.length - file.repoPath.length).replace(/\/$/, '') || '.'
            return (
              <Box flexDirection="column">
                {isFirstOfRepo && <Text bold color="blue">{`▸ ${repoLabel}`}</Text>}
                <Box flexDirection="row" paddingLeft={hasSeveralRepos ? 2 : 0}>
                  <Button
                    key={`file:${file.path}`}
                    plain
                    label={`${file.status.padEnd(2)} ${hasSeveralRepos ? file.repoPath : file.path}`}
                    onPress={() => void openReviewFile($, file.path)}
                  />
                  {file.skipped !== undefined ? (
                    <Text dimColor>{`  no diff: ${file.skipped}`}</Text>
                  ) : (
                    <Box flexDirection="row">
                      <Text color={countColors(isColorBlind).added}>{`  +${file.added}`}</Text>
                      <Text color={countColors(isColorBlind).removed}>{` -${file.removed}`}</Text>
                    </Box>
                  )}
                  {count > 0 && <Text>{`  💬 ${count}`}</Text>}
                  {(() => {
                    const found = kept.filter(f => f.file === file.path).length
                    return found > 0 ? <Text>{`  🤖 ${found}`}</Text> : null
                  })()}
                </Box>
              </Box>
            )
          })}
          <Text> </Text>
          <Box flexDirection="row">
            <Text bold color="blue">AI review</Text>
            <Text dimColor>
              {findings.length > 0 ? `  ${kept.length} kept, ${findings.length - kept.length} dismissed` : '  run a review skill, then keep or dismiss what it finds'}
            </Text>
          </Box>
          {status !== null && run === null && <Text dimColor wrap="truncate-end">{status}</Text>}
          {skills.length === 0 && (
            <Text dimColor>
              {missing.length > 0
                ? `No attached review skill is installed (${missing.join(', ')}): install one, or /ml-review attach <skill>`
                : 'No review skill attached: /ml-review attach <skill>'}
            </Text>
          )}
          {skills.length > 0 && run !== null && (
            <Box flexDirection="row">
              <Text>{`${run.skill} is reviewing…  `}</Text>
              <Button key="run-cancel" plain label="Cancel" onPress={() => void cancelAiReview($)} />
            </Box>
          )}
          {skills.length > 0 && run === null && !isPicking && (
            <Button
              key="run"
              label={skills.length === 1 ? `▸ Run AI review (${skills[0]})` : '▸ Run AI review…'}
              hotkey="i"
              onPress={() => void startAiReview($)}
            />
          )}
          {skills.length > 0 && run === null && isPicking && (
            <Box flexDirection="column">
              <Text dimColor>Which review?</Text>
              <Box flexDirection="row" flexWrap="wrap">
                {skills.map((skill, index) => (
                  <Box flexDirection="row">
                    <Button key={`run:${skill}`} label={skill} autoFocus={index === 0 ? true : undefined} onPress={() => void runReviewSkill($, skill)} />
                    <Text> </Text>
                  </Box>
                ))}
                <Button key="run-pick-cancel" plain label="Cancel" onPress={() => void update($, reviewPickingState, () => false)} />
              </Box>
            </Box>
          )}
          {listed.map(f => finding(f, true))}
          <Text> </Text>
          {toSend > 0 && (
            <Input key="summary" label="Message (optional)" placeholder="Enter sends the review" onSubmit={value => void submitReview($, value)} />
          )}
          <Box flexDirection="row">
            {toSend > 0 && (
              <Button key="submit" label={`Send review (${toSend})`} variant="primary" hotkey="s" onPress={() => void submitReview($, '')} />
            )}
            {canAccept && <Button key="accept" label="✓ All good" variant="primary" hotkey="a" onPress={() => void acceptReview($)} />}
            {(toSend > 0 || canAccept) && <Text> </Text>}
            <Button
              key="scope"
              label={isSession ? 'Since last commit' : 'This session only'}
              hotkey="v"
              onPress={() => void update($, reviewScopeState, () => (isSession ? 'head' : 'session')).then(() => loadChangedFiles($))}
            />
            <Text> </Text>
            <Button key="refresh" label="Refresh" hotkey="r" onPress={() => void loadChangedFiles($)} />
            <Text> </Text>
            <Button key="close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: REVIEW_PANE })} />
          </Box>
        </Box>
      )
    }

    const rows = await read($, reviewRowsState)
    const selection = await read($, reviewSelectionState)
    const draft = await read($, reviewDraftState)
    const layout = await read($, reviewLayoutState)
    const isExpanded = await read($, reviewExpandedState)
    const picked = await read($, reviewRowSelectionState)
    // Split rows hold these same row objects: a row's index by identity.
    const indexOfRow = new Map(rows.map((row, i) => [row, i] as const))
    const path = view.path
    const isDocked = e.props.placement === 'dock'
    const split = isSplit(layout, width)
    const terminalColumns = e.viewport?.columns ?? width

    // The marker before a line: `+` to comment it, `▌` while selected, `•`
    // when a comment ends there. The engine draws the line itself.
    const marker = (key: string, row: DiffLine) => {
      const anchor = anchorOf(row)!
      // Picked by clicks: every row of the range, removed ones too.
      const index = indexOfRow.get(row) ?? -1
      const isSelected =
        picked !== null ? index >= picked.from && index <= picked.to : isInAnchor(selection, path, anchor.side, anchor.line)
      const hasComment = comments.some(c => c.path === path && c.side === anchor.side && c.end === anchor.line)
      return (
        <Button
          key={key}
          plain
          dimColor={!isSelected && !hasComment}
          label={isSelected ? '▌' : hasComment ? '•' : '+'}
          onPress={() => void clickReviewLine($, path, index)}
        />
      )
    }
    const code = (row: DiffLine) => <Code source={lineHunk(row)} path={path} format="diff" wrap="truncate-end" />

    // Comments ending on one of these rows, then the comment field when the
    // selection ends there.
    const notes = (lines: readonly (DiffLine | undefined)[]) => {
      const anchors = lines.filter((l): l is DiffLine => l !== undefined).map(l => anchorOf(l)!)
      const ends = (side: string, line: number) => anchors.some(a => a.side === side && a.line === line)
      const here = comments.filter(c => c.path === path && ends(c.side, c.end))
      const isSelectionEnd = selection !== null && selection.path === path && ends(selection.side, selection.end)
      return (
        <Box flexDirection="column">
          {here.map(comment => {
            const [first = '', ...more] = comment.body.split('\n')
            return (
              <Box flexDirection="column" paddingLeft={2}>
                <Box flexDirection="row">
                  <Text dimColor>{`💬 ${anchorLabel(comment)}  `}</Text>
                  <Button key={`uncomment:${comment.id}`} plain dimColor label="✕" onPress={() => void removeReviewComment($, comment.id)} />
                </Box>
                {[first, ...more].map(line => (
                  <Box flexDirection="row">
                    <Text dimColor>{'┃ '}</Text>
                    <Text wrap="wrap">{line === '' ? ' ' : line}</Text>
                  </Box>
                ))}
              </Box>
            )
          })}
          {findings
            .filter(f => f.file === path && ends('after', f.line))
            .map(f => finding(f, false))}
          {isSelectionEnd && draft.map(line => <Text dimColor>{`  │ ${line}`}</Text>)}
          {isSelectionEnd && (
            <Input
              key="comment"
              value=""
              label={draft.length > 0 ? '  │' : `Comment ${anchorLabel(selection)}`}
              placeholder={draft.length > 0 ? 'Next line. Enter saves, end with \\ to add one more' : 'Enter saves. End with \\ to add a line'}
              autoFocus
              onSubmit={value => void submitCommentLine($, value)}
            />
          )}
        </Box>
      )
    }

    const half = Math.max(10, Math.floor((width - 1) / 2))
    const cell = (key: string, row: DiffLine | undefined) => (
      <Box width={half} flexDirection="row" overflow="hidden">
        {row === undefined ? <Text> </Text> : marker(key, row)}
        {row !== undefined && <Box flexGrow={1} overflow="hidden">{code(row)}</Box>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Button key="back" label="← Files" hotkey="b" onPress={() => void showReviewFiles($)} />
          <Text bold>{`  ${path}  `}</Text>
          <Button
            key="layout"
            label={split ? 'Unified' : 'Split'}
            hotkey="s"
            onPress={() => void update($, reviewLayoutState, () => (split ? 'unified' : 'split'))}
          />
          {isDocked && <Text> </Text>}
          {isDocked && (
            <Button
              key="expand"
              label={isExpanded ? '⤡ Shrink' : '⤢ Expand'}
              hotkey="e"
              onPress={() => void setReviewExpanded($, !isExpanded, terminalColumns)}
            />
          )}
          <Text> </Text>
          {comments.length + kept.length > 0 ? (
            <Button key="submit" label={`Send (${comments.length + kept.length})`} variant="primary" onPress={() => void submitReview($, '')} />
          ) : (
            <Button key="accept" label="✓ All good" variant="primary" onPress={() => void acceptReview($)} />
          )}
        </Box>
        <Text dimColor>
          {selection === null
            ? 'Click + to comment a line, a second + for a range.'
            : picked !== null && picked.from === picked.to
              ? `Selected ${anchorLabel(selection)}: click another + to extend, the same one to clear.`
              : `Selected ${anchorLabel(selection)}.`}
        </Text>
        {split
          ? toSplitRows(rows).map((row, index) =>
              row.kind === 'hunk' ? (
                <Text dimColor color="cyan" wrap="truncate-end">{row.text}</Text>
              ) : (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    {cell(`left:${index}`, row.left)}
                    <Text dimColor>│</Text>
                    {cell(`right:${index}`, row.right)}
                  </Box>
                  {notes([row.left, row.right])}
                </Box>
              ),
            )
          : rows.map((row, index) =>
              row.kind === 'hunk' ? (
                <Text dimColor color="cyan" wrap="truncate-end">{row.text}</Text>
              ) : (
                <Box flexDirection="column">
                  <Box flexDirection="row">
                    {marker(`line:${index}`, row)}
                    <Box flexGrow={1} overflow="hidden">{code(row)}</Box>
                  </Box>
                  {notes([row])}
                </Box>
              ),
            )}
      </Box>
    )
  })

  // Answers at once: the plan is stored and the panel opened; the verdict
  // reaches the agent later, as a prompt.
  on('tool.call', { tool: 'mcp__moonlightcode__present_plan' }, async ($, e) => {
    const input = e as unknown as { plan?: unknown; title?: unknown }
    const markdown = typeof input.plan === 'string' ? input.plan : ''
    if (markdown.trim() === '') return { deny: 'present_plan needs `plan`: the whole plan, as Markdown.' }
    const phase = await syncPhase($)
    if (phase !== 'plan')
      return {
        deny:
          `present_plan is a Plan tool, and the phase is ${phase} (${phaseRule(phase)}). ` +
          'Carry on with the work of this phase; if a plan needs approval first, ask for plan with request_phase.',
      }
    const title = typeof input.title === 'string' ? input.title.trim().split('\n')[0]! : ''
    const version = await presentPlan($, markdown, title)
    void openPlanPane($)
    return { result: presentedAnswer(version) }
  })

  // The Plan panel's actions as text: the way in where no surface draws it.
  on('command.run', { command: 'ml-plan' }, async ($, e) => {
    if (e.origin.kind !== 'composer')
      return { text: `Refused: /ml-plan only runs when the operator types it (origin: ${e.origin.kind}).` }
    const args = e.args.trim()
    const [verb = '', target = '', ...rest] = args.split(/\s+/)
    const said = args.slice(verb.length).trim()
    if (verb === 'approve' || verb === 'refine') return { text: await sendPlanVerdict($, verb, said !== '' ? said : undefined) }
    if (verb === 'reject') {
      if (said === '') return { text: 'Usage: /ml-plan reject <reason>' }
      return { text: await sendPlanVerdict($, 'reject', said) }
    }
    if (verb === 'comment') {
      const match = /^(\d+)(?:-(\d+))?$/.exec(target)
      if (match === null || rest.length === 0) return { text: 'Usage: /ml-plan comment <line[-end]> <text>' }
      const doc = await read($, planDocState)
      if (doc === null) return { text: 'No plan to comment: the agent has not presented one.' }
      if (doc.decided !== undefined) return { text: `Plan v${doc.version} is already ${VERDICT_WORD[doc.decided]}.` }
      const start = Number(match[1])
      const end = match[2] === undefined ? start : Number(match[2])
      // `\n` in the text starts a new line of the comment.
      const refused = await addPlanComment($, start, end, rest.join(' ').replace(/\\n/g, '\n'))
      return { text: refused ?? `Comment added on ${planSpan({ start, end })}.` }
    }
    if (verb === 'uncomment') {
      await removePlanComment($, target)
      return { text: `Comment ${target} removed.` }
    }
    if (verb !== '')
      return { text: 'Usage: /ml-plan [approve [note] | refine <note> | reject <reason> | comment <line[-end]> <text> | uncomment <id>]' }
    const placement = await togglePlanPane($)
    return { text: [placement, ...(await planReport($))].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PLAN_PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Markdown, Code } = $.ui.resolve(e)
    const doc = await read($, planDocState)
    const close = <Button key="plan-close" label="Close" role="dismiss" onPress={() => void $.ui.close({ id: PLAN_PANE })} />
    if (doc === null)
      return (
        <Box flexDirection="column">
          <Text bold color="cyan">Plan</Text>
          <Text dimColor>No plan yet. In the Plan phase, the agent's plan shows up here for you to approve.</Text>
          {close}
        </Box>
      )
    const comments = await read($, planCommentsState)
    const picked = await read($, planRowSelectionState)
    const draft = await read($, planDraftState)
    const note = await read($, planNoteState)
    const isRejecting = await read($, planRejectingState)
    const lines = parsePlan(doc.markdown)
    const isOpen = doc.decided === undefined
    const width = String(lines.length).length
    const selection = picked === null ? null : { start: picked.from + 1, end: picked.to + 1 }

    // Each line drawn as Claude's replies are, one line at a time so each keeps
    // its +: prose, headings and bullets through Markdown (a bullet's nesting
    // from its level, since a line alone loses it), code through the engine's
    // highlighter in the fence's language. A fence shows only its language; a
    // table row stays plain, a row alone not being a table.
    const lineText = (l: PlanLine) => {
      if (l.kind === 'blank') return <Text> </Text>
      if (l.kind === 'fence') return <Text dimColor>{l.opens === true ? (l.lang ?? 'code') : ' '}</Text>
      if (l.kind === 'code')
        return (
          <Box paddingLeft={2} flexGrow={1} overflow="hidden">
            <Code source={drawable(l.text) || ' '} {...(l.lang !== undefined ? { language: l.lang } : {})} wrap="truncate-end" />
          </Box>
        )
      if (isTableRow(l.text)) return <Text wrap="truncate-end">{l.text}</Text>
      return (
        <Box paddingLeft={(l.level ?? 0) * 2} flexGrow={1}>
          <Markdown text={drawable(l.kind === 'heading' ? l.text : l.text.trimStart())} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold color="cyan">{`Plan v${doc.version}`}</Text>
          {doc.title !== '' && <Text bold>{`  ${doc.title}`}</Text>}
          <Text dimColor>{`  ${isOpen ? 'waiting for you' : VERDICT_WORD[doc.decided!]}`}</Text>
        </Box>
        <Text dimColor>{counted(comments.length, 'comment')}</Text>
        {isOpen && (
          <Text dimColor>
            {selection === null
              ? 'Click + to comment a line, a second + for a range.'
              : picked!.from === picked!.to
                ? `Selected ${planSpan(selection)}: click another + to extend, the same one to clear.`
                : `Selected ${planSpan(selection)}.`}
          </Text>
        )}
        {lines.map((l, index) => {
          const isSelected = picked !== null && index >= picked.from && index <= picked.to
          const here = comments.filter(c => c.end === l.line)
          const isSelectionEnd = isOpen && picked !== null && picked.to === index
          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                {isOpen ? (
                  <Button
                    key={`pline:${index}`}
                    plain
                    dimColor={!isSelected && here.length === 0}
                    label={isSelected ? '▌' : here.length > 0 ? '•' : '+'}
                    onPress={() => void clickPlanLine($, index)}
                  />
                ) : (
                  <Text> </Text>
                )}
                <Text dimColor>{` ${String(l.line).padStart(width)} `}</Text>
                {lineText(l)}
              </Box>
              {here.map(comment => {
                const [first = '', ...more] = comment.body.split('\n')
                return (
                  <Box flexDirection="column" paddingLeft={2}>
                    <Box flexDirection="row">
                      <Text dimColor>{`💬 ${planSpan(comment)}  `}</Text>
                      {isOpen && <Button key={`plan-uncomment:${comment.id}`} plain dimColor label="✕" onPress={() => void removePlanComment($, comment.id)} />}
                    </Box>
                    {[first, ...more].map(line => (
                      <Box flexDirection="row">
                        <Text dimColor>{'┃ '}</Text>
                        <Text wrap="wrap">{line === '' ? ' ' : line}</Text>
                      </Box>
                    ))}
                  </Box>
                )
              })}
              {isSelectionEnd && draft.map(line => <Text dimColor>{`  │ ${line}`}</Text>)}
              {isSelectionEnd && selection !== null && (
                <Input
                  key="plan-comment"
                  value=""
                  label={draft.length > 0 ? '  │' : `Comment ${planSpan(selection)}`}
                  placeholder={draft.length > 0 ? 'Next line. Enter saves, end with \\ to add one more' : 'Enter saves. End with \\ to add a line'}
                  autoFocus
                  onSubmit={value => void submitPlanCommentLine($, value)}
                />
              )}
            </Box>
          )
        })}
        <Text> </Text>
        {isOpen && (
          <Input
            key="plan-note"
            value={note}
            label="Note (optional)"
            placeholder="An overall note for the agent"
            onInput={value => void update($, planNoteState, () => value)}
            onSubmit={value => void update($, planNoteState, () => value.trim())}
          />
        )}
        {isOpen && isRejecting && (
          <Box flexDirection="column">
            <Input
              key="plan-reason"
              value=""
              label="Why reject?"
              placeholder="Tell the agent why. Enter rejects"
              autoFocus
              onSubmit={value => void sendPlanVerdict($, 'reject', value)}
            />
            <Button key="plan-reject-cancel" plain label="Cancel" onPress={() => void update($, planRejectingState, () => false)} />
          </Box>
        )}
        <Box flexDirection="row">
          {isOpen && !isRejecting && (
            <Box flexDirection="row">
              <Button key="plan-approve" label="✓ Approve" variant="primary" onPress={() => void sendPlanVerdict($, 'approve')} />
              <Text> </Text>
              {canSend('refine', comments, note) && (
                <Box flexDirection="row">
                  <Button key="plan-refine" label={`✎ Ask for changes (${comments.length})`} onPress={() => void sendPlanVerdict($, 'refine')} />
                  <Text> </Text>
                </Box>
              )}
              <Button key="plan-reject" label="✕ Reject" onPress={() => void update($, planRejectingState, () => true)} />
              <Text> </Text>
            </Box>
          )}
          {close}
        </Box>
      </Box>
    )
  })

  on('tool.call', { tool: 'mcp__moonlightcode__request_phase' }, async ($, e) => {
    const input = e as unknown as { phase?: string; reason?: string }
    const current = await readPhase($)
    const word = input.phase?.trim().toLowerCase() ?? ''
    const to = word === 'next' || word === '' ? nextPhase(current) : phaseFromToken(word)
    if (to === undefined) return { deny: `Unknown phase "${input.phase}": one of ${PHASES.join(', ')}, or next.` }
    if (to === current) return { result: `Already in ${current} (${phaseRule(current)}); nothing to request.` }
    await setPending($, { to, reason: input.reason?.trim() || '(no reason given)' })
    await openPhasePane($, true)
    return {
      result:
        `Request to switch ${current} → ${to} (${phaseRule(to)}) submitted to the operator. Not applied yet. ` +
        'Tell the operator in one line to answer with the Moonlight band or pane, or by typing ' +
        '`/phase approve` or `/phase deny` (the only way in the VS Code extension), then wait for ' +
        'the [moonlight] note with the decision.',
    }
  })

  // The phase, always visible above the prompt. Its buttons are pressed by the
  // operator only: the agent has no access to the interface.
  // The phase, under the prompt: the current one as a coloured badge, the
  // switch a dim word beside it, then the engine's own hint.
  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // The daemon governs: its phase is shown by the IDE, not here.
    if ((await read($, governorState)) === 'daemon')
      return (
        <Box flexDirection="row">
          <Text key="governor" dimColor>{'☾ gated by the MoonlightCode daemon'}</Text>
          {e.props.hint !== '' && <Text dimColor>{`   ${e.props.hint}`}</Text>}
        </Box>
      )
    const phase = await read($, phaseState)
    const style = phaseStyle(phase)
    const next = nextPhase(phase)
    return (
      <Box flexDirection="row">
        <Text bold color="black" backgroundColor={style.color}>{style.badge}</Text>
        <Text color={style.color}>{` ${phaseRule(phase)} `}</Text>
        <Button key="phase-switch" plain dimColor label={`· next: ${next}`} onPress={() => void operatorSetPhase($, next)} />
        {e.props.hint !== '' && <Text dimColor>{`   ${e.props.hint}`}</Text>}
      </Box>
    )
  })

  // Above the prompt, only while the agent asks for a phase change: Approve
  // and Deny need the band's focus and hotkeys. Otherwise the space is left free.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const request = await read($, pendingState)
    if (request === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text bold color="black" backgroundColor={phaseStyle(request.to).color}>{` ? ${PHASE_GLYPH[request.to]} ${request.to.toUpperCase()} `}</Text>
        <Text>{`  The agent asks to move to ${request.to} (${phaseRule(request.to)})${request.reason !== '' ? `: ${request.reason}` : ''}  `}</Text>
        <Button key="band-approve" label="Approve" hotkey="y" variant="primary" onPress={() => void decide($, true)} />
        <Text> </Text>
        <Button key="band-deny" label="Deny" hotkey="n" onPress={() => void decide($, false)} />
      </Box>
    )
  })

  // Same controls as the band, on every surface (the only view in VS Code).
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const phase = await read($, phaseState)
    const request = await read($, pendingState)
    const style = phaseStyle(phase)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold color="black" backgroundColor={style.color}>{style.badge}</Text>
          <Text color={style.color}>{`  ${phaseRule(phase)}`}</Text>
        </Box>
        {/* The current phase stands out; the others are dim words to jump to, never highlighted. */}
        <Box flexDirection="row">
          {PHASES.map(p => (
            <Box flexDirection="row">
              {p === phase ? (
                <Text bold color={style.color}>{p}</Text>
              ) : (
                <Button key={`pane-phase:${p}`} plain dimColor label={p} hotkey={p.charAt(0)} onPress={() => void operatorSetPhase($, p)} />
              )}
              <Text dimColor>{p === 'commit' ? '' : ' → '}</Text>
            </Box>
          ))}
        </Box>
        {request !== null && (
          <Box flexDirection="column">
            <Text bold>{`The agent asks to move to ${request.to} (${phaseRule(request.to)})`}</Text>
            <Text dimColor>{request.reason}</Text>
            <Box flexDirection="row">
              <Button key="approve" label="Approve" hotkey="y" variant="primary" autoFocus onPress={() => void decide($, true)} />
              <Text> </Text>
              <Button key="deny" label="Deny" hotkey="n" onPress={() => void decide($, false)} />
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // The read-only phases (Plan, Commit) are deny-by-default for tools. Listed tools go on (Bash and the
  // file tools to their own hooks below); anything else is refused, MCP tools
  // and cross-session tools included.
  // Every gate hook carries a handler: a hook that throws or runs out of time
  // would otherwise be skipped, and the call it guards would run.
  on('tool.call', async ($, e, next) => {
    if (governor === 'daemon') return next(e)
    const phase = await syncPhase($)
    if (allowsWrites(phase) || isAllowedInPlan(e.tool)) return next(e)
    const label = phaseLabel(phase)
    if (CLAUDE_PLAN_MODE_TOOLS.includes(e.tool))
      return {
        deny:
          `Moonlight (${label}): ${e.tool} is not used here, since Claude Code's plan mode leaves auto mode. ` +
          (phase === 'plan'
            ? 'Present the plan with mcp__moonlightcode__present_plan instead, then wait for the verdict.'
            : 'Ask for the plan phase with request_phase if a plan is needed.'),
      }
    // An MCP tool is the operator's call rather than a hard refusal.
    if (e.tool.startsWith('mcp__')) {
      const { allowed, said } = await askForMcpTool($, e.tool, label)
      if (allowed) return next(e)
      return {
        deny:
          `Moonlight (${label}): the operator did not allow ${e.tool}` +
          (said === MCP_DENY ? '.' : `: "${said}".`) +
          ' Carry on without it, or ask for a writable phase with request_phase.',
      }
    }
    return {
      deny:
        `Moonlight (${label}): ${e.tool} is not on the read-only allow-list. ${label} only runs read-only tools ` +
        `(${phaseRule(phase)}); use it in a writable phase, or ask the operator with request_phase.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))

  // Every phase: a shell command (Bash, Monitor) only runs under a safe sandbox
  // carrying this mod's deny list, since even Auto keeps the gate's own files
  // write-denied.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (governor === 'daemon') return next(e)
    const phase = await syncPhase($)
    // A writable phase runs it outside the sandbox; only the gate's own files
    // stay out of reach, on the command's own words (best effort).
    if (allowsWrites(phase)) return gateFilesRefusal(e.command, 'Bash', phase) ?? next(e)
    const refused = await shellRefusal($, 'Bash', phase)
    if (refused !== undefined) return refused
    return afterShell($, phase, await next(e.dangerouslyDisableSandbox === true ? { ...e, dangerouslyDisableSandbox: false } : e))
  }).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))
  // Monitor runs its script in Bash's shell and sandbox. A WebSocket monitor
  // (`ws`, no `command`) runs nothing.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const command = (e as unknown as { command?: unknown }).command
    if (governor === 'daemon' || command === undefined) return next(e)
    const phase = await syncPhase($)
    if (allowsWrites(phase)) return gateFilesRefusal(String(command), 'Monitor', phase) ?? next(e)
    const refused = await shellRefusal($, 'Monitor', phase)
    if (refused !== undefined) return refused
    return afterShell($, phase, await next(e))
  }).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))

  // Allowed writes keep a baseline of the file first, for the Review panel.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    (await guardWrite($, e.file_path)) ?? (await captureBaseline($, e.file_path), next(e))).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))
  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    (await guardWrite($, e.file_path)) ?? (await captureBaseline($, e.file_path), next(e))).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) =>
    (await guardWrite($, e.notebook_path)) ?? (await captureBaseline($, e.notebook_path), next(e))).catch(($, e, next) => (next.called ? next(e) : { deny: gateFailure(next.error) }))

  // The running review's skill reviews as it always does; its prompt gets
  // what to review and the findings block to end with.
  on('skill.prompt', async ($, e, next) => {
    const prompted = await next(e)
    try {
      if (!(await claimsContract($, e.skill))) return prompted
      return { ...prompted, text: `${prompted.text}\n${await contractFor($)}` }
    } catch {
      // Without the contract the skill still runs; its findings just do not land.
      return prompted
    }
  })

  // The turn a panel run submitted is the run's: its end ends the run, the
  // skill's prompt hook seen or not.
  on('turn.start', async ($, e, next) => {
    lastTurnId = e.turnId
    try {
      const running = await read($, reviewRunState)
      if (running !== null && running.turnId === undefined && e.text.includes(runPrompt(running.skill)))
        await update($, reviewRunState, () => ({ ...running, turnId: e.turnId }))
    } catch {
      // A run not tied to its turn still ends on the first main-loop end.
    }
    return next(e)
  })

  // Any answer ending with a findings block, the main loop's or a subagent's,
  // loads it into the panel.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      await ingestAnswer($, e.answer, { turnId: e.turnId, isMainLoop: e.agentId === undefined, isAborted: e.isAborted })
    } catch (error) {
      $.ui.toast(`Moonlight: findings not loaded: ${String(error)}`)
    }
    return done
  })

  // A /clear ends the conversation: its review goes with it. Other ends keep
  // the baselines, for a --resume; the stale sweep takes them later.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await dropBaseline($, e.sessionId)
      } catch {
        // Ends stay fast and never fail: the sweep catches what is left.
      }
    }
    return next(e)
  })
}
