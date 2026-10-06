import { expect, test } from 'claude-code/testing'

// The agent presents a plan through the tool, then the operator comments a
// range and asks for a refinement. The test kit has no engine behind
// `prompt.submit`, so the send is refused here: the message itself is checked
// by `formatVerdict`'s unit test, the agent's turn in a real session. Here: the
// wiring, and that a refused send keeps the comments and the version open.
const PANE = {
  component: 'Pane',
  requestId: 'moonlight-plan',
  props: { title: 'Plan', isFocused: true, bodyColumns: 80, placement: 'dock' },
} as const

const PLAN = ['# Add a cache', '', '- Wrap the client', '- Expire after 5 min', '```ts', '# code, not heading', '```'].join('\n')

test('Plan panel: present_plan opens v1, comment a range, refine, a refused send keeps it', async ($, on) => {
  const written: string[] = []
  on('session.root', () => ({ value: '/repo' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('session.id', () => ({ value: 'test-session' }) as never)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('clock.now', () => ({ value: 1_700_000_000_000 }) as never)
  on('fs.stat', () => ({ value: { kind: 'directory', size: 0, mtimeMs: 0, isLink: false, realPath: '/repo' } }) as never)
  // The plan's copy on disk: recorded, never written to a real home.
  on('fs.write', ($, e) => {
    written.push((e as { path?: string }).path ?? '')
    return { value: undefined } as never
  })

  const called = await $.tool.call({ tool: 'mcp__moonlightcode__present_plan', plan: PLAN, title: 'Cache' } as never)
  expect((called as { text?: string }).text ?? JSON.stringify(called)).toContain('Plan v1 sent to the operator')
  expect(written).toContain('/home/test/.moonlight/mod/sessions/test-session/plan/v1.md')

  const ui = await $.ui.mount({ plugin: 'moonlightcode', surface: 'terminal', ...PANE } as never)
  expect(await ui.find({ type: 'Text', text: /Plan v1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeDefined()
  expect(await ui.find({ key: 'plan-approve' })).toBeDefined()
  // Lines drawn as Markdown, code through the highlighter in its fence's
  // language, the fence itself only as that language.
  expect(await ui.find({ type: 'Markdown', text: '# Add a cache' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: '- Wrap the client' })).toBeDefined()
  const code = (await ui.find({ type: 'Code', text: '# code, not heading' })) as unknown as { props: Record<string, unknown> }
  expect(code.props.language).toBe('ts')
  expect(await ui.find({ type: 'Text', text: /^ts$/ })).toBeDefined()
  // Nothing to refine yet.
  expect(await ui.find({ key: 'plan-refine' })).toBeUndefined()

  // Lines 3-4: the two bullets.
  await ui.press({ key: 'pline:2' })
  await ui.press({ key: 'pline:3' })
  expect(await ui.find({ type: 'Text', text: /Selected lines 3-4/ })).toBeDefined()
  await ui.input({ key: 'plan-comment', text: 'Which client? \\' })
  await ui.input({ key: 'plan-comment', text: 'Name it.' })
  expect(await ui.find({ type: 'Text', text: /^Which client\?/ })).toBeDefined()
  expect(await ui.find({ key: 'plan-refine', text: /Ask for changes \(1\)/ })).toBeDefined()

  // Refused here: the comment comes back and the version stays open.
  await ui.press({ key: 'plan-refine' })
  for (let i = 0; i < 100 && (await ui.find({ key: 'plan-refine' })) === undefined; i += 1)
    await new Promise(resolve => setTimeout(resolve, 10))
  expect(await ui.find({ key: 'plan-refine', text: /Ask for changes \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting for you/ })).toBeDefined()

  // A second plan is v2, its review fresh.
  await $.tool.call({ tool: 'mcp__moonlightcode__present_plan', plan: `${PLAN}\n- Log misses` } as never)
  expect(await ui.find({ type: 'Text', text: /Plan v2/ })).toBeDefined()
  expect(await ui.find({ key: 'plan-refine' })).toBeUndefined()
  await ui.unmount()
})
