// Pure logic of the hand-over with the MoonlightCode daemon. No `$` here, so
// it is unit-testable.
//
// The mod is installed into Claude Code itself, so it loads in every session,
// whoever launched it (a terminal, Anthropic's VS Code or JetBrains plugin).
// When the daemon answers and its hooks are installed, the daemon governs and
// the mod stands by; otherwise the mod governs. A session the mod governs
// stays the mod's (never two gates with two phases); one on standby is taken
// over as soon as the daemon stops governing.

export type Governor = 'mod' | 'daemon'

// Where the daemon publishes its port: `$MOONLIGHT_HOME/.moonlight/control.json`
// when MOONLIGHT_HOME is absolute, else under the home directory (the rule the
// IDE clients follow, moonlight-control-client/src/daemon.ts).
export const discoveryFile = (home: string | undefined, override: string | undefined): string | undefined => {
  const anchor = override !== undefined && override.startsWith('/') ? override : home
  return anchor === undefined ? undefined : `${anchor}/.moonlight/control.json`
}

// The daemon's control API, from the discovery file: loopback only.
export const controlUrl = (text: string): string | undefined => {
  try {
    const port = (JSON.parse(text) as { port?: unknown }).port
    return Number.isInteger(port) && (port as number) > 0 && (port as number) < 65536
      ? `http://127.0.0.1:${port as number}`
      : undefined
  } catch {
    return undefined
  }
}

// Whether the daemon's hooks gate Claude Code, from `/control/gating-status`:
// at least one entry, every one installed. A daemon whose hooks are missing
// governs nothing, so the mod keeps the gate.
export const hooksInstalled = (text: string): boolean => {
  try {
    const entries = JSON.parse(text) as unknown
    return (
      Array.isArray(entries) &&
      entries.length > 0 &&
      entries.every(entry => (entry as { installed?: unknown } | null)?.installed === true)
    )
  } catch {
    return false
  }
}

// Probes in a row the daemon must miss before the mod takes a session over:
// a daemon restart (a second or two) must not flip every open session.
export const TAKEOVER_AFTER_MISSES = 3

// Missed probes so far, after this one: a governing daemon resets the count.
export const countMisses = (misses: number, daemonGoverns: boolean): number => (daemonGoverns ? 0 : misses + 1)

// Whether `/control/health` answered as the daemon does: a cheap check, for
// watching a daemon already known to govern (gating-status reads the hook
// registrations, and can outlast a short timeout on a busy machine).
export const isHealthy = (text: string): boolean => {
  try {
    return Number.isInteger((JSON.parse(text) as { api?: unknown }).api)
  } catch {
    return false
  }
}

// Who governs from now on. The mod never hands a session back: its phase and
// sandbox are in force, and a second gate would hold a second phase.
// `misses`: probes missed in a row while the daemon governed (a session that
// starts with no daemon is the mod's at once).
export const nextGovernor = (current: Governor | undefined, daemonGoverns: boolean, misses = 0): Governor =>
  current === 'mod'
    ? 'mod'
    : daemonGoverns || (current === 'daemon' && misses < TAKEOVER_AFTER_MISSES)
      ? 'daemon'
      : 'mod'
