import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// In Plan, an MCP tool off the read-only list is the operator's call. With no
// one to answer (the dialog rejects), it is refused, and says how to go on.
test('Plan asks for an unlisted MCP tool; no answer refuses it', async ($, on) => {
  await startGate($, on)
  const called = await $.tool.call({ tool: 'mcp__notion__create_page' } as never)
  expect(textOf(called)).toContain('the operator did not allow mcp__notion__create_page')
  expect(textOf(called)).toContain('request_phase')
})
