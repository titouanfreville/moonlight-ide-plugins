package io.github.titouanfreville.moonlight.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class TabLabelTest {
    @Test
    fun `a tab with nothing to count is its name, and nothing beside its icon`() {
        val label = TabLabel("Review", null)
        assertEquals("Review", label.full)
        assertEquals("", label.compact)
    }

    @Test
    fun `the short badge fits beside the icon, the long one reads in full`() {
        val label = TabLabel("Sessions", "2", "2 waiting")
        assertEquals("Sessions (2 waiting)", label.full)
        assertEquals("2", label.compact)
        assertEquals("Review (43)", TabLabel("Review", "43").full)
    }
}
