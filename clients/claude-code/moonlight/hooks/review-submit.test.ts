import { expect, test } from 'claude-code/testing'

// Writing a comment of two lines, then submitting the review. The test kit has
// no engine behind `prompt.submit`, so the send is refused here: the message
// itself is checked by `formatReview`'s unit test, the agent's turn in a real
// session. Here: the wiring, and that a refused send gives the comments back.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

const DIFF = [
  'diff --git a/src/f.ts b/src/f.ts',
  '--- a/src/f.ts',
  '+++ b/src/f.ts',
  '@@ -1,2 +1,2 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '',
].join('\n')

const gitAnswer = (argv: readonly string[]): string => {
  if (argv.includes('rev-parse')) return 'true\n'
  if (argv.includes('--numstat')) return '1\t1\tsrc/f.ts\n'
  if (argv.includes('status')) return ' M src/f.ts\n'
  if (argv.includes('diff')) return DIFF
  return ''
}

test('Review panel: submit sends every comment to the agent; a refused send keeps them', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    return { value: { exitCode: 0, stdout: gitAnswer(argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'submit' })).toBeUndefined()

  await ui.press({ key: 'file:src/f.ts' })
  await ui.press({ key: 'line:3' })
  // Two lines: the first ends with `\`.
  await ui.input({ key: 'comment', text: 'Why 3? \\' })
  expect(await ui.find({ type: 'Text', text: /│ Why 3\?/ })).toBeDefined()
  await ui.input({ key: 'comment', text: 'It was 2 before.' })
  expect(await ui.find({ type: 'Text', text: /src\/f\.ts:2: Why 3\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /It was 2 before\./ })).toBeDefined()
  expect(await ui.find({ key: 'submit', text: /Submit \(1\)/ })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.input({ key: 'summary', text: 'One nit' })

  // Refused here: the comment comes back, to send again.
  for (let i = 0; i < 100 && (await ui.find({ key: 'submit' })) === undefined; i += 1)
    await new Promise(resolve => setTimeout(resolve, 10))
  expect(await ui.find({ key: 'submit', text: /Submit review \(1\)/ })).toBeDefined()
  await ui.unmount()
})
