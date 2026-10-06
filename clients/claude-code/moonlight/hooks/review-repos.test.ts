import { expect, test } from 'claude-code/testing'

// A session opened on a folder of projects, itself no repository: the panel
// finds the repos below and diffs each file inside its own repo. In a file of
// its own: the mod keeps the first test's stubs across a file's tests.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

const DIFF = [
  'diff --git a/src/f.ts b/src/f.ts',
  '--- a/src/f.ts',
  '+++ b/src/f.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new in api',
  '',
].join('\n')

type Run = { argv?: readonly string[]; init?: { cwd?: string } }

test('Review panel: a folder of repos lists each repo, diffs inside it', async ($, on) => {
  on('session.root', () => ({ value: '/work' }) as never)
  on('session.cwd', () => ({ value: '/work' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }) as never)
  const diffedIn: string[] = []
  on('process.run', ($, e) => {
    const { argv = [], init } = e as Run
    const cwd = init?.cwd ?? ''
    const answer = (stdout: string, exitCode = 0) =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (argv[0] === 'find') return answer('/work/api/.git\n/work/web/.git\n')
    if (argv.includes('rev-parse')) return cwd === '/work' ? answer('', 128) : answer('true\n')
    if (argv.includes('--numstat')) return answer(cwd === '/work/api' ? '1\t1\tsrc/f.ts\n' : '2\t0\tREADME.md\n')
    if (argv.includes('status')) return answer(cwd === '/work/api' ? ' M src/f.ts\n' : ' M README.md\n')
    if (argv.includes('diff')) {
      diffedIn.push(`${cwd}:${argv[argv.length - 1]}`)
      return answer(DIFF)
    }
    return answer('')
  })

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /2 files in 2 repos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ api/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ web/ })).toBeDefined()

  await ui.press({ key: 'file:api/src/f.ts' })
  expect(diffedIn).toContain('/work/api:src/f.ts')
  expect(await ui.find({ type: 'Code', text: /new in api/ })).toBeDefined()

  // The comment carries the path from the session root, repo folder first.
  await ui.press({ key: 'line:2' })
  await ui.input({ key: 'comment', text: 'Check' })
  expect(await ui.find({ type: 'Text', text: /💬 api\/src\/f\.ts:1/ })).toBeDefined()
  await ui.unmount()
})
