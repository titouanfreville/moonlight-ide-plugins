package io.github.titouanfreville.moonlight.sessions

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** AI Review reads this key from its own copy (it must not need this class): pinned on both sides. */
class SessionsSelectionKeyTest {
    @Test
    fun `the key is the one AI Review reads`() {
        // AI Review's SessionsSelectionTest pins the same string on its side.
        assertEquals("moonlight.sessions.selected", SessionsSelection.KEY)
    }

    @Test
    fun `a pick is the session id, then a stamp after a bar`() {
        // AI Review's pickedSession reads the id before the bar.
        assertEquals("abc|7", pickToken("abc", 7))
    }
}
