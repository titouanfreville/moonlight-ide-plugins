import { expect, test } from 'claude-code/testing'
import { startGate } from './gate-kit'

// The IDE's side of the bridge, end to end: the mod publishes its state, the
// IDE writes a decision in the inbox, the next tick applies and answers it.
test('Bridge: state for the IDE panels, decisions from the IDE', async ($, on) => {
  const prompts: string[] = []
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text } as never
  })
  const world = await startGate($ as never, on as never, { bridge: true })
  const clock = world.clock!
  const dir = '/h/.moonlight/mod/sessions/s1'
  const state = () => JSON.parse(world.files[`${dir}/state.json`] ?? 'null')
  const send = async (name: string, entry: Record<string, unknown>) => {
    world.files[`${dir}/inbox/${name}.json`] = JSON.stringify({ v: 1, ...entry })
    await clock.advance(2000)
    return JSON.parse(world.files[`${dir}/outbox/${name}.json`] ?? 'null')
  }

  await clock.advance(2000)
  expect(state()).toMatchObject({ v: 1, sessionId: 's1', root: '/p', phase: 'plan', pending: null, plan: null })

  // A phase request: published, then approved from the IDE.
  await $.tool.call({ tool: 'mcp__moonlightcode__request_phase', phase: 'test', reason: 'run the suite' } as never)
  await clock.settle()
  expect(state().pending).toEqual({ to: 'test', reason: 'run the suite' })
  expect(await send('1-request', { kind: 'request', approve: true })).toMatchObject({ ok: true })
  expect(world.phase).toBe('test')
  expect(prompts.at(-1)).toContain('APPROVED')
  expect(state()).toMatchObject({ phase: 'test', pending: null })
  // Answered once: a second answer finds nothing waiting.
  expect(await send('2-request', { kind: 'request', approve: false })).toMatchObject({ ok: false })

  // The operator's own phase change.
  expect(await send('3-phase', { kind: 'phase', to: 'plan' })).toMatchObject({ ok: true })
  expect(world.phase).toBe('plan')

  // A plan: published, a stale version refused, then sent back with a comment.
  await $.tool.call({ tool: 'mcp__moonlightcode__present_plan', plan: '# Cache\n\n- Wrap the client', title: 'Cache' } as never)
  await clock.settle()
  expect(state().plan).toMatchObject({ version: 1, title: 'Cache', markdown: '# Cache\n\n- Wrap the client' })
  expect(await send('4-plan', { kind: 'plan', version: 2, verdict: 'approve' })).toMatchObject({ ok: false })
  expect(await send('5-plan', { kind: 'plan', version: 1, verdict: 'refine', comments: [{ start: 9, end: 9, body: 'x' }] })).toMatchObject({
    ok: false,
  })
  expect(
    await send('6-plan', { kind: 'plan', version: 1, verdict: 'refine', comments: [{ start: 3, end: 3, body: 'Which client?' }] }),
  ).toMatchObject({ ok: true })
  await clock.advance(2000)
  expect(state().plan.decided).toBe('refine')
  expect(prompts.at(-1)).toContain('Which client?')

  // Malformed entries are answered, never applied.
  expect(await send('7-bad', { kind: 'phase', to: 'ship' })).toMatchObject({ ok: false })
})
