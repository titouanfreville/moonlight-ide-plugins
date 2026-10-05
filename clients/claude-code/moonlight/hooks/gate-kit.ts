// Starts the gate in a test the way a session does: a project at /p, a home at
// /h, a temp folder at /t. The test changes `world` to move the phase or the
// effective sandbox; every write the mod makes is recorded, none reaches disk.
// The kit keeps a file's first stubs: one call per test file.

export type GateWorld = {
  phase: string
  settings: Record<string, unknown>
  written: string[]
  // What the tools beneath the gate received (the gate let them through).
  reached: { tool: string; input: Record<string, unknown> }[]
}

type On = (event: string, ...rest: unknown[]) => void
type Engine = { session: { start: (e: never) => Promise<unknown> } }

export const SAFE_PLAN_SETTINGS = {
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyWrite: ['./.moonlight', './.claude/settings.json', './.claude/settings.local.json', './src'],
      allowWrite: [],
    },
  },
}

export const startGate = async ($: Engine, on: On): Promise<GateWorld> => {
  const world: GateWorld = { phase: 'plan', settings: {}, written: [], reached: [] }
  const value = (v: unknown) => ({ value: v }) as never
  // What the engine does at session start, beneath the mod's hook.
  on('session.start', () => ({ cwd: '/p' }))
  on('session.root', () => value('/p'))
  on('session.cwd', () => value('/p'))
  on('session.id', () => value('s1'))
  on('session.surfaces', () => value(['terminal']))
  on('clock.now', () => value(1_700_000_000_000))
  on('env.get', (_$: unknown, e: { name?: string }) => value(e.name === 'HOME' ? '/h' : e.name === 'TMPDIR' ? '/t' : undefined))
  on('fs.stat', (_$: unknown, e: { path: string }) =>
    value({ kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path }))
  on('fs.exists', () => value(false))
  on('fs.list', () => value([{ name: 'src', kind: 'dir', size: 0 }, { name: '.ai', kind: 'dir', size: 0 }]))
  on('fs.read', (_$: unknown, e: { path: string }) =>
    value(e.path.endsWith('/phase') ? `${world.phase}\n` : '{}'))
  on('fs.write', (_$: unknown, e: { path: string }) => {
    world.written.push(e.path)
    return value(undefined)
  })
  on('store.get', () => value(undefined))
  on('store.set', () => value(undefined))
  on('settings.read', () => value(world.settings))
  // The tools themselves: answer, and record what the gate let through.
  for (const tool of ['Write', 'Edit', 'Bash', 'Monitor', 'Read'])
    on('tool.call', { tool }, (_$: unknown, e: Record<string, unknown>) => {
      world.reached.push({ tool, input: e })
      return { result: `${tool} ran` }
    })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  return world
}

// What a tool call resolved to, as text: the result, or the reason it was refused.
export const textOf = (called: unknown): string => {
  const c = called as { text?: string; deny?: string; result?: unknown }
  return c.text ?? c.deny ?? (typeof c.result === 'string' ? c.result : JSON.stringify(called))
}
