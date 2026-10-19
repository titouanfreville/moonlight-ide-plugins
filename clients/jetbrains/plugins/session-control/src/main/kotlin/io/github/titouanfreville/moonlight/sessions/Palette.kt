package io.github.titouanfreville.moonlight.sessions

import com.intellij.ide.ui.UISettings
import com.intellij.ui.JBColor
import java.awt.Color

/**
 * The colours MoonlightCode draws meanings with. Colour never carries a meaning alone:
 * badges keep their text and phases their names in every mode.
 *
 * Colour-blind mode follows the IDE's own setting (Settings → Appearance → Accessibility,
 * "Adjust colors for..."), whatever kind it names: the Okabe–Ito colours used then stay
 * distinct for red-green and blue-yellow colour blindness alike.
 *
 * A private copy, not core's: the plugins update one at a time, and a class this plugin
 * needs from a newer core would be missing beside an older one (NoClassDefFoundError).
 * AI Review keeps the same copy; keep the two in step.
 */
internal object Palette {
    /**
     * Okabe–Ito vermilion, orange and blue. These colour text (badges, held rows,
     * severities), so the light variants are darker shades of the same hues: the pure ones
     * sit near 3.5:1 on a light panel, these at 4.5:1 or more. VS Code's panel uses the same.
     */
    private val VERMILION = JBColor(Color(0xB34D00), Color(0xE87A2A))
    private val ORANGE = JBColor(Color(0x8A5D00), Color(0xE69F00))
    private val BLUE = JBColor(Color(0x0072B2), Color(0x56B4E9))

    /** The default warning, for text: JBColor.ORANGE is about 1.5:1 on a light panel. */
    private val WARNING_TEXT = JBColor(Color(0x8A5D00), JBColor.ORANGE)

    /** The lit phase on the rail: a cool slate that reads on both themes. */
    val MOON = JBColor(Color(0x3C4E6E), Color(0xC9D6EE))

    /** An unlit phase, and the rail's line. */
    val MOON_SOFT = JBColor(Color(0xC8D2E3), Color(0x3A4352))

    fun isColorBlind(): Boolean = runCatching { UISettings.getInstance().colorBlindness != null }.getOrDefault(false)

    /** An error, a warning, information: badges alike. */
    fun error(): Color = if (isColorBlind()) VERMILION else JBColor.RED

    fun warning(): Color = if (isColorBlind()) ORANGE else WARNING_TEXT

    fun info(): Color = if (isColorBlind()) BLUE else JBColor.BLUE
}
