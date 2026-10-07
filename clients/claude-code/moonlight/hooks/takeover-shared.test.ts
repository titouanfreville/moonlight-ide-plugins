import { expect, test } from 'claude-code/testing'
import { startGate } from './gate-kit'

const HOOKED = '[{"event":"PreToolUse","matcher":"*","installed":true}]'

// Another live session governs this project with the mod: its sandbox kept the
// project's phase guarded, so a takeover keeps that phase instead of resetting
// it under the other session's feet.
test('Takeover: a phase kept by another live mod session stands', async ($, on) => {
  const world = await startGate($ as never, on as never, { daemon: HOOKED, bridge: true })
  world.phase = 'auto'
  const clock = world.clock!
  const other = '/h/.moonlight/mod/sessions/s2'
  world.files[`${other}/state.json`] = JSON.stringify({ v: 1, sessionId: 's2', root: '/p', phase: 'auto' })
  world.files[`${other}/heartbeat`] = '1'

  world.daemonUp = false
  for (let i = 0; i < 3; i++) {
    world.mtimes[`${other}/heartbeat`] = clock.now()
    await clock.advance(2000)
  }
  expect(world.phase).toBe('auto')
  const wrote = await $.tool.call({ tool: 'Write', file_path: '/p/src/a.ts', content: 'x' } as never)
  expect(JSON.stringify(wrote)).toContain('Write ran')
})
