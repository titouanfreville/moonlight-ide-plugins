package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.client.Phase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** Advancing a session the Claude Code plugin governs: the daemon's order, Commit back to Plan. */
class NextPhaseTest {
    @Test
    fun `the daemon order, cyclic`() {
        assertEquals(Phase.AutoImplement, nextPhase(Phase.Plan))
        assertEquals(Phase.Plan, nextPhase(Phase.Commit))
    }
}
