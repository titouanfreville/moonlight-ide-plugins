package io.github.titouanfreville.moonlight.sessions

import com.intellij.icons.AllIcons
import com.intellij.ui.JBColor
import com.intellij.util.IconUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import io.github.titouanfreville.moonlight.client.Phase
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.accessibility.AccessibleContext
import javax.accessibility.AccessibleRole
import javax.swing.JComponent

/**
 * What a screen reader says for the phase the keyboard is on: the rail is painted, so this
 * is its only voice. Names the phase, whether project files are writable there, and what
 * Enter would do.
 */
internal fun railSpeech(focused: Phase, current: Phase?, enabled: Boolean): String {
    val files = if (focused.frozen) "project files read-only" else "project files writable"
    val what = when {
        !enabled -> "unavailable: answer what the session is waiting on first"
        focused == current -> "current phase"
        else -> "press Enter to move here"
    }
    return "${phaseLabel(focused)}, $files, $what"
}

/**
 * The phase a rail pick moves the session to, or null for no move: no session, or the
 * current phase — moving there would pin it and stop auto-advance, which nobody means by
 * clicking the lit disc. The picker's "(current)" choice still pins: it asks for that.
 */
internal fun phaseMove(picked: Phase, current: Phase?): Phase? = picked.takeIf { current != null && it != current }

/** Where a phase sits relative to the session's: behind it, on it, or still ahead. */
enum class Disc { Past, Current, Ahead }

fun discOf(phase: Phase, current: Phase): Disc {
    val i = Phase.ORDERED.indexOf(phase)
    val c = Phase.ORDERED.indexOf(current)
    return when {
        i < c -> Disc.Past
        i == c -> Disc.Current
        else -> Disc.Ahead
    }
}


/**
 * The whole workflow cycle for one session — the JetBrains side of the VS Code panel's
 * lunar rail: five discs on a line, the current one lit, the ones behind half lit, and a
 * padlock on the phases that deny project writes. A click moves the session there.
 *
 * Keyboard: Left and Right move the focus between phases, Enter or Space picks it.
 */
class PhaseRail(private val onPick: (Phase) -> Unit) : JComponent() {
    var phase: Phase? = null
        set(value) {
            if (value != field) focusIndex = value?.let(Phase.ORDERED::indexOf) ?: 0
            field = value
            announce()
            repaint()
        }

    private var hover = -1
    private var focusIndex = 0
    private val lock = IconUtil.scale(AllIcons.Ide.Readonly, null, 0.75f)

    init {
        isFocusable = true
        isOpaque = false
        border = JBUI.Borders.empty(6, 8, 2, 8)
        cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
        val mouse = object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                val at = indexAt(e.x)
                if (at != hover) {
                    hover = at
                    repaint()
                }
            }

            override fun mouseExited(e: MouseEvent) {
                hover = -1
                repaint()
            }

            override fun mouseClicked(e: MouseEvent) {
                val at = indexAt(e.x)
                if (isEnabled && at >= 0) onPick(Phase.ORDERED[at])
            }
        }
        addMouseListener(mouse)
        addMouseMotionListener(mouse)
        addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_LEFT -> focusIndex = (focusIndex + Phase.ORDERED.size - 1) % Phase.ORDERED.size
                    KeyEvent.VK_RIGHT -> focusIndex = (focusIndex + 1) % Phase.ORDERED.size
                    KeyEvent.VK_ENTER, KeyEvent.VK_SPACE -> if (isEnabled) onPick(Phase.ORDERED[focusIndex])
                    else -> return
                }
                e.consume()
                announce()
                repaint()
            }
        })
        addFocusListener(object : FocusAdapter() {
            override fun focusGained(e: FocusEvent) = repaint()
            override fun focusLost(e: FocusEvent) = repaint()
        })
        // Registered so getToolTipText(MouseEvent) is asked per phase.
        toolTipText = ""
    }

    override fun getPreferredSize(): Dimension {
        val insets = insets
        val fm = getFontMetrics(JBUI.Fonts.smallFont())
        return Dimension(JBUI.scale(240), insets.top + insets.bottom + JBUI.scale(DISC + 8) + fm.height)
    }

    override fun getMinimumSize(): Dimension = Dimension(JBUI.scale(180), preferredSize.height)

    private val accessible by lazy { AccessibleRail() }

    override fun getAccessibleContext(): AccessibleContext = accessible

    /** One control of five choices, the keyboard on one of them: a tab list, to a screen reader. */
    private inner class AccessibleRail : AccessibleJComponent() {
        override fun getAccessibleRole(): AccessibleRole = AccessibleRole.PAGE_TAB_LIST
        override fun getAccessibleName(): String = "Phase"
        override fun getAccessibleDescription(): String = speech()
    }

    private var spoken: String? = null

    private fun speech(): String = railSpeech(Phase.ORDERED[focusIndex], phase, isEnabled)

    /** Tell assistive technology the focused phase (or its state) changed. */
    private fun announce() {
        val now = speech()
        if (now == spoken) return
        val before = spoken
        spoken = now
        accessible.firePropertyChange(AccessibleContext.ACCESSIBLE_DESCRIPTION_PROPERTY, before, now)
    }

    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        announce()
        cursor = Cursor.getPredefinedCursor(if (enabled) Cursor.HAND_CURSOR else Cursor.DEFAULT_CURSOR)
    }

    override fun getToolTipText(e: MouseEvent): String? {
        // Disabled, the rail says why rather than offering moves it will not make.
        if (!isEnabled) return super.getToolTipText()
        val at = indexAt(e.x).takeIf { it >= 0 } ?: return null
        val p = Phase.ORDERED[at]
        val writes = if (p.frozen) "project files read-only" else "project files writable"
        return if (p == phase) "${phaseLabel(p)}: $writes (current)" else "Move to ${phaseLabel(p)}: $writes"
    }

    private fun slot(): Int = (width - insets.left - insets.right) / Phase.ORDERED.size

    private fun centerX(i: Int): Int = insets.left + slot() * i + slot() / 2

    private fun indexAt(x: Int): Int {
        if (slot() <= 0) return -1
        val i = (x - insets.left) / slot()
        return if (x >= insets.left && i in Phase.ORDERED.indices) i else -1
    }

    override fun paintComponent(g: Graphics) {
        val current = phase ?: return
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
            val d = JBUI.scale(DISC)
            val r = d / 2
            val cy = insets.top + r + JBUI.scale(2)
            val moon = Palette.MOON
            val soft = Palette.MOON_SOFT
            val ground = UIUtil.getPanelBackground()

            g2.color = soft
            g2.drawLine(centerX(0), cy, centerX(Phase.ORDERED.lastIndex), cy)

            val font = JBUI.Fonts.smallFont()
            val fm = g2.getFontMetrics(font)
            for ((i, p) in Phase.ORDERED.withIndex()) {
                val cx = centerX(i)
                val disc = discOf(p, current)
                val grow = if (i == hover && isEnabled) JBUI.scale(1) else 0
                val x = cx - r - grow
                val y = cy - r - grow
                val size = d + 2 * grow
                g2.color = ground
                g2.fillOval(x, y, size, size)
                when (disc) {
                    Disc.Current -> {
                        g2.color = ColorUtilCompat.withAlpha(moon, 60)
                        g2.fillOval(x - JBUI.scale(3), y - JBUI.scale(3), size + JBUI.scale(6), size + JBUI.scale(6))
                        g2.color = moon
                        g2.fillOval(x, y, size, size)
                    }
                    Disc.Past -> {
                        // Half lit: the cycle has been through it.
                        g2.color = ColorUtilCompat.withAlpha(moon, 110)
                        g2.fillArc(x, y, size, size, 90, 180)
                        g2.color = soft
                        g2.drawOval(x, y, size, size)
                    }
                    Disc.Ahead -> {
                        g2.color = soft
                        g2.drawOval(x, y, size, size)
                    }
                }
                if (p.frozen) lock.paintIcon(this, g2, cx + r - lock.iconWidth / 3, y - lock.iconHeight / 3)

                g2.font = if (disc == Disc.Current) font.deriveFont(java.awt.Font.BOLD) else font
                val text = phaseLabel(p)
                val tw = g2.fontMetrics.stringWidth(text)
                g2.color = if (disc == Disc.Current) UIUtil.getLabelForeground() else UIUtil.getContextHelpForeground()
                g2.drawString(text, cx - tw / 2, cy + r + JBUI.scale(6) + fm.ascent)

                if (hasFocus() && i == focusIndex) {
                    g2.color = JBUI.CurrentTheme.Focus.focusColor()
                    g2.drawRoundRect(cx - slot() / 2 + JBUI.scale(2), insets.top - JBUI.scale(2), slot() - JBUI.scale(4), height - insets.top - insets.bottom + JBUI.scale(2), JBUI.scale(6), JBUI.scale(6))
                }
            }
        } finally {
            g2.dispose()
        }
    }

    private companion object {
        const val DISC = 18
    }
}

/** `ColorUtil.withAlpha`, kept local so the rail keeps a [JBColor]'s theme switch. */
private object ColorUtilCompat {
    fun withAlpha(c: java.awt.Color, alpha: Int): java.awt.Color = JBColor.lazy { java.awt.Color(c.red, c.green, c.blue, alpha) }
}
