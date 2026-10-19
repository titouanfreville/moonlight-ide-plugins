import { expect, test } from 'claude-code/testing'
import { answer, parseInboxEntry, pendingEntries, sessionTitleFrom, titleFromTranscript } from './bridge'

test('parseInboxEntry: the three decisions', () => {
  expect(parseInboxEntry('{"v":1,"kind":"phase","to":"auto"}')).toEqual({ kind: 'phase', to: 'auto' })
  expect(parseInboxEntry('{"v":1,"kind":"request","approve":false,"reason":"not now"}')).toEqual({
    kind: 'request',
    approve: false,
    reason: 'not now',
  })
  expect(
    parseInboxEntry('{"v":1,"kind":"plan","version":2,"verdict":"refine","comments":[{"start":3,"end":4,"body":" tighter "}],"note":"ok"}'),
  ).toEqual({ kind: 'plan', version: 2, verdict: 'refine', comments: [{ start: 3, end: 4, body: 'tighter' }], note: 'ok' })
})

test('parseInboxEntry: malformed entries are errors, never guesses', () => {
  for (const raw of [
    'nope',
    '{"kind":"phase","to":"auto"}',
    '{"v":2,"kind":"phase","to":"auto"}',
    '{"v":1,"kind":"phase","to":"ship"}',
    '{"v":1,"kind":"request","approve":"yes"}',
    '{"v":1,"kind":"plan","verdict":"approve"}',
    '{"v":1,"kind":"plan","version":1,"verdict":"maybe"}',
    '{"v":1,"kind":"plan","version":1,"verdict":"refine","comments":[{"start":1,"body":"x"}]}',
    '{"v":1,"kind":"delete"}',
  ])
    expect('error' in (parseInboxEntry(raw) as object)).toBe(true)
})

test('pendingEntries: well-named, unanswered, oldest first', () => {
  expect(pendingEntries(['2-b.json', '1-a.json', '../x.json', 'c.txt', '3-c.json'], ['3-c.json'])).toEqual(['1-a.json', '2-b.json'])
})

test('answer: one versioned line', () => {
  expect(JSON.parse(answer(true, 'done'))).toEqual({ v: 1, ok: true, message: 'done' })
})

test('parseInboxEntry: review decisions', () => {
  expect(parseInboxEntry('{"v":1,"kind":"review-comment","path":"src/a.ts","side":"after","start":3,"end":4,"body":" tighter ","excerpt":"x"}')).toEqual({
    kind: 'review-comment',
    path: 'src/a.ts',
    side: 'after',
    start: 3,
    end: 4,
    body: 'tighter',
    excerpt: 'x',
  })
  expect(parseInboxEntry('{"v":1,"kind":"review-submit"}')).toEqual({ kind: 'review-submit', summary: '' })
  expect(parseInboxEntry('{"v":1,"kind":"review-accept-file","path":"src/a.ts"}')).toEqual({ kind: 'review-accept-file', path: 'src/a.ts' })
  expect(parseInboxEntry('{"v":1,"kind":"review-run","skill":"bmad-method:bmad-code-review"}')).toEqual({
    kind: 'review-run',
    skill: 'bmad-method:bmad-code-review',
  })
  expect(parseInboxEntry('{"v":1,"kind":"review-scope","scope":"head"}')).toEqual({ kind: 'review-scope', scope: 'head' })
  expect(parseInboxEntry('{"v":1,"kind":"finding","id":"H1-5-0","decision":"keep","note":"fix it"}')).toEqual({
    kind: 'finding',
    id: 'H1-5-0',
    decision: 'keep',
    note: 'fix it',
  })
})

test('parseInboxEntry: review decisions that would climb or guess are refused', () => {
  for (const raw of [
    '{"v":1,"kind":"review-comment","path":"/etc/passwd","side":"after","start":1,"end":1,"body":"x"}',
    '{"v":1,"kind":"review-comment","path":"../x","side":"after","start":1,"end":1,"body":"x"}',
    '{"v":1,"kind":"review-comment","path":"a","side":"left","start":1,"end":1,"body":"x"}',
    '{"v":1,"kind":"review-comment","path":"a","side":"after","start":3,"end":2,"body":"x"}',
    '{"v":1,"kind":"review-comment","path":"a","side":"after","start":1,"end":1,"body":"  "}',
    '{"v":1,"kind":"review-accept-file","path":"a/../../b"}',
    '{"v":1,"kind":"review-run","skill":"x; rm -rf"}',
    '{"v":1,"kind":"finding","id":"H1","decision":"maybe"}',
    '{"v":1,"kind":"review-scope","scope":"all"}',
  ])
    expect('error' in (parseInboxEntry(raw) as object)).toBe(true)
})

test('sessionTitleFrom: Claude Code\'s title first, else the first prompt line', () => {
  expect(sessionTitleFrom('  Fix the queue  ', undefined, null)).toBe('Fix the queue')
  expect(sessionTitleFrom('Renamed', 'anything', 'Old name')).toBe('Renamed')
  expect(sessionTitleFrom(undefined, '\n  Add Jira to plan\nmore', null)).toBe('Add Jira to plan')
  expect(sessionTitleFrom(undefined, 'a later prompt', 'Kept')).toBe('Kept')
  expect(sessionTitleFrom(undefined, '/phase auto', null)).toBe(null)
  expect(sessionTitleFrom(undefined, '[moonlight] Plan v1 APPROVED', null)).toBe(null)
  expect(sessionTitleFrom(undefined, 'x'.repeat(100), null)).toBe(`${'x'.repeat(79)}…`)
})

test('titleFromTranscript: the operator\'s rename wins, the latest of each counts', () => {
  const ai = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t })
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t })
  expect(titleFromTranscript('')).toBe(undefined)
  expect(titleFromTranscript([ai('First'), ai('Plan panel for the mod')].join('\n'))).toBe('Plan panel for the mod')
  expect(titleFromTranscript([custom('Bedrock AWS'), ai('JIRA MCP availability'), '{"cut'].join('\n'))).toBe('Bedrock AWS')
})
