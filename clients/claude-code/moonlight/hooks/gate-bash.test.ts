import { expect, test } from 'claude-code/testing'
import { SAFE_PLAN_SETTINGS, startGate, textOf } from './gate-kit'

// Bash runs only under a safe sandbox carrying the gate's deny list, never
// with the sandbox disabled, and never with an allowWrite that opens the gate.
test('Gate: Bash and Monitor need a safe sandbox with the deny list in force', async ($, on) => {
  const world = await startGate($ as never, on as never)
  const bash = async (extra: Record<string, unknown> = {}) =>
    textOf(await $.tool.call({ tool: 'Bash', command: 'ls', ...extra } as never))

  const monitor = async (input: Record<string, unknown>) =>
    textOf(await $.tool.call({ tool: 'Monitor', description: 'd', timeout_ms: 1000, ...input } as never))

  world.settings = {}
  expect(await bash()).toContain('the sandbox is not safe')
  // Monitor runs its script in the same shell: the same checks.
  expect(await monitor({ command: 'tail -f x.log' })).toContain('Monitor refused, the sandbox is not safe')
  // A WebSocket monitor runs no shell.
  expect(await monitor({ ws: { url: 'wss://example.test' } })).toBe('Monitor ran')

  world.settings = { sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: [] } } }
  expect(await bash()).toContain('the deny list is not in force yet')

  world.settings = SAFE_PLAN_SETTINGS
  expect(await bash({ dangerouslyDisableSandbox: true })).toBe('Bash ran')
  expect(world.reached.at(-1)?.input.dangerouslyDisableSandbox).toBe(false)
  expect(await monitor({ command: 'tail -f x.log' })).toBe('Monitor ran')

  world.settings = {
    sandbox: { ...SAFE_PLAN_SETTINGS.sandbox, filesystem: { ...SAFE_PLAN_SETTINGS.sandbox.filesystem, allowWrite: ['~/.moonlight'] } },
  }
  expect(await bash()).toContain('opens the gate')
})
