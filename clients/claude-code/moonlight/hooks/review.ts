// Pure logic of the Review panel: diff lines, line selection, comments.
// No `$` here, so it is unit-testable.

export type DiffLineKind = 'context' | 'added' | 'removed' | 'hunk'

// One row of a file's diff, as the panel draws it. `newLine` is the line in
// the current file (comments anchor there, side After); a removed line has
// only `oldLine` (side Before).
export type DiffLine = {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

// `path`: as shown and commented, relative to the session root (the repo's
// folder first when the root holds several). `repo`: the repo's absolute
// folder; `repoPath`: the path inside it, as git takes it. `baseline`: set when
// the diff is against the file's baseline, not HEAD: the blob, or `/dev/null`;
// `skipped`: why that file has no diff.
export type ChangedFile = {
  path: string
  status: string
  added: number
  removed: number
  repo: string
  repoPath: string
  baseline?: string
  skipped?: string
}

// "1 comment", "3 comments": what a person reads, never "comment(s)".
export const counted = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

// ---- Baselines: each file as it was before the agent first changed it ----

// Larger files, and binary ones, are not copied: the panel says why instead.
export const BASELINE_MAX_BYTES = 1_000_000

// `copy`: the blob holding the file as it was; `absent`: the file did not
// exist (the agent created it); `skipped`: not copied, `reason` says why.
export type BaselineEntry =
  | { kind: 'copy'; blob: string }
  | { kind: 'absent' }
  | { kind: 'skipped'; reason: string }

// By absolute path.
export type BaselineIndex = Record<string, BaselineEntry>

export const parseBaselineIndex = (text: string): BaselineIndex => {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as BaselineIndex) : {}
  } catch {
    return {}
  }
}

// What to keep of a file about to change: its text, or why not.
export const baselineOf = (text: string): { text: string } | { reason: string } =>
  text.length > BASELINE_MAX_BYTES
    ? { reason: `over ${BASELINE_MAX_BYTES / 1_000_000} MB` }
    : text.includes('\u0000')
      ? { reason: 'binary' }
      : { text }

// Names a blob by its content (cyrb53, 53 bits): the same content is stored once.
export const contentHash = (text: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

// A file's status against its baseline: created, deleted, or modified.
export const baselineStatus = (entry: BaselineEntry, isPresent: boolean): string =>
  entry.kind === 'absent' ? 'A' : isPresent ? 'M' : 'D'

// The first `git diff --numstat` line's counts.
export const parseNumstat = (numstat: string): { added: number; removed: number } => {
  const [added = '0', removed = '0'] = (numstat.split('\n')[0] ?? '').split('\t')
  return { added: Number(added) || 0, removed: Number(removed) || 0 }
}

// An untracked file's count, from `git diff --no-index --numstat /dev/null f`:
// git prints `-` for a binary file, which is not "no lines".
export const untrackedCount = (numstat: string): { added: number; removed: number } | { skipped: string } =>
  /^-\t-\t/.test(numstat) ? { skipped: 'binary' } : parseNumstat(numstat)

// Past this many untracked files, the rest are listed uncounted: one git call
// each, on every refresh, would stall the panel (an un-ignored build folder).
export const UNTRACKED_COUNT_MAX = 200

// Which changes the panel shows: the agent's since the baselines (`session`),
// or everything against HEAD; `auto` picks `session` once a baseline exists.
export type ReviewScope = 'auto' | 'session' | 'head'

export const effectiveScope = (scope: ReviewScope, hasBaselines: boolean): 'session' | 'head' =>
  scope === 'auto' ? (hasBaselines ? 'session' : 'head') : scope

// A git repository under the session root: its absolute folder, and its folder
// relative to the root (`''` for the root itself).
export type Repo = { dir: string; prefix: string }

// How deep under the root to look for repositories, and what never to enter.
export const REPO_SEARCH_DEPTH = 4
export const REPO_SEARCH_SKIP = ['node_modules', 'target', '.venv', 'dist', 'build']

// Parses `find` output (one `<dir>/.git` per line) into repos under `root`.
export const parseRepoDirs = (found: string, root: string): Repo[] =>
  found
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.endsWith('/.git'))
    .map(line => line.slice(0, -'/.git'.length))
    .filter(dir => dir === root || dir.startsWith(`${root}/`))
    .map(dir => ({ dir, prefix: dir === root ? '' : dir.slice(root.length + 1) }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix))

// Places one repo's changed files under the session root.
export const inRepo = (files: readonly Omit<ChangedFile, 'repo' | 'repoPath'>[], repo: Repo): ChangedFile[] =>
  files.map(file => ({
    ...file,
    path: repo.prefix === '' ? file.path : `${repo.prefix}/${file.path}`,
    repo: repo.dir,
    repoPath: file.path,
  }))

export type LineSide = 'before' | 'after'

// A comment's anchor: a line range on one side of a file's diff.
// `removed`: the old lines a range on the new side also covers.
export type LineAnchor = {
  path: string
  side: LineSide
  start: number
  end: number
  removed?: { start: number; end: number }
}

// `excerpt`: the commented lines as they were when the comment was written.
export type ReviewComment = LineAnchor & { id: string; body: string; excerpt?: string }

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// Parses one file's unified diff (`git diff` output) into drawable rows.
// File headers (`diff --git`, `index`, `---`, `+++`) are skipped.
export const parseFileDiff = (diff: string): DiffLine[] => {
  const rows: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let isInHunk = false
  for (const raw of diff.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header !== null) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      isInHunk = true
      rows.push({ kind: 'hunk', text: raw })
      continue
    }
    if (!isInHunk || raw.startsWith('\\')) continue
    if (raw.startsWith('+')) rows.push({ kind: 'added', text: raw.slice(1), newLine: newLine++ })
    else if (raw.startsWith('-')) rows.push({ kind: 'removed', text: raw.slice(1), oldLine: oldLine++ })
    else if (raw.startsWith(' ') || raw === '')
      rows.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ })
  }
  // A trailing newline in the diff text leaves one empty context row: drop it.
  while (rows.length > 0 && rows[rows.length - 1]!.kind === 'context' && rows[rows.length - 1]!.text === '' && diff.endsWith('\n'))
    rows.pop()
  return rows
}

// Parses `git diff --numstat` plus `git status --porcelain` into the files list.
export const parseChangedFiles = (numstat: string, porcelain: string): Omit<ChangedFile, 'repo' | 'repoPath'>[] => {
  const stats = new Map<string, { added: number; removed: number }>()
  for (const line of numstat.split('\n')) {
    const [added, removed, path] = line.split('\t')
    if (path === undefined) continue
    stats.set(path, { added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  const files: Omit<ChangedFile, 'repo' | 'repoPath'>[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2).trim() || 'M'
    const path = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!
    const stat = stats.get(path) ?? { added: 0, removed: 0 }
    files.push({ path, status, ...stat })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// Where a row can be commented: the current file's line, else the old one.
export const anchorOf = (row: DiffLine): { side: LineSide; line: number } | undefined =>
  row.newLine !== undefined
    ? { side: 'after', line: row.newLine }
    : row.oldLine !== undefined
      ? { side: 'before', line: row.oldLine }
      : undefined

// Line selection by clicks: a first click picks a line, a second click on the
// same side extends it to a range, a click on a line already the whole range
// clears it. A click on the other side starts over there.
// The rows picked in the open file's diff, by index: a range may mix removed,
// added and context lines, as a changed block does.
export type RowRange = { from: number; to: number }

// Click a row; a second click extends to a range; clicking the single picked
// row again clears it; a click after a range starts over.
export const nextRowSelection = (current: RowRange | null, clicked: number): RowRange | null => {
  if (current === null || current.from !== current.to) return { from: clicked, to: clicked }
  if (current.from === clicked) return null
  return { from: Math.min(current.from, clicked), to: Math.max(current.from, clicked) }
}

// Where a comment on those rows anchors: on the current file's lines they
// cover, the removed lines among them noted aside; on the old lines when
// they are all removed ones.
export const anchorOfRows = (rows: readonly DiffLine[], path: string, range: RowRange): LineAnchor | null => {
  const picked = rows.slice(range.from, range.to + 1)
  const after = picked.flatMap(r => (r.newLine === undefined ? [] : [r.newLine]))
  const before = picked.flatMap(r => (r.kind === 'removed' && r.oldLine !== undefined ? [r.oldLine] : []))
  if (after.length > 0) {
    const anchor: LineAnchor = { path, side: 'after', start: Math.min(...after), end: Math.max(...after) }
    return before.length > 0 ? { ...anchor, removed: { start: Math.min(...before), end: Math.max(...before) } } : anchor
  }
  return before.length > 0 ? { path, side: 'before', start: Math.min(...before), end: Math.max(...before) } : null
}

// The picked rows as diff text, so the agent sees what was commented.
export const excerptOfRows = (rows: readonly DiffLine[], range: RowRange): string =>
  rows
    .slice(range.from, range.to + 1)
    .filter(row => row.kind !== 'hunk')
    .map(row => `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}${row.text}`)
    .join('\n')

// ---- Drawing rows with the engine's diff highlighter ----

// Control characters a `Code` source may not hold (tab is allowed).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

// One row as a one-line unified-diff hunk, for a `Code` element with
// `format: 'diff'`: the engine then draws that row's line numbers, marker,
// add/remove colour and syntax highlighting, GitHub style.
export const lineHunk = (row: DiffLine): string => {
  const text = row.text.replace(CONTROL, '')
  if (row.kind === 'added') return `@@ -${row.newLine! - 1},0 +${row.newLine},1 @@\n+${text}`
  if (row.kind === 'removed') return `@@ -${row.oldLine},1 +${row.oldLine! - 1},0 @@\n-${text}`
  return `@@ -${row.oldLine},1 +${row.newLine},1 @@\n ${text}`
}

// One row of the side-by-side view: the old file on the left, the new on
// the right. A changed block pairs its removed lines with its added ones,
// line by line, as GitHub's split view does; context lines sit on both sides.
export type SplitRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'pair'; left?: DiffLine; right?: DiffLine }

export const toSplitRows = (rows: readonly DiffLine[]): SplitRow[] => {
  const split: SplitRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(removed.length, added.length); i += 1)
      split.push({ kind: 'pair', left: removed[i], right: added[i] })
    removed = []
    added = []
  }
  for (const row of rows) {
    if (row.kind === 'removed') {
      // A removed line after added ones starts a new changed block.
      if (added.length > 0) flush()
      removed.push(row)
    } else if (row.kind === 'added') added.push(row)
    else {
      flush()
      split.push(row.kind === 'hunk' ? { kind: 'hunk', text: row.text } : { kind: 'pair', left: row, right: row })
    }
  }
  flush()
  return split
}

// The side-by-side view only when each side keeps room for code.
export const SPLIT_MIN_COLUMNS = 140

export type ReviewLayout = 'auto' | 'unified' | 'split'

export const isSplit = (layout: ReviewLayout, bodyColumns: number): boolean =>
  layout === 'split' || (layout === 'auto' && bodyColumns >= SPLIT_MIN_COLUMNS)

export const isInAnchor = (anchor: LineAnchor | null, path: string, side: LineSide, line: number): boolean =>
  anchor !== null && anchor.path === path && anchor.side === side && line >= anchor.start && line <= anchor.end

const span = (start: number, end: number): string => (start === end ? `${start}` : `${start}-${end}`)

export const anchorLabel = (anchor: LineAnchor): string =>
  `${anchor.path}:${span(anchor.start, anchor.end)}` +
  (anchor.side === 'before' ? ' (removed)' : '') +
  (anchor.removed !== undefined ? ` (+ removed ${span(anchor.removed.start, anchor.removed.end)})` : '')

// A comment of several lines from a one-line field: a line ending with `\`
// goes on to the next, as in a shell; the first line without it ends the
// comment. Answers the draft so far, or the whole body.
export const continueDraft = (draft: readonly string[], value: string): { draft: string[] } | { body: string } => {
  const line = value.replace(/\s+$/, '')
  if (line.endsWith('\\')) return { draft: [...draft, line.slice(0, -1).replace(/\s+$/, '')] }
  return { body: [...draft, line].join('\n').trim() }
}

// The rows a selection covers, as text, so the agent sees what was commented.
export const excerptOf = (rows: readonly DiffLine[], anchor: LineAnchor): string =>
  rows
    .filter(row => {
      const at = anchorOf(row)
      return at !== undefined && isInAnchor(anchor, anchor.path, at.side, at.line)
    })
    .map(row => `${row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}${row.text}`)
    .join('\n')

// The review as one message to the agent: an optional summary, then every
// comment grouped by file, in line order, each with the lines it is about.
// `findings`: the AI reviewer's findings the operator kept, already formatted;
// they lead, worst first, with the operator's decision on each.
export const formatReview = (
  comments: readonly ReviewComment[],
  summary: string,
  findings: readonly string[] = [],
): string => {
  const byFile = new Map<string, ReviewComment[]>()
  for (const comment of comments) byFile.set(comment.path, [...(byFile.get(comment.path) ?? []), comment])
  const sections = [...byFile.entries()].map(([path, list]) => {
    const items = [...list]
      .sort((a, b) => a.start - b.start)
      .map(c => {
        const quote =
          c.excerpt !== undefined && c.excerpt !== ''
            ? `\n  \`\`\`diff\n${c.excerpt.replace(/^/gm, '  ')}\n  \`\`\``
            : ''
        // A body of several lines stays inside its list item.
        return `- ${anchorLabel(c)}: ${c.body.replace(/\n/g, '\n  ')}${quote}`
      })
    return [`### ${path}`, ...items].join('\n')
  })
  const parts = [
    ...(findings.length > 0 ? [`${findings.length} finding(s) the operator kept from the AI review`] : []),
    ...(comments.length > 0 ? [`${comments.length} comment(s) on ${byFile.size} file(s)`] : []),
  ]
  return [
    `[moonlight] Code review from the operator: ${parts.join(', ')}.`,
    'Address each item: change the code, or explain why not. A line marked "→ Operator" is their decision ' +
      'about that finding and wins over the reviewer. Then summarize what you did, per item.',
    ...(summary.trim() !== '' ? ['', `Summary: ${summary.trim()}`] : []),
    ...(findings.length > 0 ? ['', '## Findings', ...findings] : []),
    ...(comments.length > 0 && findings.length > 0 ? ['', '## Comments'] : []),
    '',
    ...sections,
  ].join('\n')
}
