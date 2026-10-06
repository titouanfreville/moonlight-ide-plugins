import { expect, test } from 'claude-code/testing'

// Since HEAD, an untracked file has no `git diff --numstat HEAD` line: the
// panel counts its lines as a diff from nothing instead of showing +0 -0.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

type Run = { argv?: readonly string[] }

test('Review panel: since HEAD, an untracked file shows its line count', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const { argv = [] } = e as Run
    const answer = (stdout: string, exitCode = 0) =>
      ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (argv.includes('rev-parse')) return answer('true\n')
    // `--no-index` exits 1 when the files differ, as they do here.
    if (argv.includes('--no-index') && argv.includes('--numstat')) return answer('7\t0\tnew.md\n', 1)
    if (argv.includes('--numstat')) return answer('1\t1\tsrc/f.ts\n')
    if (argv.includes('status')) return answer(' M src/f.ts\n?? new.md\n')
    return answer('')
  })

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /2 files, / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+1/ })).toBeDefined()
  await ui.unmount()
})
