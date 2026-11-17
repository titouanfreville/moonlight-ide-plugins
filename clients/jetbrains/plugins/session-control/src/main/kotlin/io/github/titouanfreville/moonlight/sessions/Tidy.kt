package io.github.titouanfreville.moonlight.sessions

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.SessionStatus
import io.github.titouanfreville.moonlight.client.controlBaseUrl
import io.github.titouanfreville.moonlight.client.sessionLabel
import io.github.titouanfreville.moonlight.client.shortId
import io.github.titouanfreville.moonlight.core.Governor
import io.github.titouanfreville.moonlight.core.MoonlightApi
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * Tidying the session lists — the JetBrains side of VS Code's `tidy.ts`; keep the rules in
 * step. The daemon keeps every session it managed, so sessions that ended days ago stay
 * listed. Forget deletes the daemon's record (the transcript stays, and the session comes
 * back only if it works again). Hide is local to this project, and lasts until the session
 * does something: works, or waits on the operator. Not a newer activity time — a finished
 * turn cooling from waiting to idle bumps that too, and would unhide it two minutes later.
 */

/** Hidden ids kept at most: a list of ids nobody sees should not grow forever. */
const val HIDDEN_CAP = 500

/** Working, waiting on the operator, or holding an answer: never tidied away. */
fun isLive(session: DiscoverableSession, held: Boolean): Boolean =
    held || session.status == SessionStatus.Running || session.status == SessionStatus.WaitingInput

/** Why a session cannot be hidden or forgotten, or null when it can. */
fun tidyBlocker(session: DiscoverableSession, held: Boolean): String? = when {
    held -> "It is waiting on you: answer it first."
    session.status == SessionStatus.Running -> "It is working."
    session.status == SessionStatus.WaitingInput -> "It is waiting for input."
    else -> null
}

/**
 * The hidden list after a poll: a hidden session that is live again is visible again, for
 * good. Ids no longer listed are kept — a daemon restart briefly lists nothing — up to
 * [HIDDEN_CAP], the oldest dropped first. Null when nothing changed.
 */
fun reconcileHidden(hidden: Map<String, Long>, sessions: List<DiscoverableSession>, heldIds: Set<String>): Map<String, Long>? {
    val byId = sessions.associateBy { it.sessionId }
    val kept = hidden.filter { (id, _) -> byId[id]?.let { !isLive(it, id in heldIds) } ?: true }
    val capped = kept.entries.sortedByDescending { it.value }.take(HIDDEN_CAP).associate { it.key to it.value }
    return capped.takeIf { it.size != hidden.size }
}

/** Custom groups none of whose sessions is known any more. */
fun emptyGroups(groups: List<CustomGroup>, sessions: List<DiscoverableSession>): List<CustomGroup> {
    val known = sessions.mapTo(HashSet()) { it.sessionId }
    return groups.filter { g -> g.sessionIds.none { it in known } }
}

/** Why the daemon cannot forget a session, or null. The Claude Code plugin's sessions leave on their own. */
fun forgetBlocker(session: DiscoverableSession, held: Boolean, daemonDown: Boolean, governor: Governor): String? = when {
    daemonDown -> "No MoonlightCode daemon is answering."
    governor == Governor.Mod -> "The Claude Code plugin governs it: it leaves the list when it ends."
    else -> tidyBlocker(session, held)
}

/** What a refused forget means, in the operator's terms. */
fun forgetError(status: Int): String = when (status) {
    404 -> "the daemon does not know it (or predates forgetting: update moonlightd)"
    409 -> "it is working or waiting on you"
    else -> "HTTP $status"
}

/**
 * `POST /control/forget`, here rather than in the control client: the client ships with
 * core, and a method this plugin needed from a newer core would be missing beside an older
 * one. Loopback only and never through the IDE's proxy, like the client. Blocking.
 */
object DaemonForget {
    private val http: HttpClient = HttpClient.newBuilder()
        .proxy(HttpClient.Builder.NO_PROXY)
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    /** Null when forgotten, else why not. */
    fun forget(sessionId: String): String? {
        val base = controlBaseUrl() ?: return "No MoonlightCode daemon is answering."
        val body = """{"session_id":${com.google.gson.JsonPrimitive(sessionId)}}"""
        val request = HttpRequest.newBuilder(URI.create("$base/control/forget"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build()
        return try {
            val status = http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode()
            if (status in 200..299) null else forgetError(status)
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        }
    }
}

/** Hide, forget, show again, drop empty groups — what the actions call. */
object TidyOps {
    private val core: MoonlightApi get() = MoonlightApi.getInstance()

    private fun held(): Set<String> = core.heldApprovals().mapTo(HashSet()) { it.sessionId }

    private fun label(id: String, sessions: List<DiscoverableSession>): String =
        sessions.firstOrNull { it.sessionId == id }?.let { sessionLabel(it, sessions) } ?: shortId(id)

    fun canHide(session: DiscoverableSession): Boolean = tidyBlocker(session, session.sessionId in held()) == null

    fun canForget(session: DiscoverableSession): Boolean =
        forgetBlocker(session, session.sessionId in held(), core.backendError() != null, core.governor(session.sessionId)) == null

    fun hide(project: Project, ids: List<String>) {
        val sessions = core.sessions()
        val holds = held()
        val blocked = ids.mapNotNull { id -> sessions.firstOrNull { it.sessionId == id }?.let { s -> tidyBlocker(s, id in holds)?.let { id to it } } }.toMap()
        val hiding = ids.filter { it !in blocked }
        if (hiding.isNotEmpty()) SessionControlSettings.of(project).hide(project, hiding)
        if (blocked.isNotEmpty()) SessionOps.info(project, "Not hidden — " + blocked.entries.joinToString("; ") { "${label(it.key, sessions)}: ${it.value}" })
    }

    /** Ask, then forget in the daemon (off the EDT). Call on the EDT. */
    fun forget(project: Project, ids: List<String>) {
        if (ids.isEmpty()) return
        val sessions = core.sessions()
        val what = if (ids.size == 1) "\"${label(ids.single(), sessions)}\"" else "${ids.size} sessions"
        val go = Messages.showOkCancelDialog(
            project,
            "The MoonlightCode daemon deletes its record, so it leaves the list everywhere. The transcript stays, and the session comes back only if it works again.",
            "Forget $what?",
            "Forget",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (go != Messages.OK) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val failed = ids.mapNotNull { id -> DaemonForget.forget(id)?.let { id to it } }.toMap()
            SessionControlSettings.of(project).unhide(project, ids.filter { it !in failed })
            core.refresh()
            if (failed.isNotEmpty()) SessionOps.warn(project, "Not forgotten — " + failed.entries.joinToString("; ") { "${label(it.key, sessions)}: ${it.value}" })
        }
    }

    /** The sessions of a group that can be hidden, and of those the ones the daemon can forget. */
    fun tidyIn(group: SessionGroup): List<DiscoverableSession> = group.sessions.filter(::canHide)

    fun forgettableIn(group: SessionGroup): List<DiscoverableSession> = group.sessions.filter(::canForget)

    /** Pick hidden sessions to show again. Call on the EDT. */
    fun showHidden(project: Project) {
        val settings = SessionControlSettings.of(project)
        val ids = settings.hidden().keys.toList()
        if (ids.isEmpty()) return SessionOps.info(project, "No session is hidden in this project.")
        val sessions = core.sessions()
        val all = SessionOps.Choice("Show all of them again", "${ids.size} hidden", ids)
        val each = ids.map { id ->
            val s = sessions.firstOrNull { it.sessionId == id }
            SessionOps.Choice(label(id, sessions), s?.let { "${if (it.adopted) "governed" else "not gated"} · ${it.status}" } ?: "no longer listed", listOf(id))
        }
        SessionOps.pick(project, "Show which session again?", listOf(all) + each) { settings.unhide(project, it) }
    }

    /** Remove custom groups none of whose sessions is listed any more, after asking. Call on the EDT. */
    fun removeEmptyGroups(project: Project) {
        val store = GroupStore.of(project)
        val empty = emptyGroups(store.custom(), core.sessions())
        if (empty.isEmpty()) return SessionOps.info(project, "No custom group is empty.")
        val go = Messages.showOkCancelDialog(
            project,
            empty.joinToString(", ") { it.name },
            if (empty.size == 1) "Remove the empty group?" else "Remove ${empty.size} empty groups?",
            "Remove",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (go != Messages.OK) return
        empty.forEach { store.remove(it.id) }
        SessionViewListener.fire(project)
    }
}
