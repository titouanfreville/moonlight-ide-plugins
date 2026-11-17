package io.github.titouanfreville.moonlight.sessions

import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.Phase
import io.github.titouanfreville.moonlight.client.SessionStatus
import io.github.titouanfreville.moonlight.core.Governor
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The tidy rules, in step with VS Code's `tidy.test.ts`. */
class TidyTest {
    private fun session(id: String, status: SessionStatus = SessionStatus.Idle) =
        DiscoverableSession(sessionId = id, title = id, root = "/p", adopted = true, status = status, phase = Phase.Review, unreviewedFiles = 0)

    @Test
    fun `working, waiting on the operator or holding an answer is never tidied away`() {
        assertTrue(isLive(session("a", SessionStatus.Running), false))
        assertTrue(isLive(session("a", SessionStatus.WaitingInput), false))
        assertTrue(isLive(session("a"), true))
        assertFalse(isLive(session("a", SessionStatus.Done), false))
        assertEquals("It is working.", tidyBlocker(session("a", SessionStatus.Running), false))
        assertNull(tidyBlocker(session("a", SessionStatus.Errored), false))
    }

    @Test
    fun `a hidden session is visible again once it works again, and stays visible`() {
        val next = reconcileHidden(
            mapOf("quiet" to 1L, "back" to 2L, "held" to 3L),
            listOf(session("quiet"), session("back", SessionStatus.Running), session("held")),
            setOf("held"),
        )
        assertEquals(mapOf("quiet" to 1L), next)
        // Nothing moved: nothing to save.
        assertNull(reconcileHidden(mapOf("quiet" to 1L), listOf(session("quiet")), emptySet()))
    }

    @Test
    fun `an id no longer listed stays hidden, since a daemon restart lists nothing for a moment`() {
        assertNull(reconcileHidden(mapOf("gone" to 5L), emptyList(), emptySet()))
    }

    @Test
    fun `the hidden list is capped, the most recently hidden kept`() {
        val many = (0 until 502).associate { "s$it" to it.toLong() }
        val next = reconcileHidden(many, emptyList(), emptySet())!!
        assertEquals(500, next.size)
        assertFalse("s0" in next || "s1" in next)
        assertTrue("s501" in next)
    }

    @Test
    fun `a custom group is empty when none of its sessions is known any more`() {
        val groups = listOf(
            CustomGroup("g1", "Release", listOf("a", "old")),
            CustomGroup("g2", "Stale", listOf("old")),
            CustomGroup("g3", "New", emptyList()),
        )
        assertEquals(listOf("g2", "g3"), emptyGroups(groups, listOf(session("a"))).map { it.id })
    }

    @Test
    fun `forget is for the daemon's sessions only, and only while it answers`() {
        assertNull(forgetBlocker(session("a"), false, daemonDown = false, governor = Governor.Daemon))
        assertTrue(forgetBlocker(session("a"), false, daemonDown = false, governor = Governor.Mod)!!.contains("Claude Code plugin"))
        assertTrue(forgetBlocker(session("a"), false, daemonDown = true, governor = Governor.Daemon)!!.contains("No MoonlightCode daemon"))
        assertEquals("It is working.", forgetBlocker(session("a", SessionStatus.Running), false, daemonDown = false, governor = Governor.Daemon))
    }

    @Test
    fun `a refused forget says why in the operator's terms`() {
        assertTrue(forgetError(404).contains("does not know it"))
        assertTrue(forgetError(409).contains("working or waiting"))
        assertEquals("HTTP 500", forgetError(500))
    }
}
