import { expect, test } from 'claude-code/testing'
import {
  anchorLabel,
  anchorOf,
  BASELINE_MAX_BYTES,
  baselineOf,
  baselineStatus,
  contentHash,
  continueDraft,
  effectiveScope,
  parseBaselineIndex,
  parseNumstat,
  excerptOf,
  formatReview,
  inRepo,
  isSplit,
  lineHunk,
  anchorOfRows,
  excerptOfRows,
  nextRowSelection,
  parseChangedFiles,
  parseFileDiff,
  parseRepoDirs,
  toSplitRows,
  untrackedCount,
} from './review'

test('lineHunk renders one row as a one-line hunk the engine can draw', () => {
  expect(lineHunk({ kind: 'added', text: 'TWO', newLine: 2 })).toBe('@@ -1,0 +2,1 @@\n+TWO')
  expect(lineHunk({ kind: 'removed', text: 'two', oldLine: 2 })).toBe('@@ -2,1 +1,0 @@\n-two')
  expect(lineHunk({ kind: 'context', text: 'one', oldLine: 1, newLine: 1 })).toBe('@@ -1,1 +1,1 @@\n one')
  expect(lineHunk({ kind: 'added', text: 'a\u0007b\tc', newLine: 3 })).toBe('@@ -2,0 +3,1 @@\n+ab\tc')
})

test('toSplitRows pairs a changed block line by line, context on both sides', () => {
  const rows = parseFileDiff(
    ['@@ -1,4 +1,4 @@', ' keep', '-old a', '-old b', '+new a', ' end', ''].join('\n'),
  )
  const split = toSplitRows(rows)
  expect(split.map(r => (r.kind === 'hunk' ? 'hunk' : `${r.left?.text ?? '∅'}|${r.right?.text ?? '∅'}`))).toEqual([
    'hunk', 'keep|keep', 'old a|new a', 'old b|∅', 'end|end',
  ])
})

test('formatReview groups comments by file, in line order, with their lines', () => {
  const rows = parseFileDiff(['@@ -1,2 +1,2 @@', ' one', '-two', '+TWO', ''].join('\n'))
  const anchor = { path: 'src/f', side: 'after', start: 2, end: 2 } as const
  expect(excerptOf(rows, anchor)).toBe('+TWO')
  const text = formatReview(
    [
      { ...anchor, id: 'b', body: 'Why caps?', excerpt: '+TWO' },
      { path: 'src/f', side: 'after', start: 1, end: 1, id: 'a', body: 'Fine' },
      { path: 'README.md', side: 'before', start: 3, end: 4, id: 'c', body: 'Keep this' },
    ],
    'Mostly good',
  )
  expect(text).toContain('3 comment(s) on 2 file(s)')
  expect(text).toContain('Summary: Mostly good')
  expect(text.indexOf('src/f:1: Fine')).toBeLessThan(text.indexOf('src/f:2: Why caps?'))
  expect(text).toContain('  ```diff\n  +TWO\n  ```')
  expect(text).toContain('### README.md\n- README.md:3-4 (removed): Keep this')
  expect(formatReview([anchor].map(a => ({ ...a, id: 'x', body: 'y' })), ' ')).not.toContain('Summary:')
})

test('isSplit: auto picks split only when wide enough', () => {
  expect(isSplit('auto', 200)).toBe(true)
  expect(isSplit('auto', 100)).toBe(false)
  expect(isSplit('unified', 200)).toBe(false)
  expect(isSplit('split', 80)).toBe(true)
})

const DIFF = [
  'diff --git a/src/f b/src/f',
  'index 1111111..2222222 100644',
  '--- a/src/f',
  '+++ b/src/f',
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '',
].join('\n')

test('parseFileDiff numbers both sides and skips file headers', () => {
  const rows = parseFileDiff(DIFF)
  expect(rows.map(r => r.kind)).toEqual(['hunk', 'context', 'removed', 'added', 'context'])
  expect(rows[1]).toEqual({ kind: 'context', text: 'one', oldLine: 1, newLine: 1 })
  expect(rows[2]).toEqual({ kind: 'removed', text: 'two', oldLine: 2 })
  expect(rows[3]).toEqual({ kind: 'added', text: 'TWO', newLine: 2 })
  expect(rows[4]).toEqual({ kind: 'context', text: 'three', oldLine: 3, newLine: 3 })
})

test('parseChangedFiles joins status and numstat', () => {
  const files = parseChangedFiles('1\t1\tsrc/f\n4\t0\tREADME.md\n', ' M src/f\n?? new.txt\nM  README.md\n')
  expect(files).toEqual([
    { path: 'new.txt', status: '??', added: 0, removed: 0 },
    { path: 'README.md', status: 'M', added: 4, removed: 0 },
    { path: 'src/f', status: 'M', added: 1, removed: 1 },
  ])
})

test('parseRepoDirs keeps the repos under the root, root first; inRepo prefixes paths', () => {
  const found = ['/w/b/.git', '/w/.git', '/elsewhere/.git', '/w/a/x/.git', 'noise', ''].join('\n')
  const repos = parseRepoDirs(found, '/w')
  expect(repos).toEqual([
    { dir: '/w', prefix: '' },
    { dir: '/w/a/x', prefix: 'a/x' },
    { dir: '/w/b', prefix: 'b' },
  ])
  expect(parseRepoDirs('/wide/.git\n', '/w')).toEqual([])
  const files = inRepo([{ path: 'src/f', status: 'M', added: 1, removed: 0 }], repos[1]!)
  expect(files).toEqual([{ path: 'a/x/src/f', status: 'M', added: 1, removed: 0, repo: '/w/a/x', repoPath: 'src/f' }])
  expect(inRepo([{ path: 'f', status: 'M', added: 0, removed: 0 }], repos[0]!)[0]!.path).toBe('f')
})

test('continueDraft: a line ending with \\ goes on, the next one ends the comment', () => {
  expect(continueDraft([], 'first \\')).toEqual({ draft: ['first'] })
  expect(continueDraft(['first'], 'second\\  ')).toEqual({ draft: ['first', 'second'] })
  expect(continueDraft(['first', 'second'], 'third')).toEqual({ body: 'first\nsecond\nthird' })
  expect(continueDraft([], 'alone')).toEqual({ body: 'alone' })
  expect(formatReview([{ path: 'f', side: 'after', start: 1, end: 1, id: 'a', body: 'one\ntwo' }], '')).toContain(
    '- f:1: one\n  two',
  )
})

test('baselines: what is kept, how blobs are named, statuses, scope', () => {
  expect(baselineOf('code')).toEqual({ text: 'code' })
  expect(baselineOf('a\u0000b')).toEqual({ reason: 'binary' })
  expect(baselineOf('x'.repeat(BASELINE_MAX_BYTES + 1))).toEqual({ reason: 'over 1 MB' })
  expect(contentHash('same')).toBe(contentHash('same'))
  expect(contentHash('same')).not.toBe(contentHash('other'))
  expect(contentHash('')).toMatch(/^[0-9a-f]{14}$/)
  expect(baselineStatus({ kind: 'absent' }, true)).toBe('A')
  expect(baselineStatus({ kind: 'copy', blob: 'b' }, true)).toBe('M')
  expect(baselineStatus({ kind: 'copy', blob: 'b' }, false)).toBe('D')
  expect(parseNumstat('4\t2\tx\n')).toEqual({ added: 4, removed: 2 })
  expect(parseNumstat('')).toEqual({ added: 0, removed: 0 })
  expect(parseBaselineIndex('not json')).toEqual({})
  expect(parseBaselineIndex('[1]')).toEqual({})
  expect(effectiveScope('auto', true)).toBe('session')
  expect(effectiveScope('auto', false)).toBe('head')
  expect(effectiveScope('session', false)).toBe('session')
})

test('anchorOf prefers the current file line', () => {
  expect(anchorOf({ kind: 'context', text: '', oldLine: 3, newLine: 4 })).toEqual({ side: 'after', line: 4 })
  expect(anchorOf({ kind: 'removed', text: '', oldLine: 3 })).toEqual({ side: 'before', line: 3 })
  expect(anchorOf({ kind: 'hunk', text: '@@' })).toBeUndefined()
})

test('nextRowSelection: click, second click extends, click again clears', () => {
  const one = nextRowSelection(null, 5)
  expect(one).toEqual({ from: 5, to: 5 })
  const range = nextRowSelection(one, 2)
  expect(range).toEqual({ from: 2, to: 5 })
  expect(nextRowSelection(range, 9)).toEqual({ from: 9, to: 9 })
  expect(nextRowSelection(one, 5)).toBeNull()
})

test('anchorOfRows: a range across a changed block covers both sides', () => {
  // hunk, keep (1|1), -old a (2), -old b (3), +new a (2), end (4|3)
  const rows = parseFileDiff(['@@ -1,4 +1,3 @@', ' keep', '-old a', '-old b', '+new a', ' end', ''].join('\n'))
  const block = anchorOfRows(rows, 'src/f', { from: 2, to: 4 })
  expect(block).toEqual({ path: 'src/f', side: 'after', start: 2, end: 2, removed: { start: 2, end: 3 } })
  expect(anchorLabel(block!)).toBe('src/f:2 (+ removed 2-3)')
  expect(excerptOfRows(rows, { from: 2, to: 4 })).toBe('-old a\n-old b\n+new a')
  expect(anchorOfRows(rows, 'src/f', { from: 1, to: 5 })).toEqual({
    path: 'src/f', side: 'after', start: 1, end: 3, removed: { start: 2, end: 3 },
  })
  expect(anchorOfRows(rows, 'src/f', { from: 2, to: 3 })).toEqual({ path: 'src/f', side: 'before', start: 2, end: 3 })
  expect(anchorOfRows(rows, 'src/f', { from: 0, to: 0 })).toBeNull()
})

test('untrackedCount: lines of a text file, a binary one marked', () => {
  expect(untrackedCount('7\t0\tnew.md\n')).toEqual({ added: 7, removed: 0 })
  expect(untrackedCount('-\t-\tlogo.png\n')).toEqual({ skipped: 'binary' })
})
