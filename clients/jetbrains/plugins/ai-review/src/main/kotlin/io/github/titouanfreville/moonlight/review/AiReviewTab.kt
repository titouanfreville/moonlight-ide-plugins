package io.github.titouanfreville.moonlight.review

import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.ui.CollectionListModel
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.OnePixelSplitter
import com.intellij.openapi.util.text.StringUtil
import com.intellij.util.ui.HTMLEditorKitBuilder
import javax.swing.JEditorPane
import javax.swing.event.HyperlinkEvent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import io.github.titouanfreville.moonlight.client.sessionLabel
import io.github.titouanfreville.moonlight.core.ModEntry
import io.github.titouanfreville.moonlight.core.ModFinding
import io.github.titouanfreville.moonlight.core.MoonlightApi
import io.github.titouanfreville.moonlight.core.MoonlightListener
import io.github.titouanfreville.moonlight.core.MoonlightToolWindow
import io.github.titouanfreville.moonlight.core.MoonlightToolWindowTab
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.nio.file.Path
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListSelectionModel

/**
 * The AI review of a session the MoonlightCode mod governs — the JetBrains side of VS
 * Code's `ai-review-view.ts`: run a review skill, then triage what it found (keep,
 * dismiss, keep with a note) and send the kept findings with the line comments, or accept
 * the review. The mod runs the skill in the session; this tab shows its review and hands
 * each decision to it. The daemon has no findings, so its sessions are not offered.
 */
class AiReviewTab : MoonlightToolWindowTab {
    override val title: String = TITLE
    override val icon: javax.swing.Icon = AllIcons.Actions.IntentionBulb

    override fun createComponent(project: Project, toolWindow: ToolWindow, parent: Disposable): JComponent =
        AiReviewPanel(project).also { Disposer.register(parent, it) }

    companion object {
        const val TITLE = "AI Review"

        internal val REQUESTED = Key.create<String>("moonlight.aiReview.requested")
        internal val PANEL = Key.create<AiReviewPanel>("moonlight.aiReview.panel")

        /** Open the tab on `sessionId`, or on the session it would pick anyway. */
        fun show(project: Project, sessionId: String?) {
            sessionId?.let { project.putUserData(REQUESTED, it) }
            MoonlightToolWindow.select(project, TITLE)
            // A tab built just now reads the request itself; one already built is told.
            ApplicationManager.getApplication().invokeLater { project.getUserData(PANEL)?.render() }
        }
    }
}

private class SessionChoice(val sessionId: String, val label: String) {
    override fun toString() = label
}

internal class AiReviewPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val core = MoonlightApi.getInstance()
    private val sessions = ComboBox(DefaultComboBoxModel<SessionChoice>())
    private val skills = ComboBox(DefaultComboBoxModel<String>())
    // What the run reviews: an empty scope gives the skill nothing to read.
    private val scope = ComboBox(DefaultComboBoxModel(SCOPES.keys.toTypedArray()))
    private var settingScope = false
    private val run = JButton(AllIcons.Actions.Execute)
    private val cancel = JButton(AllIcons.Actions.Suspend)
    // Wrapped: a run's status can be a long refusal or error from the mod.
    private val status = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
        isOpaque = false
        font = JBUI.Fonts.label()
    }
    private val model = CollectionListModel<ModFinding>()
    private val list = JBList(model)
    private val keep = JButton(AllIcons.General.Add)
    private val dismiss = JButton(AllIcons.Actions.Cancel)
    private val note = JButton(AllIcons.Actions.Edit)
    private val counts = JBLabel()
    // The selected finding in full, wrapped: a list row holds one line only.
    private val detail = JEditorPane().apply {
        editorKit = HTMLEditorKitBuilder.simple()
        isEditable = false
        border = JBUI.Borders.empty(6, 8)
    }
    private val send = JButton(AllIcons.Actions.Upload)
    private val accept = JButton(AllIcons.Actions.Checked)
    private val sessionLabel = JBLabel("Session:")
    private val reviewerLabel = JBLabel("Reviewer:")
    @Volatile private var busy = false

    /** Each button's full text: shown when there is room, in the tooltip always. */
    private val labels = mutableMapOf(
        run to "Run AI review",
        cancel to "Cancel",
        keep to "Keep",
        dismiss to "Dismiss",
        note to "Note…",
        send to "Send review",
        accept to "Accept, all good",
    )

    /** Icons alone, below the width the full labels need — as the window's tabs do. */
    private var compact = false

    init {
        // The actions sit at the rows' ends and the lists take what is left: a FlowLayout
        // row hides what does not fit, and a long session label once pushed Run out of sight.
        val sessionRow = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
            border = JBUI.Borders.empty(4, 8, 0, 8)
            add(sessionLabel, BorderLayout.WEST)
            add(sessions, BorderLayout.CENTER)
            add(scope, BorderLayout.EAST)
        }
        val runRow = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
            border = JBUI.Borders.empty(4, 8)
            add(reviewerLabel, BorderLayout.WEST)
            add(skills, BorderLayout.CENTER)
            add(JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(4), 0)).apply { add(run); add(cancel) }, BorderLayout.EAST)
        }
        val head = JPanel(BorderLayout()).apply {
            add(sessionRow, BorderLayout.NORTH)
            add(runRow, BorderLayout.CENTER)
            add(status.apply { border = JBUI.Borders.empty(0, 8, 4, 8) }, BorderLayout.SOUTH)
        }
        sessions.prototypeDisplayValue = SessionChoice("", "A session label")
        skills.prototypeDisplayValue = "a-review-skill"
        list.selectionMode = ListSelectionModel.SINGLE_SELECTION
        list.cellRenderer = FindingRenderer()
        list.emptyText.text = "No findings yet. Run a review skill, or comment lines in the diff."
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) list.selectedValue?.let(::openFinding)
            }
        })
        val findingActions = JPanel(FlowLayout(FlowLayout.LEFT)).apply {
            add(keep)
            add(dismiss)
            add(note)
        }
        val foot = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.customLineTop(JBColor.border())
            add(counts.apply { border = JBUI.Borders.empty(0, 8) }, BorderLayout.CENTER)
            add(JPanel(FlowLayout(FlowLayout.RIGHT)).apply { add(send); add(accept) }, BorderLayout.EAST)
        }
        relabel()
        addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) = relabel()
        })
        add(head, BorderLayout.NORTH)
        detail.addHyperlinkListener { e ->
            if (e.eventType == HyperlinkEvent.EventType.ACTIVATED) list.selectedValue?.let(::openFinding)
        }
        add(OnePixelSplitter(true, 0.5f).apply {
            firstComponent = JBScrollPane(list)
            secondComponent = JBScrollPane(detail)
        }, BorderLayout.CENTER)
        add(JPanel(BorderLayout()).apply { add(findingActions, BorderLayout.NORTH); add(foot, BorderLayout.SOUTH) }, BorderLayout.SOUTH)

        sessions.addActionListener { render() }
        scope.renderer = com.intellij.ui.SimpleListCellRenderer.create("") { SCOPES[it].orEmpty() }
        scope.addActionListener {
            if (!settingScope) (scope.selectedItem as? String)?.let { act(ModEntry.ReviewScope(it)) }
        }
        list.addListSelectionListener { renderSelection() }
        run.addActionListener { skills.selectedItem?.let { act(ModEntry.ReviewRun(it as String), announce = true) } }
        cancel.addActionListener { act(ModEntry.ReviewCancel) }
        keep.addActionListener { list.selectedValue?.let { act(ModEntry.Finding(it.id, "keep")) } }
        dismiss.addActionListener { list.selectedValue?.let { act(ModEntry.Finding(it.id, "dismiss")) } }
        note.addActionListener { list.selectedValue?.let(::editNote) }
        send.addActionListener { act(ModEntry.ReviewSubmit(), announce = true) }
        accept.addActionListener { act(ModEntry.ReviewAccept, announce = true) }

        ApplicationManager.getApplication().messageBus.connect(this).subscribe(MoonlightListener.TOPIC, object : MoonlightListener {
            // The mod republishes its review every two seconds at most; the poll carries it.
            override fun sessionsChanged() = render()
        })
        project.putUserData(AiReviewTab.PANEL, this)
        render()
    }

    private fun selectedSession(): String? = (sessions.selectedItem as? SessionChoice)?.sessionId

    /** Redraw from the mod's review, keeping the session and the finding picked. */
    fun render() {
        val all = core.sessions()
        val mod = all.filter { ReviewSource.isModSession(it.sessionId) }
        val requested = project.getUserData(AiReviewTab.REQUESTED)?.also { project.putUserData(AiReviewTab.REQUESTED, null) }
        val keepSession = requested ?: selectedSession() ?: core.activeSession(project)?.sessionId
        val choices = mod.map { SessionChoice(it.sessionId, sessionLabel(it, all)) }
        if (choices.map { it.sessionId } != (0 until sessions.itemCount).map { sessions.getItemAt(it).sessionId }) {
            sessions.model = DefaultComboBoxModel(choices.toTypedArray())
            choices.firstOrNull { it.sessionId == keepSession }?.let { sessions.selectedItem = it }
        } else if (requested != null) {
            choices.firstOrNull { it.sessionId == requested }?.let { sessions.selectedItem = it }
        }
        val sessionId = selectedSession()
        val review = sessionId?.let { ReviewSource.modReview(it) }
        if (review == null) {
            status.text = if (mod.isEmpty()) {
                "AI review runs in sessions the MoonlightCode plugin for Claude Code governs, and none is running."
            } else {
                "This session's Claude Code plugin publishes no review yet: update the plugin."
            }
            model.replaceAll(emptyList())
            listOf(scope, skills, run, cancel, send, accept).forEach { it.isEnabled = false }
            counts.text = ""
            renderSelection()
            return
        }
        val running = review.runningSkill
        status.text = when {
            running != null -> "Running $running… its findings land here."
            review.findingsStatus != null -> review.findingsStatus
            review.skills.isEmpty() -> "No review skill is installed in this session."
            else -> " "
        }
        if (scope.selectedItem != review.scope) {
            settingScope = true
            scope.selectedItem = review.scope
            settingScope = false
        }
        scope.isEnabled = running == null && !busy
        scope.toolTipText = "Reviewing ${SCOPES[review.scope] ?: review.scope}: ${review.files.size} file${if (review.files.size == 1) "" else "s"}"
        if (review.skills != (0 until skills.itemCount).map { skills.getItemAt(it) }) {
            skills.model = DefaultComboBoxModel(review.skills.toTypedArray())
        }
        skills.isEnabled = running == null && review.skills.isNotEmpty()
        run.isEnabled = skills.isEnabled && !busy
        cancel.isVisible = running != null
        cancel.isEnabled = !busy
        val picked = list.selectedValue?.id
        val sorted = ModReviewMapping.sortedFindings(review.findings)
        if (sorted != model.items) model.replaceAll(sorted)
        sorted.indexOfFirst { it.id == picked }.takeIf { it >= 0 }?.let { list.selectedIndex = it }
        val c = ModReviewMapping.counts(review)
        val pending = c.comments + c.kept
        counts.text = "${c.kept} kept · ${c.dismissed} dismissed · ${c.comments} line comment${if (c.comments == 1) "" else "s"}"
        labels[send] = "Send review ($pending)"
        relabel()
        send.isEnabled = pending > 0 && !busy
        accept.isEnabled = pending == 0 && !busy
        accept.toolTipText = if (pending > 0) "Send or dismiss what is pending first" else labels[accept]
        renderSelection()
    }

    /**
     * Full labels when the widest row fits them, icons alone otherwise — measured from the
     * labels, as the window's tabs are. The tooltips keep the full text either way.
     */
    private fun relabel() {
        val metrics = getFontMetrics(run.font)
        fun needs(vararg buttons: JButton) = buttons.sumOf { metrics.stringWidth(labels.getValue(it)) + JBUI.scale(BUTTON_CHROME) }
        val needed = maxOf(
            metrics.stringWidth(reviewerLabel.text) + JBUI.scale(MIN_LIST) + needs(run, cancel),
            JBUI.scale(MIN_COUNTS) + needs(send, accept),
            needs(keep, dismiss, note),
        )
        compact = width in 1 until needed
        for ((button, text) in labels) {
            // A count still matters when the label goes: Send keeps it.
            button.text = when {
                !compact -> text
                button === send -> text.substringAfter("(", "").removeSuffix(")")
                else -> ""
            }
            button.toolTipText = text
        }
        sessionLabel.isVisible = !compact
        reviewerLabel.isVisible = !compact
    }

    private fun renderSelection() {
        val f = list.selectedValue
        val shown = f?.let(::detailHtml) ?: "<html><body><i>Select a finding to read it in full.</i></body></html>"
        if (detail.text != shown) {
            detail.text = shown
            detail.caretPosition = 0
        }
        keep.isEnabled = f != null && f.decision == "dismiss" && !busy
        dismiss.isEnabled = f != null && f.decision == "keep" && !busy
        note.isEnabled = f != null && !busy
    }

    /** One decision to the mod, off the EDT; a refusal is shown in the mod's own words. */
    private fun act(entry: ModEntry, announce: Boolean = false) {
        val sessionId = selectedSession() ?: return
        if (busy) return
        busy = true
        render()
        // The result is caught here, not by `background`: the buttons come back either way.
        ReviewOps.background(project, "AI review", { runCatching { ReviewSource.send(sessionId, entry) } }) { result ->
            busy = false
            render()
            result.fold(
                { said -> if (announce) ReviewOps.notify(project, said) },
                { e -> ReviewOps.notify(project, "AI review: ${e.message}", NotificationType.ERROR) },
            )
        }
    }

    /** Summary, detail, fix and note, wrapped; the place links to the file at that line. */
    private fun detailHtml(f: ModFinding): String {
        fun esc(s: String) = StringUtil.escapeXmlEntities(s).replace("\n", "<br>")
        val parts = buildList {
            add("<b>${esc(f.severity.replaceFirstChar { it.uppercase() })}</b> · <a href=\"open\">${esc("${f.file}:${f.line}")}</a> · ${esc(f.route)}" +
                if (f.decision == "dismiss") " · <i>dismissed</i>" else "")
            add("<p><b>${esc(f.summary)}</b></p>")
            if (f.detail.isNotBlank()) add("<p>${esc(f.detail)}</p>")
            f.fix?.takeIf { it.isNotBlank() }?.let { add("<p><b>Suggested fix</b><br><code>${esc(it)}</code></p>") }
            f.note?.let { add("<p><b>Your note</b><br>${esc(it)}</p>") }
        }
        return "<html><body>${parts.joinToString("")}</body></html>"
    }

    /** A note keeps the finding: it is what the agent is asked to act on. */
    private fun editNote(f: ModFinding) {
        val text = Messages.showMultilineInputDialog(
            project, "What should the agent do about it? (${f.file}:${f.line})", "Note on Finding", f.note ?: "", null, null,
        ) ?: return
        act(ModEntry.Finding(f.id, "keep", text.trim()))
    }

    private fun openFinding(f: ModFinding) {
        val root = core.sessions().firstOrNull { it.sessionId == selectedSession() }?.root
        val path = Path.of(f.file).let { if (it.isAbsolute || root == null) it else Path.of(root).resolve(it) }
        val file = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path) ?: run {
            ReviewOps.notify(project, "${f.file} is not on disk any more.")
            return
        }
        OpenFileDescriptor(project, file, maxOf(f.line - 1, 0), 0).navigate(true)
    }

    private companion object {
        /** The mod's scopes, as the combo reads them. */
        val SCOPES = linkedMapOf("session" to "This session's changes", "head" to "Since the last commit")
        /** A button's padding and icon, besides its text. */
        const val BUTTON_CHROME = 48
        /** The narrowest a list or the counts may get before the labels go. */
        const val MIN_LIST = 120
        const val MIN_COUNTS = 140
    }

    override fun dispose() {
        if (project.getUserData(AiReviewTab.PANEL) === this) project.putUserData(AiReviewTab.PANEL, null)
    }
}

/** Severity first, then place and summary; the note and a dismissal show beneath. */
private class FindingRenderer : ColoredListCellRenderer<ModFinding>() {
    override fun customizeCellRenderer(list: JList<out ModFinding>, value: ModFinding, index: Int, selected: Boolean, hasFocus: Boolean) {
        val dismissed = value.decision == "dismiss"
        val color = when (value.severity) {
            "high" -> JBColor.RED
            "medium" -> JBColor.ORANGE
            else -> JBColor.BLUE
        }
        val style = if (dismissed) SimpleTextAttributes.STYLE_STRIKEOUT else SimpleTextAttributes.STYLE_BOLD
        append(value.severity.replaceFirstChar { it.uppercase() } + "  ", SimpleTextAttributes(style, color))
        append("${value.file}:${value.line}  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
        append(value.summary, if (dismissed) SimpleTextAttributes.GRAYED_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES)
        value.note?.let { append("   ✎ $it", SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES) }
        if (dismissed) append("   dismissed", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        toolTipText = listOfNotNull(value.detail.takeIf { it.isNotBlank() }, value.fix?.let { "Suggested fix: $it" }).joinToString("\n\n").ifEmpty { null }
    }
}
