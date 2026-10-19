// Starts the gate in a test the way a session does: a project at /p, a home at
// /h, a temp folder at /t. The test changes `world` to move the phase or the
// effective sandbox; every write the mod makes is recorded, none reaches disk.
// The kit keeps a file's first stubs: one call per test file.

import { mock, type MockClock } from 'claude-code/testing'

export type GateWorld = {
  phase: string
  settings: Record<string, unknown>
  written: string[]
  // What the tools beneath the gate received (the gate let them through).
  reached: { tool: string; input: Record<string, unknown> }[]
  // With `bridge`: the session's files the mod and the IDE share (under
  // /h/.moonlight/mod/sessions), and the clock that drives the mod's tick.
  files: Record<string, string>
  // The last text written to each path, shared or not.
  texts: Record<string, string>
  // Whether the daemon answers (`daemon` given): a test turns it off mid-way.
  daemonUp: boolean
  // File times `fs.stat` reports (a heartbeat's freshness); 0 when not set.
  mtimes: Record<string, number>
  clock?: MockClock
}

const SESSIONS = '/h/.moonlight/mod/sessions/'

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

// `daemon`: a MoonlightCode daemon answers on loopback, with this
// /control/gating-status body. Left out, no daemon is running.
// `bridge`: the clock is mocked (the test advances it to run the tick), the
// session files are kept in `world.files`, and a phase write takes effect.
export const startGate = async (
  $: Engine,
  on: On,
  options: { daemon?: string; bridge?: boolean } = {},
): Promise<GateWorld> => {
  const world: GateWorld = { phase: 'plan', settings: {}, written: [], reached: [], files: {}, texts: {}, daemonUp: options.daemon !== undefined, mtimes: {} }
  // With `bridge`, `world.files` is a disk of its own: the shared session files,
  // and any project file a test puts there.
  const isShared = (path: string) =>
    options.bridge === true && (`${path}/`.startsWith(SESSIONS) || world.files[path] !== undefined)
  const value = (v: unknown) => ({ value: v }) as never
  // What the engine does at session start, beneath the mod's hook.
  on('session.start', () => ({ cwd: '/p' }))
  on('session.root', () => value('/p'))
  on('session.cwd', () => value('/p'))
  on('session.id', () => value('s1'))
  on('session.surfaces', () => value(['terminal']))
  if (options.bridge === true) world.clock = mock.clock(on as never, { now: 1_700_000_000_000 })
  else on('clock.now', () => value(1_700_000_000_000))
  on('env.get', (_$: unknown, e: { name?: string }) => value(e.name === 'HOME' ? '/h' : e.name === 'TMPDIR' ? '/t' : undefined))
  on('fs.stat', (_$: unknown, e: { path: string }) =>
    value({ kind: 'dir', size: 0, mtimeMs: world.mtimes[e.path] ?? 0, isLink: false, realPath: e.path }))
  const control = '/h/.moonlight/control.json'
  on('fs.exists', (_$: unknown, e: { path: string }) =>
    value(
      (options.daemon !== undefined && e.path === control) ||
        (isShared(e.path) && Object.keys(world.files).some(f => f === e.path || f.startsWith(`${e.path}/`))),
    ))
  on('http.fetch', (_$: unknown, e: { url: string }) =>
    value(
      world.daemonUp && options.daemon !== undefined && e.url === 'http://127.0.0.1:4123/control/gating-status'
        ? { status: 200, ok: true, headers: {}, text: options.daemon }
        : world.daemonUp && e.url === 'http://127.0.0.1:4123/control/health'
          ? { status: 200, ok: true, headers: {}, text: '{"pid":1,"version":"0.1.5","api":1}' }
          : { status: 404, ok: false, headers: {}, text: '' },
    ))
  if (options.bridge !== true) on('clock.sleep', () => new Promise(() => undefined))
  on('fs.list', (_$: unknown, e: { path?: string }) => {
    const dir = e.path ?? ''
    if (!isShared(dir)) return value([{ name: 'src', kind: 'dir', size: 0 }, { name: '.ai', kind: 'dir', size: 0 }])
    // Files right under `dir`, and the folders that hold the deeper ones.
    const below = Object.keys(world.files).filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1))
    const files = below.filter(f => !f.includes('/')).map(name => ({ name, kind: 'file', size: 0 }))
    const dirs = [...new Set(below.filter(f => f.includes('/')).map(f => f.split('/')[0]))].map(name => ({ name, kind: 'dir', size: 0 }))
    return value([...files, ...dirs])
  })
  on('fs.read', (_$: unknown, e: { path: string }) =>
    value(
      e.path.endsWith('/phase')
        ? `${world.phase}\n`
        : e.path === control
          ? '{"port":4123}'
          : isShared(e.path)
            ? world.files[e.path]
            : '{}',
    ))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    world.written.push(e.path)
    world.texts[e.path] = e.text
    if (isShared(e.path)) world.files[e.path] = e.text
    if (options.bridge === true && e.path.endsWith('/phase')) world.phase = e.text.trim()
    return value(undefined)
  })
  if (options.bridge === true)
    on('process.run', (_$: unknown, e: { argv?: readonly string[] }) => {
      const argv = e.argv ?? []
      const answer = (stdout: string) =>
        value({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
      // A changed file counts one line each way; `rm -r` empties a folder.
      if (argv[0] === 'rm') {
        const dir = argv[argv.length - 1]!
        for (const key of Object.keys(world.files)) if (key.startsWith(`${dir}/`)) delete world.files[key]
        return answer('')
      }
      // Same content on both sides is no change; any other pair, one line each way.
      const [a, b] = argv.slice(-2)
      const same = a !== undefined && world.files[a] !== undefined && world.files[a] === world.files[b!]
      return answer(argv.includes('--numstat') && !same ? '1\t1\t-\n' : '')
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
