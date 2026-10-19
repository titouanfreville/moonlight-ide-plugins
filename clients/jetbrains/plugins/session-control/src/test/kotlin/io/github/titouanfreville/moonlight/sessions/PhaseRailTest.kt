package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.client.Phase
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The phase rail: which discs are lit, and what each phase is called on it. */
class PhaseRailTest {
    @Test
    fun `phases behind the current one are past, the rest ahead`() {
        assertEquals(
            listOf(Disc.Past, Disc.Past, Disc.Current, Disc.Ahead, Disc.Ahead),
            Phase.ORDERED.map { discOf(it, Phase.Test) },
        )
    }

    @Test
    fun `Plan has nothing behind it`() {
        assertEquals(Disc.Current, discOf(Phase.Plan, Phase.Plan))
        assertEquals(Disc.Ahead, discOf(Phase.Commit, Phase.Plan))
    }

    @Test
    fun `AutoImplement reads as Auto, the daemon's alias`() {
        assertEquals(listOf("Plan", "Auto", "Test", "Review", "Commit"), Phase.ORDERED.map(::phaseLabel))
    }

    @Test
    fun `a pick of the current phase is no move`() {
        // Moving there would pin the phase and stop auto-advance.
        assertEquals(null, phaseMove(Phase.Review, Phase.Review))
        assertEquals(Phase.Test, phaseMove(Phase.Test, Phase.Review))
        assertEquals(null, phaseMove(Phase.Test, null))
    }

    @Test
    fun `the rail says the focused phase, its files and what Enter does`() {
        assertEquals("Plan, project files read-only, press Enter to move here", railSpeech(Phase.Plan, Phase.Review, true))
        assertEquals("Auto, project files writable, current phase", railSpeech(Phase.AutoImplement, Phase.AutoImplement, true))
        assertEquals(
            "Test, project files writable, unavailable: answer what the session is waiting on first",
            railSpeech(Phase.Test, Phase.Review, false),
        )
    }
}
