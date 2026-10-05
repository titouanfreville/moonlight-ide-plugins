import { expect, test } from 'claude-code/testing'

// The phase under the prompt: the current one as a badge, its rule, a dim
// step to the next phase, the engine's own hint kept after them.
test('Phase hint: the current phase stands out, the switch does not', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)

  const ui = await $.ui.mount({
    plugin: 'moonlightcode',
    surface: 'terminal',
    component: 'PromptHint',
    props: { hint: '? for shortcuts', isDraft: false, isWorking: false },
  } as never)
  const badge = await ui.find({ type: 'Text', text: /◐ PLAN/ })
  expect(badge).toBeDefined()
  expect((badge as unknown as { props: Record<string, unknown> }).props.backgroundColor).toBe('yellow')
  expect(await ui.find({ type: 'Text', text: /project read-only/ })).toBeDefined()

  const sw = (await ui.find({ key: 'phase-switch' })) as unknown as { props: Record<string, unknown>; text: string }
  expect(sw.text).toBe('· next: auto')
  expect(sw.props.dimColor).toBe(true)
  expect(sw.props.variant).toBeUndefined()

  expect(await ui.find({ type: 'Text', text: /\? for shortcuts/ })).toBeDefined()
  await ui.unmount()
})
