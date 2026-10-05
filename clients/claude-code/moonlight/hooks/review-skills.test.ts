import { expect, test } from 'claude-code/testing'

// A team's review skills through the `reviewSkills` option, as managed
// settings would set it; only the installed ones are offered. In a file of
// its own: the mod keeps the first test's stubs and options across a file.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-review',
  props: { title: 'Review', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

test(
  'Review panel: the reviewSkills option sets the choices; uninstalled ones are not offered',
  { options: { reviewSkills: 'deep-review, bmad-code-review, code-review' } },
  async ($, on) => {
    on('session.root', () => ({ value: '/repo' }) as never)
    on('session.cwd', () => ({ value: '/repo' }) as never)
    on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
    on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
    on('process.run', () =>
      ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never,
    )
    // deep-review and code-review are installed; bmad-code-review is not.
    on('command.list', () =>
      ({
        value: [
          { name: 'commit', description: '', source: 'builtin' },
          { name: 'partoo-tech-shared:deep-review', description: '', source: 'plugin' },
          { name: 'code-review:code-review', description: '', source: 'plugin' },
        ],
      }) as never,
    )

    const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'run' })
    expect(await ui.find({ key: 'run:deep-review' })).toBeDefined()
    expect(await ui.find({ key: 'run:code-review' })).toBeDefined()
    expect(await ui.find({ key: 'run:bmad-code-review' })).toBeUndefined()
    await ui.unmount()
  },
)
