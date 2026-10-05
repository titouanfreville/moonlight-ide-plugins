import { expect, test } from 'claude-code/testing'

// The phase pane (/phase): the current phase as its badge and rule, then the
// five phases in order, each one but the current a dim button to jump to.
test('Phase pane: the five phases, the current one not clickable, none highlighted', async ($, on) => {
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)

  const ui = await $.ui.mount({
    plugin: 'moonlightcode',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'moonlight-phase',
    props: { title: 'Moonlight', isFocused: true, bodyColumns: 80, placement: 'dock' },
  } as never)
  const badge = (await ui.find({ type: 'Text', text: /◐ PLAN/ })) as unknown as { props: Record<string, unknown> }
  expect(badge.props.backgroundColor).toBe('yellow')
  expect(await ui.find({ type: 'Text', text: /project read-only/ })).toBeDefined()

  // No project known in the kit: the phase reads as Plan.
  expect(await ui.find({ key: 'pane-phase:plan' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '[plan]' })).toBeDefined()
  for (const phase of ['auto', 'test', 'review', 'commit']) {
    const button = (await ui.find({ key: `pane-phase:${phase}` })) as unknown as { props: Record<string, unknown>; text: string }
    expect(button.text).toBe(phase)
    expect(button.props.dimColor).toBe(true)
    expect(button.props.variant).toBeUndefined()
  }
  await ui.unmount()
})
