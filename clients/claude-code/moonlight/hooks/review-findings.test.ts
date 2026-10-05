import { expect, test } from 'claude-code/testing'

// An attached review skill: its prompt gets the contract, its answer's
// findings land in the panel for triage. In a file of its own: the mod keeps
// the first test's stubs across a file's tests.
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
  if (argv.includes('rev-parse')) return argv.includes('--show-toplevel') ? '/repo\n' : 'true\n'
  if (argv.includes('--numstat')) return '1\t1\tsrc/f.ts\n'
  if (argv.includes('status')) return ' M src/f.ts\n'
  if (argv.includes('diff')) return DIFF
  return ''
}

const ANSWER = [
  'Reviewed.',
  '```moonlight-findings',
  JSON.stringify({
    coverage: { notes: 'Two lanes ran.' },
    findings: [
      { key: 'M1', severity: 'medium', route: 'decision', file: 'src/f.ts', line: 2, summary: 'b changed meaning' },
      { key: 'L1', severity: 'low', route: 'patch', file: 'src/f.ts', line: 1, summary: 'Name a better' },
    ],
  }),
  '```',
].join('\n')

test('Review panel: an attached skill gets the contract; its findings are triaged', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    return { value: { exitCode: 0, stdout: gitAnswer(argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('skill.prompt', ($, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)

  // An attached skill (under its plugin) gets the scope and the block to end with.
  const prompted = (await $.skill.prompt({ skill: 'bmad-method:bmad-code-review', text: 'Review the code.' } as never)) as {
    text: string
  }
  expect(prompted.text).toContain('Review the code.')
  expect(prompted.text).toContain('```moonlight-findings')
  expect(prompted.text).toContain('src/f.ts')
  // Any other skill is left alone.
  const other = (await $.skill.prompt({ skill: 'commit', text: 'Commit.' } as never)) as { text: string }
  expect(other.text).toBe('Commit.')
  // One review at a time: another attached skill it calls (code-review is
  // attached by default), or the same one again, gets no second contract.
  const nested = (await $.skill.prompt({ skill: 'code-review', text: 'Nested.' } as never)) as { text: string }
  expect(nested.text).toBe('Nested.')
  const again = (await $.skill.prompt({ skill: 'bmad-method:bmad-code-review', text: 'Again.' } as never)) as {
    text: string
  }
  expect(again.text).toBe('Again.')

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /⏳ bmad-method:bmad-code-review running/ })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeUndefined()

  await $.turn.complete({ answer: ANSWER, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /2 kept · 0 dismissed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Two lanes ran\./ })).toBeDefined()
  expect(await ui.find({ key: 'goto:M1-1700000000000-0', text: 'src/f.ts:2' })).toBeDefined()
  expect(await ui.find({ key: 'submit', text: /Submit review \(2\)/ })).toBeDefined()
  // Kept findings are pending: no "All good" until they are sent or dismissed.
  expect(await ui.find({ key: 'accept' })).toBeUndefined()

  await ui.press({ key: 'dismiss:L1-1700000000000-1' })
  expect(await ui.find({ type: 'Text', text: /1 kept · 1 dismissed/ })).toBeDefined()

  await ui.press({ key: 'note:M1-1700000000000-0' })
  await ui.input({ key: 'note-input:M1-1700000000000-0', text: 'Keep 3, document why' })
  expect(await ui.find({ type: 'Text', text: /→ Keep 3, document why/ })).toBeDefined()

  // In the file's diff, the finding sits under its line.
  await ui.press({ key: 'file:src/f.ts' })
  expect(await ui.find({ type: 'Text', text: /b changed meaning/ })).toBeDefined()
  expect(await ui.find({ key: 'submit', text: /Submit \(1\)/ })).toBeDefined()

  await ui.press({ key: 'back' })
  await ui.press({ key: 'dismiss:M1-1700000000000-0' })
  expect(await ui.find({ key: 'accept' })).toBeDefined()

  // Run AI review: the two default skills, so it asks which one.
  await ui.press({ key: 'run' })
  expect(await ui.find({ type: 'Text', text: /Which review\?/ })).toBeDefined()
  expect(await ui.find({ key: 'run:bmad-code-review' })).toBeDefined()
  expect(await ui.find({ key: 'run:code-review' })).toBeDefined()
  await ui.press({ key: 'run-pick-cancel' })
  expect(await ui.find({ key: 'run' })).toBeDefined()
  await ui.press({ key: 'run' })
  await ui.press({ key: 'run:code-review' })
  // The kit has no engine behind prompt.submit: the run is refused and freed.
  for (let i = 0; i < 100 && (await ui.find({ type: 'Text', text: /Could not start code-review/ })) === undefined; i += 1)
    await new Promise(resolve => setTimeout(resolve, 10))
  expect(await ui.find({ type: 'Text', text: /Could not start code-review/ })).toBeDefined()
  expect(await ui.find({ key: 'run' })).toBeDefined()
  await ui.unmount()
})
