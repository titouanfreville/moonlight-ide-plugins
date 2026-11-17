package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.core.ClaudeModState

/**
 * Who will govern a session we start, decided before launching: it changes the launch (the
 * daemon's MCP config, or none) and what follows it (adopting, or nothing to do). In step
 * with VS Code's `start-plan.ts`.
 */
enum class StartGovernor { Daemon, Mod, None }

/**
 * A reachable daemon governs what we start. Without one, the Claude Code plugin governs
 * every session it runs in, when it is installed and enabled. Otherwise nothing does, and
 * the operator should hear so before the session starts, not after.
 */
fun governorFor(backendError: String?, claudeMod: ClaudeModState): StartGovernor = when {
    backendError == null -> StartGovernor.Daemon
    claudeMod == ClaudeModState.Active -> StartGovernor.Mod
    else -> StartGovernor.None
}

/** Where a session runs. */
enum class Host { Terminal, Herdr }

/** What to do about the host: use one, ask, or say herdr is down (it was asked for). */
enum class HostPlan { Terminal, Herdr, Ask, HerdrDown }

/** herdr is offered only while a herdr server runs: a choice that would fail is not a choice. */
fun hostFor(setting: StartIn, herdrRunning: Boolean): HostPlan = when (setting) {
    StartIn.Terminal -> HostPlan.Terminal
    StartIn.Herdr -> if (herdrRunning) HostPlan.Herdr else HostPlan.HerdrDown
    StartIn.Ask -> if (herdrRunning) HostPlan.Ask else HostPlan.Terminal
}
