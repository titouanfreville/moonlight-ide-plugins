import { expect, test } from 'claude-code/testing'
import { startGate, textOf } from './gate-kit'

// The file tools and the deny-by-default tool gate, in the read-only phases.
test('Gate: Plan and Commit keep project files read-only; the gate protects itself', async ($, on) => {
  const world = await startGate($ as never, on as never)
  const write = async (file_path: string) =>
    textOf(await $.tool.call({ tool: 'Write', file_path, content: 'x' } as never))

  // Plan: project files refused, notes and /tmp open.
  expect(await write('/p/src/a.ts')).toContain('is a project file and Plan is read-only')
  expect(await write('/p/.ai/notes.md')).toBe('Write ran')
  expect(await write('/t/scratch.txt')).toBe('Write ran')
  // A path that climbs out of an open folder is refused.
  expect(await write('/p/.ai/../src/a.ts')).toContain('read-only')
  // The gate's own files, in every phase.
  expect(await write('/h/.moonlight/mod/projects/x/phase')).toContain('belongs to the gate itself')
  expect(await write('/p/.claude/settings.local.json')).toContain('belongs to the gate itself')

  // Unlisted tools are refused; Claude Code's plan mode points to present_plan.
  expect(textOf(await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'y' } as never))).toContain(
    'not on the read-only allow-list',
  )
  expect(textOf(await $.tool.call({ tool: 'ExitPlanMode' } as never))).toContain('present_plan')
  expect(textOf(await $.tool.call({ tool: 'Read', file_path: '/p/src/a.ts' } as never))).toBe('Read ran')

  // Commit freezes the notes too; /tmp stays open.
  world.phase = 'commit'
  expect(await write('/p/.ai/notes.md')).toContain('commit gate freezes everything')
  expect(await write('/t/scratch.txt')).toBe('Write ran')

  // Auto: project files are writable, the gate's own files still are not.
  world.phase = 'auto'
  expect(await write('/p/src/a.ts')).toBe('Write ran')
  expect(await write('/p/.claude/settings.json')).toContain('belongs to the gate itself')
})
