package io.github.titouanfreville.moonlight.sessions

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.sessionLabel
import io.github.titouanfreville.moonlight.client.shortId
import io.github.titouanfreville.moonlight.core.HeldApproval
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JPanel

/**
 * The session picked in the lists, under them: its phase rail for a governed session, what
 * adopting would do for one nothing gates. Hidden while no row is picked.
 */
internal class SessionDetail(private val project: Project) : JPanel(BorderLayout()) {
    private val title = JBLabel().apply { font = JBUI.Fonts.label().asBold() }
    private val meta = JBLabel().apply { foreground = UIUtil.getContextHelpForeground() }
    // Clicking the lit disc is not a pick: it would pin the phase and stop auto-advance.
    private val rail = PhaseRail { picked ->
        session?.let { s -> phaseMove(picked, s.phase)?.let { SessionOps.movePhase(project, s, it) } }
    }
    private val note = JBLabel().apply { foreground = UIUtil.getContextHelpForeground(); font = JBUI.Fonts.smallFont() }
    private val next = ActionLink("Next phase") { session?.let { SessionOps.advance(project, it) } }
    private val adopt = ActionLink("Adopt this session") { session?.let { SessionOps.adopt(project, it) } }
    private val footer = JPanel(BorderLayout())
    private var session: DiscoverableSession? = null
    /** What the footer holds now, as (adopted, held): it is rebuilt only when that changes. */
    private var footerShape: Pair<Boolean, Boolean>? = null

    init {
        border = JBUI.Borders.compound(JBUI.Borders.customLineTop(JBColor.border()), JBUI.Borders.empty(6, 8, 6, 8))
        add(JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(8), 0)).apply {
            isOpaque = false
            add(title)
            add(meta)
        }, BorderLayout.NORTH)
        add(rail, BorderLayout.CENTER)
        footer.isOpaque = false
        add(footer, BorderLayout.SOUTH)
        isVisible = false
    }

    fun show(s: DiscoverableSession?, held: HeldApproval?, among: List<DiscoverableSession>) {
        session = s
        isVisible = s != null
        if (s == null) return
        title.text = sessionLabel(s, among.ifEmpty { listOf(s) })
        meta.text = shortId(s.sessionId)
        // Rebuilt only when its links change: show() runs on every poll, and removing the
        // focused link would drop keyboard focus from Next phase or Adopt each time.
        val shape = s.adopted to (held != null)
        if (shape != footerShape) {
            footerShape = shape
            footer.removeAll()
            footer.add(note, BorderLayout.CENTER)
            when {
                !s.adopted -> footer.add(adopt, BorderLayout.EAST)
                held == null -> footer.add(next, BorderLayout.EAST)
            }
        }
        if (!s.adopted) {
            rail.isVisible = false
            note.text = "Nothing gates this session: it can write anywhere."
        } else {
            rail.isVisible = true
            // Only on change: the setter moves the keyboard focus back to the current phase.
            if (rail.phase != s.phase) rail.phase = s.phase
            // A hold is answered first: moving the phase under it would only confuse the agent.
            rail.isEnabled = held == null
            rail.toolTipText = if (held != null) "Answer what the session is waiting on first" else ""
            note.text = when {
                held != null -> "Waiting on you: answer it from the banner above."
                s.phase.frozen -> "Project files are read-only. Notes stay writable."
                else -> "Project files are writable."
            }
        }
        revalidate()
        repaint()
    }
}

/**
 * The session picked in Sessions, for the Review and AI Review tabs to open on. Shared by
 * a project property rather than a class: those tabs live in AI Review, which must not
 * need a class from a newer Session Control (the plugins update one at a time). AI Review
 * reads the same key; keep the two in step.
 */
internal object SessionsSelection {
    const val KEY = "moonlight.sessions.selected"

    /**
     * Publish an explicit pick. Stamped, so picking the same row again is news too: after
     * Review moved elsewhere, re-picking the row must bring it back.
     */
    fun publish(project: Project, sessionId: String) {
        PropertiesComponent.getInstance(project).setValue(KEY, pickToken(sessionId, System.nanoTime()))
    }
}

/** A pick as stored: `<session id>|<stamp>`. AI Review reads the id before the bar. */
internal fun pickToken(sessionId: String, stamp: Long): String = "$sessionId|$stamp"
