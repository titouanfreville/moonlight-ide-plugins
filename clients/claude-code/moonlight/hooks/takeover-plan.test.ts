import { expect, test } from 'claude-code/testing'
import { startGate } from './gate-kit'

const HOOKED = '[{"event":"PreToolUse","matcher":"*","installed":true}]'

// The daemon governs, then stops answering: a blip is ridden out, three missed
// probes in a row hand the session to the mod, in Plan (the stored phase was
// not guarded while the daemon governed).
test('Takeover: three missed probes, then the mod governs in Plan', async ($, on) => {
  const world = await startGate($ as never, on as never, { daemon: HOOKED, bridge: true })
  world.phase = 'auto'
  const clock = world.clock!

  world.daemonUp = false
  await clock.advance(2000)
  world.daemonUp = true
  await clock.advance(2000)
  world.daemonUp = false
  await clock.advance(4000)
  // Two misses since the blip: still the daemon's.
  expect(world.phase).toBe('auto')
  await clock.advance(2000)
  expect(world.phase).toBe('plan')
  const wrote = await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' } as never)
  expect(JSON.stringify(wrote)).toContain('read-only')
})
