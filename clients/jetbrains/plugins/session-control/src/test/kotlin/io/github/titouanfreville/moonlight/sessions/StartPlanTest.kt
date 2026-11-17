package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.core.ClaudeModState
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** In step with VS Code's `start-plan.test.ts`. */
class StartPlanTest {
    @Test
    fun `a reachable daemon governs, without it the Claude Code plugin when enabled, else nothing`() {
        assertEquals(StartGovernor.Daemon, governorFor(null, ClaudeModState.Missing))
        assertEquals(StartGovernor.Mod, governorFor("refused", ClaudeModState.Active))
        assertEquals(StartGovernor.None, governorFor("refused", ClaudeModState.Off))
        assertEquals(StartGovernor.None, governorFor("refused", ClaudeModState.Unknown))
    }

    @Test
    fun `herdr is offered only while its server runs`() {
        assertEquals(HostPlan.Ask, hostFor(StartIn.Ask, true))
        assertEquals(HostPlan.Terminal, hostFor(StartIn.Ask, false))
        assertEquals(HostPlan.Terminal, hostFor(StartIn.Terminal, true))
        assertEquals(HostPlan.Herdr, hostFor(StartIn.Herdr, true))
        // Asked for explicitly: say it is down rather than quietly using a terminal.
        assertEquals(HostPlan.HerdrDown, hostFor(StartIn.Herdr, false))
    }
}
