import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// "Allow for this session" lets the tool run, and the next call asks no more.
// Jira runs in Plan without asking.
test('Plan runs an MCP tool the operator allows for the session; Jira needs no asking', async ($, on) => {
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, (_$: unknown, e: { questions: { question: string }[] }) => {
    asked++
    return { result: { questions: e.questions, answers: { [e.questions[0]!.question]: 'Allow for this session' } } } as never
  })
  on('tool.call', { tool: 'mcp__notion__create_page' }, () => ({ result: 'created' }) as never)
  on('tool.call', { tool: 'mcp__claude_ai_Atlassian__createJiraIssue' }, () => ({ result: 'PROJ-1' }) as never)
  await startGate($, on)
  expect(textOf(await $.tool.call({ tool: 'mcp__notion__create_page' } as never))).not.toContain('Moonlight')
  expect(textOf(await $.tool.call({ tool: 'mcp__notion__create_page' } as never))).not.toContain('Moonlight')
  expect(asked).toBe(1)
  expect(textOf(await $.tool.call({ tool: 'mcp__claude_ai_Atlassian__createJiraIssue' } as never))).not.toContain('Moonlight')
  expect(asked).toBe(1)
})
