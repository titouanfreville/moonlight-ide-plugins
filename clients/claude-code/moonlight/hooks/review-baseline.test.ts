import { expect, test } from 'claude-code/testing'

// The Review panel against baselines: the session already holds copies of
// files the agent changed (an in-memory disk stands for ~/.moonlight). In a
// file of its own: the mod keeps the first test's stubs across a file's tests.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

const BASE = '/home/.moonlight/mod/sessions/s1/baseline'
const BLOB = `${BASE}/blobs/0000000000abcd`

const DIFF = [
  `diff --git a${BLOB} b/src/f.ts`,
  `--- a${BLOB}`,
  '+++ b/src/f.ts',
  '@@ -1 +1 @@',
  '-before the agent',
  '+after the agent',
  '',
].join('\n')

type Run = { argv?: readonly string[]; init?: { cwd?: string } }

test('Review panel: shows the session changes against baselines; Accept drops them', async ($, on) => {
  const disk = new Map<string, string>([
    [
      `${BASE}/index.json`,
      JSON.stringify({
        '/work/src/f.ts': { kind: 'copy', blob: BLOB },
        '/work/src/new.ts': { kind: 'absent' },
        '/work/logo.png': { kind: 'skipped', reason: 'binary' },
        '/elsewhere/x.ts': { kind: 'absent' },
      }),
    ],
    [BLOB, 'before the agent\n'],
    ['/work/src/f.ts', 'after the agent\n'],
    ['/work/src/new.ts', 'a\nb\nc\n'],
    ['/work/logo.png', '\u0000'],
  ])
  const exists = (path: string) => disk.has(path) || [...disk.keys()].some(k => k.startsWith(`${path}/`))
  const removed: string[] = []

  on('env.get', () => ({ value: '/home' }) as never)
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.root', () => ({ value: '/work' }) as never)
  on('session.cwd', () => ({ value: '/work' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.exists', ($, e) => ({ value: exists((e as { path: string }).path) }) as never)
  on('fs.read', ($, e) => ({ value: disk.get((e as { path: string }).path) ?? '' }) as never)
  on('fs.write', ($, e) => {
    const { path, text } = e as { path: string; text: string }
    disk.set(path, text)
    return { value: undefined } as never
  })
  on('fs.stat', ($, e) => {
    const path = (e as { path: string }).path
    return { value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: path } } as never
  })
  on('process.run', ($, e) => {
    const { argv = [] } = e as Run
    const answer = (stdout: string) =>
      ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (argv[0] === 'rm') {
      const dir = argv[argv.length - 1]!
      removed.push(dir)
      for (const key of [...disk.keys()]) if (key.startsWith(`${dir}/`)) disk.delete(key)
      return answer('')
    }
    if (argv.includes('--numstat')) return answer(argv.includes(BLOB) ? `1\t1\t${BLOB}\n` : '3\t0\t/dev/null\n')
    if (argv.includes('--no-index')) return answer(DIFF)
    return answer('')
  })

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /3 files, / })).toBeDefined()
  expect(await ui.find({ key: 'file:src/f.ts', text: /^M +src\/f\.ts/ })).toBeDefined()
  expect(await ui.find({ key: 'file:src/new.ts', text: /^A +src\/new\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no diff: binary/ })).toBeDefined()
  // Outside the session root: not this review's.
  expect(await ui.find({ key: 'file:/elsewhere/x.ts' })).toBeUndefined()

  await ui.press({ key: 'file:src/f.ts' })
  expect(await ui.find({ type: 'Code', text: /after the agent/ })).toBeDefined()
  await ui.press({ key: 'back' })

  await ui.press({ key: 'accept' })
  expect(removed).toEqual([BASE])
  expect(await ui.find({ type: 'Text', text: /The agent has changed nothing yet/ })).toBeDefined()
  await ui.unmount()
})
