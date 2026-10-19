// Pure logic of the file bridge between the mod and the MoonlightCode IDE
// plugins (VS Code, JetBrains). No `$` here, so it is unit-testable.
//
// The mod cannot listen, so the two meet in files, per session, under
// ~/.moonlight/mod/sessions/<id>/ (the gate refuses the agent there):
// - state.json: what the IDE panels show, written by the mod while it governs;
// - inbox/<entry>.json: one operator decision each, written by the IDE;
// - outbox/<entry>.json: the mod's answer to it. An entry with an answer is
//   done; the IDE removes both files once it has read the answer.
// The format is versioned: `v` changes when a reader would misread it.

import { PHASES, type Phase } from './policy'
import type { PlanVerdict } from './plan'

export const BRIDGE_VERSION = 1

export type BridgePlan = { version: number; title: string; markdown: string; decided?: PlanVerdict }

export type BridgeState = {
  v: number
  sessionId: string
  root: string | null
  // The session's name for the panels; null until it has one.
  title: string | null
  phase: Phase
  pending: { to: Phase; reason: string } | null
  plan: BridgePlan | null
  updatedMs: number
}

const TITLE_MAX = 80

// The session's name as Claude Code keeps it in the transcript: the operator's
// own (`/rename`, the IDE's rename) wins over the one Claude Code generated; the
// latest of each counts. `lines`: the transcript's title entries.
export const titleFromTranscript = (lines: string): string | undefined => {
  let custom: string | undefined
  let generated: string | undefined
  for (const line of lines.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as { type?: unknown; customTitle?: unknown; aiTitle?: unknown }
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') custom = entry.customTitle
      if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') generated = entry.aiTitle
    } catch {
      // A line cut short or not JSON names nothing.
    }
  }
  return custom?.trim() || generated?.trim() || undefined
}

// The session's name: Claude Code's title once it has one; until then the one
// already chosen, else the first line of the operator's first prompt. Commands
// (`/phase`) and the mod's own prompts name nothing.
export const sessionTitleFrom = (title: string | undefined, prompt: string | undefined, current: string | null): string | null => {
  const clip = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1).trimEnd()}…` : s)
  const given = title?.trim()
  if (given) return clip(given)
  if (current !== null) return current
  const line = prompt?.split('\n').map(l => l.trim()).find(l => l !== '')
  if (line === undefined || line.startsWith('/') || line.startsWith('[moonlight]') || line.startsWith('The moonlightcode plugin')) return null
  return clip(line)
}

export type PlanComment = { start: number; end: number; body: string }

// A diff-line anchor, as the Review panel has it: 1-based lines of one side.
export type ReviewAnchor = { path: string; side: 'before' | 'after'; start: number; end: number }

export type ReviewEntry =
  | ({ kind: 'review-comment'; body: string; excerpt?: string } & ReviewAnchor)
  | { kind: 'review-comment-edit'; id: string; body: string }
  | { kind: 'review-uncomment'; id: string }
  | { kind: 'review-submit'; summary: string }
  | { kind: 'review-accept' }
  | { kind: 'review-accept-file'; path: string }
  | { kind: 'review-run'; skill: string }
  | { kind: 'review-cancel' }
  | { kind: 'review-scope'; scope: 'session' | 'head' }
  | { kind: 'finding'; id: string; decision: 'keep' | 'dismiss'; note?: string }

export type InboxEntry =
  | { kind: 'phase'; to: Phase }
  | { kind: 'request'; approve: boolean; reason?: string }
  | { kind: 'plan'; version: number; verdict: PlanVerdict; comments: PlanComment[]; note: string }
  | ReviewEntry

export type InboxAnswer = { v: number; ok: boolean; message: string }

// An inbox entry's name: what the IDE writes, nothing that climbs or hides.
export const ENTRY_FILE = /^[A-Za-z0-9_-]{1,64}\.json$/

const VERDICTS: readonly string[] = ['approve', 'refine', 'reject']
const MAX_TEXT = 20_000
const MAX_COMMENTS = 200

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined

// An id or a name the IDE echoes back: one short word, nothing that climbs.
const word = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value) ? value : undefined

// A path as the review lists it: relative to the session root, never climbing.
const reviewPath = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' && value.length <= 1000 && !value.startsWith('/') &&
  !value.split('/').includes('..')
    ? value
    : undefined

const parseReviewEntry = (e: Record<string, unknown>): ReviewEntry | { error: string } | undefined => {
  switch (e.kind) {
    case 'review-comment': {
      const path = reviewPath(e.path)
      const body = text(e.body)?.trim()
      const excerpt = e.excerpt === undefined ? undefined : text(e.excerpt)
      if (path === undefined) return { error: 'a comment needs the path of a file under review' }
      if (e.side !== 'before' && e.side !== 'after') return { error: 'a comment side is before or after' }
      if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || (e.start as number) < 1 || (e.end as number) < (e.start as number))
        return { error: 'a comment needs 1-based start and end lines' }
      if (body === undefined || body === '') return { error: 'a comment needs a body' }
      return {
        kind: 'review-comment',
        path,
        side: e.side,
        start: e.start as number,
        end: e.end as number,
        body,
        ...(excerpt !== undefined && excerpt !== '' ? { excerpt } : {}),
      }
    }
    case 'review-comment-edit': {
      const id = word(e.id)
      const body = text(e.body)?.trim()
      return id === undefined || body === undefined || body === ''
        ? { error: 'an edit needs the comment id and its new body' }
        : { kind: 'review-comment-edit', id, body }
    }
    case 'review-uncomment': {
      const id = word(e.id)
      return id === undefined ? { error: 'needs the comment id' } : { kind: 'review-uncomment', id }
    }
    case 'review-submit': {
      const summary = e.summary === undefined ? '' : text(e.summary)
      return summary === undefined ? { error: 'the summary is not text, or too long' } : { kind: 'review-submit', summary: summary.trim() }
    }
    case 'review-accept':
      return { kind: 'review-accept' }
    case 'review-accept-file': {
      const path = reviewPath(e.path)
      return path === undefined ? { error: 'needs the path of a file under review' } : { kind: 'review-accept-file', path }
    }
    case 'review-run': {
      const skill = word(e.skill)
      return skill === undefined ? { error: 'needs the review skill to run' } : { kind: 'review-run', skill }
    }
    case 'review-cancel':
      return { kind: 'review-cancel' }
    case 'review-scope':
      if (e.scope !== 'session' && e.scope !== 'head') return { error: 'a review scope is session or head' }
      return { kind: 'review-scope', scope: e.scope }
    case 'finding': {
      const id = word(e.id)
      const note = e.note === undefined ? undefined : text(e.note)
      if (id === undefined) return { error: 'needs the finding id' }
      if (e.decision !== 'keep' && e.decision !== 'dismiss') return { error: 'a finding is kept or dismissed' }
      if (e.note !== undefined && note === undefined) return { error: 'the note is not text, or too long' }
      return { kind: 'finding', id, decision: e.decision, ...(note !== undefined ? { note } : {}) }
    }
    default:
      return undefined
  }
}

// Reads one inbox entry. Anything malformed is an error the IDE is told about,
// never a guess: these are operator decisions.
export const parseInboxEntry = (raw: string): InboxEntry | { error: string } => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'not JSON' }
  }
  const e = (parsed ?? {}) as Record<string, unknown>
  if (e.v !== BRIDGE_VERSION) return { error: `unsupported version ${String(e.v)} (the mod reads ${BRIDGE_VERSION})` }
  switch (e.kind) {
    case 'phase':
      return PHASES.includes(e.to as Phase) ? { kind: 'phase', to: e.to as Phase } : { error: `unknown phase ${String(e.to)}` }
    case 'request': {
      if (typeof e.approve !== 'boolean') return { error: 'a request answer needs approve: true or false' }
      const reason = text(e.reason)
      return { kind: 'request', approve: e.approve, ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}) }
    }
    case 'plan': {
      if (!Number.isInteger(e.version) || (e.version as number) < 1) return { error: 'a plan answer needs its plan version' }
      if (!VERDICTS.includes(String(e.verdict))) return { error: `unknown verdict ${String(e.verdict)}` }
      const note = e.note === undefined ? '' : text(e.note)
      if (note === undefined) return { error: 'the note is not text, or too long' }
      const list = e.comments === undefined ? [] : e.comments
      if (!Array.isArray(list) || list.length > MAX_COMMENTS) return { error: 'comments must be a list' }
      const comments: PlanComment[] = []
      for (const c of list) {
        const k = (c ?? {}) as Record<string, unknown>
        const body = text(k.body)
        if (!Number.isInteger(k.start) || !Number.isInteger(k.end) || body === undefined || body.trim() === '')
          return { error: 'each comment needs start, end and body' }
        comments.push({ start: k.start as number, end: k.end as number, body: body.trim() })
      }
      return { kind: 'plan', version: e.version as number, verdict: e.verdict as PlanVerdict, comments, note: note.trim() }
    }
    default:
      return parseReviewEntry(e) ?? { error: `unknown kind ${String(e.kind)}` }
  }
}

// The entries still to apply: well-named, in the order they were written
// (names sort by time: the IDE prefixes them with it), none already answered.
export const pendingEntries = (inbox: readonly string[], answered: readonly string[]): string[] =>
  inbox.filter(name => ENTRY_FILE.test(name) && !answered.includes(name)).sort()

export const answer = (ok: boolean, message: string): string =>
  `${JSON.stringify({ v: BRIDGE_VERSION, ok, message } satisfies InboxAnswer)}\n`
