// Pure logic of the Plan panel: the plan's lines, comments on them, and the
// messages to the agent. No `$` here, so it is unit-testable.

export type PlanLineKind = 'heading' | 'bullet' | 'code' | 'fence' | 'blank' | 'text'

// One line of the plan as the panel draws it. `line`: 1-based, as comments and
// /ml-plan name it. `text`: the line as written. `level`: a heading's depth
// (`#` count), a bullet's or a text line's nesting (2 spaces each, from 0).
// `lang`: a code line's language, from its opening fence (```ts), and on the
// opening fence itself; `opens`: the fence opens a block (else it closes one).
export type PlanLine = { line: number; kind: PlanLineKind; text: string; level?: number; lang?: string; opens?: boolean }

export type PlanVerdict = 'approve' | 'refine' | 'reject'

// A comment on lines `start`-`end` of one plan version. `excerpt`: those lines
// as they were when the comment was written.
export type PlanComment = { id: string; start: number; end: number; body: string; excerpt?: string }

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+\S/
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/

const linesOf = (markdown: string): string[] => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  // A final newline is not a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

// A fence opens a code block and the next fence closes it: inside, every line
// is code, `# x` included.
export const parsePlan = (markdown: string): PlanLine[] => {
  let isInFence = false
  let lang = ''
  const withLang = (l: PlanLine): PlanLine => (lang !== '' ? { ...l, lang } : l)
  return linesOf(markdown).map((text, i): PlanLine => {
    const line = i + 1
    if (FENCE.test(text)) {
      isInFence = !isInFence
      if (!isInFence) return { line, kind: 'fence', text, opens: false }
      lang = text.trim().replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] ?? ''
      return withLang({ line, kind: 'fence', text, opens: true })
    }
    if (isInFence) return withLang({ line, kind: 'code', text })
    if (text.trim() === '') return { line, kind: 'blank', text }
    const heading = HEADING.exec(text)
    if (heading !== null) return { line, kind: 'heading', text, level: heading[1]!.length }
    const bullet = BULLET.exec(text)
    if (bullet !== null) return { line, kind: 'bullet', text, level: Math.floor(bullet[1]!.replace(/\t/g, '  ').length / 2) }
    const indent = /^\s*/.exec(text)![0].replace(/\t/g, '  ').length
    return indent >= 2 ? { line, kind: 'text', text, level: Math.floor(indent / 2) } : { line, kind: 'text', text }
  })
}

// A line as the engine's Markdown and Code elements take it: no control
// characters but tab, and within their 10000-character limit.
export const drawable = (text: string): string =>
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 10_000)

// A table row drawn alone is not a table: those lines stay plain text.
export const isTableRow = (text: string): boolean => /^\s*\|/.test(text)

// Lines `start` to `end` (1-based, inclusive) of the plan.
export const planExcerpt = (markdown: string, start: number, end: number): string =>
  linesOf(markdown)
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join('\n')

export const planSpan = ({ start, end }: { start: number; end: number }): string =>
  start === end ? `line ${start}` : `lines ${start}-${end}`

// What present_plan answers the agent at once: the verdict comes later.
export const presentedAnswer = (version: number): string =>
  `[moonlight] Plan v${version} sent to the operator for review in the Plan panel. ` +
  'Stop here and wait: do not start implementing, and do not call present_plan again until the operator answers. ' +
  'The verdict arrives as a [moonlight] prompt: APPROVED (implement it), REFINEMENT (revise and present the whole ' +
  'plan again) or REJECTED (stop). Tell the operator in one line that the plan is in the Plan panel, or that ' +
  '`/ml-plan` shows it where no panel draws (the VS Code extension).'

const commentItems = (comments: readonly PlanComment[]): string[] =>
  [...comments]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(c => {
      const quote =
        c.excerpt !== undefined && c.excerpt !== '' ? `\n${c.excerpt.split('\n').map(l => `  > ${l}`).join('\n')}` : ''
      return `- ${planSpan(c)}: ${c.body.replace(/\n/g, '\n  ')}${quote}`
    })

// The operator's verdict as one prompt to the agent. `phase`: the phase once
// the verdict applied (an approval moves Plan to Auto first).
export const formatVerdict = (
  verdict: PlanVerdict,
  version: number,
  comments: readonly PlanComment[],
  note: string,
  phase: string,
): string => {
  const said = note.trim()
  if (verdict === 'approve')
    return [
      `[moonlight] Plan v${version} APPROVED by the operator. The phase is now ${phase}: implement the plan.`,
      ...(said !== '' ? ['', `Operator note: ${said}`] : []),
      ...(comments.length > 0 ? ['', 'Comments to keep in mind while implementing:', ...commentItems(comments)] : []),
    ].join('\n')
  if (verdict === 'refine')
    return [
      `[moonlight] The operator asks for a REFINEMENT of plan v${version}. Address every comment, then call ` +
        'present_plan again with the whole revised plan (not only the changes). Do not start implementing.',
      ...(said !== '' ? ['', `Operator note: ${said}`] : []),
      ...(comments.length > 0 ? ['', 'Comments:', ...commentItems(comments)] : []),
    ].join('\n')
  return [
    `[moonlight] Plan v${version} REJECTED by the operator. Stop: do not implement it, and do not present ` +
      'another plan unless the operator asks for one.',
    ...(said !== '' ? ['', `Reason: ${said}`] : []),
  ].join('\n')
}

// A refinement must say what to change: a comment or a note.
export const canSend = (verdict: PlanVerdict, comments: readonly PlanComment[], note: string): boolean =>
  verdict !== 'refine' || comments.length > 0 || note.trim() !== ''
