package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.client.DiscoverableSession

/**
 * Adopting new sessions without being asked — a port of `auto-adopt.ts`.
 *
 * Adoption is what first lets the gate deny anything, so a fleet governed only when
 * someone remembers to click Adopt is governed by accident. What this deliberately does not
 * do is soften the landing: a freshly adopted session sits in `Plan`, which denies project
 * writes until the operator advances it. Adopting straight into a writing phase would grant
 * write access without the plan gate ever running.
 */

/**
 * The sessions this window should adopt now.
 *
 * Scoped by `owns` because every window sees the whole fleet: unscoped, every window would
 * race to adopt every session. `attempted` carries ids already tried — a failing adopt
 * retried on a five-second poll is a request storm.
 *
 * `modGoverned` is `core.governor(id) == Governor.Mod`: a session the MoonlightCode mod
 * inside Claude Code governs keeps its own gate. Adopting it would put it under a second
 * gate in a second phase.
 */
fun sessionsToAdopt(
    sessions: List<DiscoverableSession>,
    owns: (String) -> Boolean,
    attempted: Set<String>,
    modGoverned: (String) -> Boolean = { false },
): List<DiscoverableSession> =
    sessions.filter { !it.adopted && it.sessionId !in attempted && owns(it.sessionId) && !modGoverned(it.sessionId) }

/** What the operator is told when adopting a session the mod governs. */
const val MOD_GOVERNED_ADOPT =
    "This session is governed by the MoonlightCode plugin inside Claude Code, which keeps it: " +
        "set its phase from the plugin (or this tool window), not by adopting it."

/**
 * Ids worth forgetting, so a session adopted and later released can be adopted again
 * rather than being ignored forever by a set that only grows.
 */
fun staleAttempts(attempted: Set<String>, sessions: List<DiscoverableSession>): List<String> {
    val live = sessions.filter { !it.adopted }.mapTo(HashSet()) { it.sessionId }
    return attempted.filter { it !in live }
}
