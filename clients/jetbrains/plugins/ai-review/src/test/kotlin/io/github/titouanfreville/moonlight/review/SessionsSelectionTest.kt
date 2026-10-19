package io.github.titouanfreville.moonlight.review

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** The handoff from the Sessions tab: each pick moves a tab once, and only when the tab can show it. */
class SessionsSelectionTest {
    @Test
    fun `the key is the one Session Control writes`() {
        // Session Control's SessionsSelectionKeyTest pins the same string on its side.
        assertEquals("moonlight.sessions.selected", SessionsSelection.KEY)
    }

    @Test
    fun `a pick stored before the tab existed is not news`() {
        // The property persists across restarts: last run's pick must not move the tabs.
        assertNull(SessionsSelection { "a|1" }.fresh { true })
    }

    @Test
    fun `a new pick is reported once, as its session id`() {
        var stored: String? = null
        val selection = SessionsSelection { stored }
        stored = "a|1"
        assertEquals("a", selection.fresh { true })
        assertNull(selection.fresh { true })
    }

    @Test
    fun `picking the same session again is news`() {
        var stored: String? = "a|1"
        val selection = SessionsSelection { stored }
        stored = "a|2"
        assertEquals("a", selection.fresh { true })
    }

    @Test
    fun `a refused pick stays pending until the tab can take it`() {
        var stored: String? = null
        var adopted = false
        val selection = SessionsSelection { stored }
        stored = "a|1"
        assertNull(selection.fresh { adopted })
        adopted = true
        assertEquals("a", selection.fresh { adopted })
        assertNull(selection.fresh { adopted })
    }

    @Test
    fun `a bare id from an older Session Control still reads`() {
        assertEquals("a", pickedSession("a"))
        assertEquals("a", pickedSession("a|42"))
    }
}
