import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// A writable phase runs shell commands outside the sandbox (gh, nx and the like
// need the network and folders outside the project): no sandbox check, the
// sandbox left off in the settings, dangerouslyDisableSandbox kept. Only a write
// to the gate's own files is refused.
test('Gate: in Auto, Bash runs outside the sandbox but cannot write the gate files', async ($, on) => {
  const world = await startGate($ as never, on as never)
  world.phase = 'auto'
  world.settings = {}
  const bash = async (command: string, extra: Record<string, unknown> = {}) =>
    textOf(await $.tool.call({ tool: 'Bash', command, ...extra } as never))

  expect(await bash('gh pr list', { dangerouslyDisableSandbox: true })).toBe('Bash ran')
  expect(world.reached.at(-1)?.input.dangerouslyDisableSandbox).toBe(true)
  const settings = Object.entries(world.texts).find(([path]) => path.endsWith('/.claude/settings.local.json'))?.[1]
  expect(JSON.parse(settings!).sandbox).toMatchObject({ enabled: false, allowUnsandboxedCommands: true })

  expect(await bash('echo plan > ~/.moonlight/mod/projects/p/phase')).toContain("write the gate's own files")
  expect(await bash('cat ~/.moonlight/mod/projects/p/phase')).toBe('Bash ran')
})
