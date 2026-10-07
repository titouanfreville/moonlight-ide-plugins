import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// A daemon that answers but has no hooks installed governs nothing: the mod
// keeps the gate.
test('A daemon without its hooks leaves the gate to the mod', async ($, on) => {
  const world = await startGate($, on, { daemon: '[{"event":"PreToolUse","matcher":"*","installed":false}]' })
  const wrote = await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' } as never)
  expect(textOf(wrote)).toContain('read-only')
  expect(world.reached.length).toBe(0)
})
