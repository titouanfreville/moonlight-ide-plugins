// Pure logic of review findings: attaching an existing review skill, reading
// what it found, and the operator's triage. No `$` here, so it is unit-testable.
//
// The output contract is the one `moonlight-review` and the desktop panel use
// (packaging/skills/moonlight-review/SKILL.md): one fenced `moonlight-findings`
// JSON block, last in the answer.

export type Severity = 'high' | 'medium' | 'low'
export type Route = 'patch' | 'decision' | 'defer'

export type Finding = {
  key: string
  severity: Severity
  route: Route
  owner: string[]
  file: string
  line: number
  summary: string
  detail: string
  fix?: string
}

// A finding plus the operator's call on it: kept (sent with the review, with
// the note as the decision) or dismissed (dropped from this pass).
export type TriagedFinding = Finding & { id: string; decision: 'keep' | 'dismiss'; note?: string }

export type FindingsReport = { findings: Finding[]; notes: string; lanesFailed: string[] }

// Review skills attached when neither the plugin option nor the operator says
// otherwise: BMAD's and Claude Code's. A team adds its own through the
// `reviewSkills` option (plugin.json), not here.
export const DEFAULT_ATTACHED = ['bmad-code-review', 'code-review']

// The `reviewSkills` option: names separated by commas or spaces.
export const parseSkillList = (text: unknown): string[] | undefined => {
  if (typeof text !== 'string') return undefined
  const names = text.split(/[\s,]+/).filter(name => name !== '')
  return names.length > 0 ? [...new Set(names)] : undefined
}

// The attached skills the session can run, by the names its commands list
// (`plugin:name` or bare); with no list to go by, all of them.
export const installedSkills = (attached: readonly string[], commands: readonly string[] | undefined): string[] =>
  commands === undefined ? [...attached] : attached.filter(skill => commands.some(name => isAttached(name, [skill])))

// A skill matches by its name, bare or under its plugin (`plugin:name`).
export const isAttached = (skill: string, attached: readonly string[]): boolean =>
  attached.some(name => skill === name || skill.endsWith(`:${name}`))

const SEVERITIES: readonly string[] = ['high', 'medium', 'low']
const ROUTES: readonly string[] = ['patch', 'decision', 'defer']

const FENCE = '```moonlight-findings'

// Reads the last findings block of an answer. A block that is missing or does
// not parse is an error, never an empty review: a failed review must not read
// as a clean one.
export const parseFindings = (answer: string): FindingsReport | { error: string } => {
  const start = answer.lastIndexOf(FENCE)
  if (start < 0) return { error: 'no moonlight-findings block in the answer' }
  const body = answer.slice(start + FENCE.length)
  const end = body.indexOf('```')
  if (end < 0) return { error: 'the moonlight-findings block is not closed' }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(0, end))
  } catch (error) {
    return { error: `the moonlight-findings block is not JSON: ${String(error)}` }
  }
  const root = (parsed ?? {}) as { findings?: unknown; coverage?: { notes?: unknown; lanes_failed?: unknown } }
  if (!Array.isArray(root.findings)) return { error: 'the moonlight-findings block has no findings array' }
  const findings: Finding[] = []
  for (const [i, raw] of root.findings.entries()) {
    const f = (raw ?? {}) as Record<string, unknown>
    if (!SEVERITIES.includes(String(f.severity))) return { error: `finding ${i + 1}: unknown severity ${String(f.severity)}` }
    if (typeof f.file !== 'string' || typeof f.summary !== 'string' || !Number.isInteger(f.line))
      return { error: `finding ${i + 1}: needs file, line and summary` }
    findings.push({
      key: typeof f.key === 'string' && f.key !== '' ? f.key : `F${i + 1}`,
      severity: f.severity as Severity,
      route: ROUTES.includes(String(f.route)) ? (f.route as Route) : 'decision',
      owner: Array.isArray(f.owner) ? f.owner.map(String) : [],
      file: f.file,
      line: f.line as number,
      summary: f.summary,
      detail: typeof f.detail === 'string' ? f.detail : '',
      ...(typeof f.fix === 'string' && f.fix !== '' ? { fix: f.fix } : {}),
    })
  }
  const coverage = root.coverage ?? {}
  return {
    findings: sortFindings(findings),
    notes: typeof coverage.notes === 'string' ? coverage.notes : '',
    lanesFailed: Array.isArray(coverage.lanes_failed) ? coverage.lanes_failed.map(String) : [],
  }
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

// Worst first, then by place: the order a reviewer wants to read.
export const sortFindings = <F extends Finding>(findings: readonly F[]): F[] =>
  [...findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line,
  )

// What the review covers, for the skill: each file with the copy it is to be
// diffed against, or the repo to diff against HEAD.
export type ScopeFile = { path: string; baseline?: string; status: string }

// A path as one shell word, for the commands the contract hands the skill.
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

// Appended to an attached skill's prompt: what to review and how to answer.
// It leaves how the skill reviews alone.
export const findingsContract = (root: string, scope: 'session' | 'head', files: readonly ScopeFile[]): string => {
  const list = files.map(f => {
    if (f.baseline === undefined) return `- ${f.path} (${f.status}; diff against HEAD in its repository)`
    return f.baseline === '/dev/null'
      ? `- ${f.path} (created this session: all of it is new)`
      : `- ${f.path} (before this session: ${f.baseline}; diff with \`git diff --no-index -- ${shellQuote(f.baseline)} ${shellQuote(`${root}/${f.path}`)}\`)`
  })
  return [
    '',
    '---',
    '[moonlight] The operator reviews your findings in the MoonlightCode Review panel. Two additions to this review:',
    '',
    `1. Scope. Review these files under ${root} (${scope === 'session' ? "this session's changes, against the copies saved before the session changed them" : 'everything changed against HEAD'}):`,
    ...(list.length > 0 ? list : ['- (no changed files: say so in coverage.notes)']),
    '',
    '2. Output. Run the review exactly as this skill says, then end your answer with ONE fenced block, nothing after it:',
    '',
    '```moonlight-findings',
    '{ "coverage": { "notes": "what was or was not checked" },',
    '  "findings": [ { "key": "H1", "severity": "high|medium|low", "route": "patch|decision|defer",',
    '    "owner": ["who raised it"], "file": "path as listed above", "line": 12,',
    '    "summary": "one line, read as a claim", "detail": "why it is true, where it is reachable from", "fix": "optional" } ] }',
    '```',
    '',
    '`line` is 1-based in the file as it is now. Emit the block even with no findings: an empty array is a result.',
    '',
    'If the skill runs in the background or in a subagent, it only gets what you pass it: pass it this scope, and',
    'write the block yourself in the answer where you report its results, with every finding it returned.',
  ].join('\n')
}

// Where a finding is, short enough for a button in a docked panel: the last
// two segments of its path. A button does not shrink, so a long path would
// push the rest of its row out of sight.
export const findingPlace = (file: string, line: number): string => `${file.split('/').slice(-2).join('/')}:${line}`

// The marker of the operator's decision belongs to the operator alone: the
// reviewer's text (the model's) cannot carry it.
const OPERATOR_MARK = '→'
const asReviewer = (text: string): string => text.replaceAll(OPERATOR_MARK, '->')

// A kept finding as the agent reads it, the operator's note labelled as theirs.
export const formatFinding = (f: TriagedFinding): string => {
  const lines = [`- ${f.file}:${f.line} [${f.severity}, ${f.route}] ${asReviewer(f.summary)}`]
  if (f.detail !== '') lines.push(...f.detail.split('\n').map(l => `  ${asReviewer(l)}`))
  if (f.fix !== undefined)
    lines.push(...asReviewer(f.fix).split('\n').map((l, i) => (i === 0 ? `  Suggested fix: ${l}` : `  ${l}`)))
  if (f.note !== undefined) lines.push(...f.note.split('\n').map(l => `  ${OPERATOR_MARK} Operator: ${l}`))
  return lines.join('\n')
}
