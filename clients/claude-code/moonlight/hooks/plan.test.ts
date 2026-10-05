import { expect, test } from 'claude-code/testing'
import { canSend, formatVerdict, parsePlan, planExcerpt, planSpan, presentedAnswer, type PlanComment } from './plan'

const PLAN = ['# Plan', '', '- step one', '  - detail', '```ts', '# not a heading', '```', 'Done.', ''].join('\n')

test('parsePlan: kinds, levels, 1-based lines, fences toggle', () => {
  expect(parsePlan(PLAN)).toEqual([
    { line: 1, kind: 'heading', text: '# Plan', level: 1 },
    { line: 2, kind: 'blank', text: '' },
    { line: 3, kind: 'bullet', text: '- step one', level: 0 },
    { line: 4, kind: 'bullet', text: '  - detail', level: 1 },
    { line: 5, kind: 'fence', text: '```ts' },
    { line: 6, kind: 'code', text: '# not a heading' },
    { line: 7, kind: 'fence', text: '```' },
    { line: 8, kind: 'text', text: 'Done.' },
  ])
  expect(parsePlan('1. first\r\n## Two').map(l => l.kind)).toEqual(['bullet', 'heading'])
  expect(parsePlan('#nospace').map(l => l.kind)).toEqual(['text'])
})

test('planExcerpt and planSpan', () => {
  expect(planExcerpt(PLAN, 3, 4)).toBe('- step one\n  - detail')
  expect(planExcerpt(PLAN, 1, 1)).toBe('# Plan')
  expect(planSpan({ start: 3, end: 3 })).toBe('line 3')
  expect(planSpan({ start: 3, end: 4 })).toBe('lines 3-4')
})

test('presentedAnswer tells the agent to stop and wait', () => {
  const answer = presentedAnswer(2)
  expect(answer).toContain('Plan v2 sent to the operator')
  expect(answer).toContain('Stop here and wait: do not start implementing')
  expect(answer).toContain('[moonlight] prompt')
})

const COMMENTS: PlanComment[] = [
  { id: 'b', start: 8, end: 8, body: 'Say what is done' },
  { id: 'a', start: 3, end: 4, body: 'Split this\nin two', excerpt: '- step one\n  - detail' },
]

test('formatVerdict: approve names the phase, the note and the comments', () => {
  expect(formatVerdict('approve', 1, [], '', 'auto')).toBe(
    '[moonlight] Plan v1 APPROVED by the operator. The phase is now auto: implement the plan.',
  )
  const text = formatVerdict('approve', 1, COMMENTS, ' Go ', 'auto')
  expect(text).toContain('Operator note: Go')
  expect(text).toContain('Comments to keep in mind')
})

test('formatVerdict: refine lists comments in line order with the quoted lines', () => {
  const text = formatVerdict('refine', 3, COMMENTS, 'Tighter', 'plan')
  expect(text).toContain('asks for a REFINEMENT of plan v3')
  expect(text).toContain('call present_plan again with the whole revised plan')
  expect(text).toContain('Operator note: Tighter')
  expect(text).toContain('- lines 3-4: Split this\n  in two\n  > - step one\n  >   - detail\n- line 8: Say what is done')
})

test('formatVerdict: reject says stop, with the reason', () => {
  const text = formatVerdict('reject', 1, COMMENTS, 'Wrong approach', 'plan')
  expect(text).toContain('Plan v1 REJECTED')
  expect(text).toContain('Stop')
  expect(text).toContain('Reason: Wrong approach')
  expect(text).not.toContain('Split this')
})

test('canSend: a refinement needs a comment or a note', () => {
  expect(canSend('refine', [], '  ')).toBe(false)
  expect(canSend('refine', [], 'more detail')).toBe(true)
  expect(canSend('refine', COMMENTS, '')).toBe(true)
  expect(canSend('approve', [], '')).toBe(true)
  expect(canSend('reject', [], '')).toBe(true)
})
