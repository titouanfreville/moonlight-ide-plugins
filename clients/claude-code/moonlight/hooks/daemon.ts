// The mod is installed into Claude Code itself, so it loads in every session,
// whoever launched it (a terminal, Anthropic's VS Code or JetBrains plugin).
// When the daemon answers and its hooks are installed, the daemon governs and
// the mod stands by; otherwise the mod governs. The daemon knows nothing of the
// mod, so the mod is the one that yields:
// - a session the mod has governed since it started stays the mod's;
// - one on standby is taken over as soon as the daemon stops governing, and
//   handed back once it governs again: it is the daemon's session, the mod only
//   stood in while it was away (a restart for a newer version, say).

import type { Phase } from './policy'

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

// Who governs from now on.
// `misses`: probes missed in a row while the daemon governed (a session that
// starts with no daemon is the mod's at once).
// `standIn`: the mod took this session over from a daemon that stopped, so it
// hands it back as soon as the daemon governs again.
export const nextGovernor = (
  current: Governor | undefined,
  daemonGoverns: boolean,
  misses = 0,
  standIn = false,
): Governor =>
  current === 'mod'
    ? standIn && daemonGoverns
      ? 'daemon'
      : 'mod'
    : daemonGoverns || (current === 'daemon' && misses < TAKEOVER_AFTER_MISSES)
      ? 'daemon'
      : 'mod'

// Ticks between two probes for the daemon's return while the mod stands in:
// gating-status reads the hook registrations, too costly for every tick.
export const HANDBACK_PROBE_TICKS = 3

// The daemon's name for each mod phase (`POST /control/phase`), so the session
// goes back in the phase it is in: a hand-back must not change what the agent may do.
export const DAEMON_PHASE: Readonly<Record<Phase, string>> = {
  plan: 'Plan',
  auto: 'AutoImplement',
  test: 'Test',
  review: 'Review',
  commit: 'Commit',
}