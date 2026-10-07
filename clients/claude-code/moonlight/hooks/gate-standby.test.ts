import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// A daemon answers with its hooks installed: it governs, and the mod stands
// by. Plan would refuse this write; the daemon's hooks decide instead.
test('Standby: the daemon governs, the mod lets tools through and says so', async ($, on) => {
  const world = await startGate($, on, { daemon: '[{"event":"PreToolUse","matcher":"*","installed":true}]' })

  const wrote = await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' } as never)
  expect(textOf(wrote)).toBe('Write ran')
  // The mod's own files stay out of reach: a takeover reads them.
  const forged = await $.tool.call({ tool: 'Write', file_path: '/h/.moonlight/mod/projects/x/phase', content: 'auto' } as never)
  expect(textOf(forged)).toContain('belongs to the gate itself')
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(textOf(ran)).toBe('Bash ran')
  // The mod's own entries come out of the sandbox (a leftover would block the
  // session the daemon governs); the gate's own files stay denied.
  const released = JSON.parse(world.texts['/p/.claude/settings.local.json'] ?? '{}')
  expect(released.sandbox.filesystem.denyWrite).toEqual(['./.moonlight', './.claude/settings.json', './.claude/settings.local.json'])

  const ui = await $.ui.mount({
    plugin: 'moonlightcode',
    surface: 'terminal',
    component: 'PromptHint',
    props: { hint: '', isDraft: false, isWorking: false },
  } as never)
  expect(await ui.find({ type: 'Text', text: /gated by the MoonlightCode daemon/ })).toBeDefined()
  await ui.unmount()
})
