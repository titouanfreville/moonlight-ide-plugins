package io.github.titouanfreville.moonlight.agentic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Ported from `mod-route.test.ts`. */
class ModRouteTest {
    private val plan = "# Plan\n\nWrap the client."

    @Test
    fun `a bare approval carries no note`() {
        val entry = modPlanEntry(2, plan, emptyMap(), PlanVerdict.Approve)
        assertEquals("approve", entry.verdict)
        assertEquals("", entry.note)
        assertEquals(2, entry.version)
    }

    @Test
    fun `an approval with notes keeps them`() {
        assertTrue(modPlanEntry(2, plan, mapOf(0 to "mind the TTL"), PlanVerdict.Approve).note.contains("mind the TTL"))
    }

    @Test
    fun `the four verdicts in the mod three, the IDE tag kept`() {
        val notes = mapOf(0 to "why?")
        assertEquals("refine", modPlanEntry(1, plan, notes, PlanVerdict.OpenQuestion).verdict)
        assertEquals("refine", modPlanEntry(1, plan, notes, PlanVerdict.Refine).verdict)
        val noGo = modPlanEntry(1, plan, notes, PlanVerdict.NoGo)
        assertEquals("reject", noGo.verdict)
        assertTrue(noGo.note.contains("[verdict: no-go]"))
    }

    @Test
    fun `a rejection always has a reason`() {
        assertTrue(modPlanEntry(1, plan, emptyMap(), PlanVerdict.NoGo).note.isNotBlank())
    }
}
