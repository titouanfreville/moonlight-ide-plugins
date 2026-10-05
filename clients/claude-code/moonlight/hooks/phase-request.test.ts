import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// The agent asks; the band shows the request; only the operator's composer
// changes the phase.
test('request_phase reaches the band; /phase refuses anything but the composer', async ($, on) => {
  await startGate($ as never, on as never)

  const unknown = textOf(await $.tool.call({ tool: 'mcp__moonlightcode__request_phase', phase: 'bogus' } as never))
  expect(unknown).toContain('Unknown phase')

  const asked = textOf(
    await $.tool.call({ tool: 'mcp__moonlightcode__request_phase', phase: 'next', reason: 'ready' } as never),
  )
  expect(asked).toContain('plan → auto')
  const band = await $.ui.mount({
    plugin: 'moonlightcode',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false },
  } as never)
  expect(await band.find({ key: 'band-approve' })).toBeDefined()
  await band.unmount()

  for (const kind of ['sdk', 'peer', 'bridge'])
    expect(
      ((await $.command.run({ command: 'phase', args: 'auto', origin: { kind } } as never)) as { text: string }).text,
    ).toContain('Refused')
})
