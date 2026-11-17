package io.github.titouanfreville.moonlight.sessions

import com.intellij.openapi.components.BaseState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.SimplePersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.util.messages.Topic

/**
 * The project's Session Control settings — `moonlight.sessions.groupBy` and
 * `moonlight.session.autoAdopt` in VS Code terms. Per checkout, never shared through VCS:
 * how you arrange your sidebar and whether this window adopts on its own are yours.
 */
@Service(Service.Level.PROJECT)
@State(name = "MoonlightSessionControl", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class SessionControlSettings : SimplePersistentStateComponent<SessionControlSettings.Options>(Options()) {
    class Options : BaseState() {
        var groupBy by enum(GroupBy.Project)

        /**
         * Adopt this window's new sessions automatically. Off by default: an auto-adopted
         * session lands on `Plan`, where project writes are denied, so a new session stops
         * until you act.
         */
        var autoAdopt by property(false)

        /** Where "Start Governed Claude Session" runs Claude Code: `moonlight.sessions.startIn`. */
        var startIn by enum(StartIn.Ask)

        /** The `herdr` binary; empty to find it on PATH and the usual folders. */
        var herdrPath by string("")

        /** Start herdr sessions where this project's last one went, without asking. */
        var herdrReuseLast by property(false)

        /** The herdr workspace this project's last session went to. */
        var herdrLastWorkspace by string(null)

        /** Sessions hidden in this project → when (epoch ms). See `Tidy.kt` for when they come back. */
        var hidden by map<String, Long>()
    }

    fun hidden(): Map<String, Long> = state.hidden.toMap()

    // Each change assigns a new map: the setter is what records the change for saving
    // (mutating the map in place would not, and the platform's counter is internal API).
    fun hide(project: Project, ids: List<String>) {
        val now = System.currentTimeMillis()
        state.hidden = (state.hidden + ids.associateWith { now }).toMutableMap()
        SessionViewListener.fire(project)
    }

    fun unhide(project: Project, ids: List<String>) {
        if (ids.none { it in state.hidden }) return
        state.hidden = (state.hidden - ids.toSet()).toMutableMap()
        SessionViewListener.fire(project)
    }

    /** Replace the hidden list after a reconcile; no event, the redraw that asked is already running. */
    fun setHidden(hidden: Map<String, Long>) {
        state.hidden = hidden.toMutableMap()
    }

    fun groupBy(): GroupBy = state.groupBy

    fun setGroupBy(project: Project, mode: GroupBy) {
        state.groupBy = mode
        SessionViewListener.fire(project)
    }

    fun autoAdopt(): Boolean = state.autoAdopt

    companion object {
        fun of(project: Project): SessionControlSettings = project.service()
    }
}

/** Where a session we start runs. */
enum class StartIn(val label: String) {
    Ask("Ask each time, when herdr is running"),
    Terminal("An IDE terminal (ends with the IDE)"),
    Herdr("A herdr pane (outlives the IDE)"),
}

/** The session lists' arrangement moved — grouping mode or custom groups. */
fun interface SessionViewListener {
    fun changed()

    companion object {
        @JvmField
        @Topic.ProjectLevel
        val TOPIC: Topic<SessionViewListener> = Topic(SessionViewListener::class.java, Topic.BroadcastDirection.NONE)

        fun fire(project: Project) = project.messageBus.syncPublisher(TOPIC).changed()
    }
}
