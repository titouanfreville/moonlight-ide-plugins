import { expect, test } from 'claude-code/testing'

// Mounts the Review panel the way a surface asks for it and plays the flow a
// person would: refresh the files, open one, click a line number, type a
// comment. The test answers the engine calls the panel makes (session root,
// file stats, git), so it depends on no real repository.
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

test('Review panel: open a file, click a line, comment it', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    return { value: { exitCode: 0, stdout: gitAnswer(argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  // Comments persist across the loop, as across reopenings of the panel.
  let commented = 0
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'moonlightcode', surface, ...PANE } as never)
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /1 file\(s\)/ })).toBeDefined()

    await ui.press({ key: 'file:src/f.ts' })
    // Lines are drawn by the engine's diff highlighter, one Code per line.
    expect(await ui.find({ type: 'Code', text: /const b = 3/ })).toBeDefined()

    // Rows: hunk, context (line 1), removed (old 2), added (new 2).
    await ui.press({ key: 'line:3' })
    expect(await ui.find({ key: 'comment' })).toBeDefined()

    await ui.input({ key: 'comment', text: 'Why 3?' })
    expect(await ui.find({ type: 'Text', text: /src\/f\.ts:2: Why 3\?/ })).toBeDefined()

    // A changed block: the removed line, then the added one under it.
    await ui.press({ key: 'line:2' })
    await ui.press({ key: 'line:3' })
    expect(await ui.find({ type: 'Text', text: /Selected src\/f\.ts:2 \(\+ removed 2\)/ })).toBeDefined()
    await ui.input({ key: 'comment', text: 'Block' })
    expect(await ui.find({ type: 'Text', text: /src\/f\.ts:2 \(\+ removed 2\): Block/ })).toBeDefined()

    commented += 2
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: new RegExp(`\\b${commented} comments?\\b`) })).toBeDefined()
    await ui.unmount()
  }
})

// A long diff: one Button per line must still draw and answer a click.
const LONG = [
  'diff --git a/big.ts b/big.ts',
  '--- a/big.ts',
  '+++ b/big.ts',
  '@@ -0,0 +1,1500 @@',
  ...Array.from({ length: 1500 }, (_, i) => `+export const v${i} = ${i}`),
  '',
].join('\n')

test('Review panel: a 1500-line diff draws and a late line is clickable', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    const stdout = argv.includes('rev-parse')
      ? 'true\n'
      : argv.includes('--numstat') ? '1500\t0\tbig.ts\n' : argv.includes('status') ? 'A  big.ts\n' : LONG
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  await ui.press({ key: 'refresh' })
  const startedAt = Date.now()
  await ui.press({ key: 'file:big.ts' })
  const drawn = Date.now() - startedAt
  await ui.press({ key: 'line:1400' })
  const clicked = Date.now() - startedAt - drawn
  console.log(`LONG DIFF: open ${drawn} ms, click ${clicked} ms`)
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  await ui.unmount()
})

test('Review panel: side by side when wide, comment the new side, toggle back', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_001 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  on('process.run', ($, e) => {
    const argv = ((e as { argv?: readonly string[] }).argv ?? []) as readonly string[]
    return { value: { exitCode: 0, stdout: gitAnswer(argv), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })

  const wide = { ...PANE, props: { ...PANE.props, bodyColumns: 180 } }
  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...wide } as never)
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'file:src/f.ts' })

  // Split rows: hunk, `a = 1` on both sides, `b = 2` | `b = 3`.
  expect(await ui.find({ key: 'left:1' })).toBeDefined()
  await ui.press({ key: 'right:2' })
  await ui.input({ key: 'comment', text: 'Right side' })
  expect(await ui.find({ type: 'Text', text: /src\/f\.ts:2: Right side/ })).toBeDefined()

  await ui.press({ key: 'layout' })
  expect(await ui.find({ key: 'left:1' })).toBeUndefined()
  expect(await ui.find({ key: 'line:3' })).toBeDefined()
  await ui.unmount()
})
