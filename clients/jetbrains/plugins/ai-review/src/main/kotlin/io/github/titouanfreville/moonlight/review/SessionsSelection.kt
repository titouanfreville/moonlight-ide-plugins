package io.github.titouanfreville.moonlight.review

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.ui.content.ContentManagerEvent
import com.intellij.ui.content.ContentManagerListener
import javax.swing.JComponent

/** Run `then` each time the tab holding `component` is brought to the front. */
internal fun whenTabShown(toolWindow: ToolWindow, component: JComponent, parent: Disposable, then: () -> Unit) {
    val manager = toolWindow.contentManager
    val listener = object : ContentManagerListener {
        override fun selectionChanged(event: ContentManagerEvent) {
            if (event.operation == ContentManagerEvent.ContentOperation.add && event.content.component === component) then()
        }
    }
    manager.addContentManagerListener(listener)
    Disposer.register(parent) { manager.removeContentManagerListener(listener) }
}

/**
 * The session picked in the Sessions tab, which Review and AI Review open on. Session
 * Control writes it to a project property (its own `SessionsSelection`), not through a
 * class, so this plugin works beside any Session Control version, or none. Keep the key
 * in step with it.
 */
internal class SessionsSelection(private val read: () -> String?) {
    constructor(project: Project) : this({ PropertiesComponent.getInstance(project).getValue(KEY) })

    /**
     * The last pick this tab saw: a newer one moves the tab, the same one leaves it be.
     * Starts at what is stored already — the property persists, and a pick left from
     * before a restart is not news: it would move the tabs away from their default.
     */
    private var seen: String? = read()

    /**
     * The session picked in Sessions since this tab last took a pick, when `accept` takes
     * it. A refused pick stays unseen, so a session picked before it was adopted (or before
     * its review appeared) still moves the tab once it qualifies.
     */
    fun fresh(accept: (String) -> Boolean): String? {
        val now = read() ?: return null
        if (now == seen) return null
        val id = pickedSession(now)
        if (!accept(id)) return null
        seen = now
        return id
    }

    internal companion object {
        /** Session Control writes this key (its own `SessionsSelection.KEY`): keep the two equal. */
        const val KEY = "moonlight.sessions.selected"
    }
}

/**
 * The session in a stored pick: `<session id>|<stamp>` from Session Control, which stamps
 * each pick so re-picking a row is news. A bare id (an older Session Control) reads as is.
 */
internal fun pickedSession(token: String): String = token.substringBefore('|')
