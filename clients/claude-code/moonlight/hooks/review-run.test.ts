import { expect, test } from 'claude-code/testing'

// An AI review run ends with its own turn, block or not: the panel never stays
// on "running". In a file of its own: the mod keeps the first test's stubs
// across a file's tests.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

const answer = (stdout: string) =>
  ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

const turnEnd = (turnId: string, isAborted = false) =>
  ({ answer: 'Reviewed, all fine.', reason: isAborted ? 'aborted' : 'answer', durationMs: 1, isAborted, turnId }) as never

test('Review panel: a run ends with its own turn, even without a findings block', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    return answer(argv.includes('rev-parse') ? 'true\n' : '')
  })
  on('skill.prompt', ($, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.start', ($, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  // The operator starts an attached skill by hand, in turn t9.
  await $.turn.start({ text: 'review my work', turnId: 't9' } as never)
  await $.skill.prompt({ skill: 'bmad-code-review', text: 'Review.' } as never)

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /bmad-code-review is reviewing/ })).toBeDefined()

  // A subagent's turn ends: not the run's.
  await $.turn.complete({ ...(turnEnd('t-sub') as object), agentId: 'a1' } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /bmad-code-review is reviewing/ })).toBeDefined()

  // The run's turn ends with no block: the run ends, and says why.
  await $.turn.complete(turnEnd('t9'))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /⏳/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /bmad-code-review ended without a moonlight-findings block/ })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeDefined()

  // An interrupted run says so.
  await $.turn.start({ text: 'again', turnId: 't10' } as never)
  await $.skill.prompt({ skill: 'bmad-code-review', text: 'Review.' } as never)
  await $.turn.complete(turnEnd('t10', true))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /bmad-code-review was interrupted/ })).toBeDefined()
  await ui.unmount()
})
