package io.github.titouanfreville.moonlight.sessions

import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataKey
import com.intellij.openapi.actionSystem.PlatformDataKeys
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.project.DumbAware
import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.core.HeldApproval
import io.github.titouanfreville.moonlight.core.AutoResumeMode
import io.github.titouanfreville.moonlight.core.MoonlightApi
import io.github.titouanfreville.moonlight.core.SessionLaunches

/** A row of the session lists: a group header or a session. */
sealed interface Node {
    data class Group(val group: SessionGroup, val scope: Scope) : Node

    data class Session(
        val session: DiscoverableSession,
        val held: HeldApproval?,
        /** The status bar follows this session. */
        val following: Boolean,
        /** The whole list, so labels disambiguate across groups. */
        val among: List<DiscoverableSession>,
        /** The custom group this row sits in, so "Remove from group" knows which. */
        val groupId: String?,
    ) : Node
}

/** The row an action was invoked on, when it came from the tool window. */
val SELECTED_NODE: DataKey<Node> = DataKey.create("moonlight.sessions.node")

/**
 * The shared shape of every Session Control action: background updates, no indexing
 * needed, and disabled while there is no project.
 *
 * Background, not EDT: the tree's selection reaches `update` through the data context,
 * which the platform snapshots on the EDT before calling it, and the rest is in-memory
 * state. On the EDT, a toolbar of these took seconds to update while the IDE was busy.
 */
abstract class SessionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    protected fun node(e: AnActionEvent): Node? = e.getData(SELECTED_NODE)

    protected fun session(e: AnActionEvent): DiscoverableSession? = (node(e) as? Node.Session)?.session

    /**
     * On a row's context menu, an action shows only where it applies — an inert entry is
     * worse than none. From the toolbar or the palette, it resolves its own target.
     */
    protected fun showOnRow(e: AnActionEvent, applies: Boolean) {
        e.presentation.isEnabledAndVisible = e.project != null && (!e.isFromContextMenu || applies)
    }

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}

class AdoptAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.adopted == false)

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.adopt(e.project ?: return, session(e)?.takeIf { !it.adopted })
    }
}

class SetPhaseAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.adopted == true)

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.setPhase(e.project ?: return, session(e)?.takeIf { it.adopted })
    }
}

class AdvancePhaseAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.adopted == true)

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.advance(e.project ?: return, session(e)?.takeIf { it.adopted })
    }
}

class SetActiveAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        showOnRow(e, session(e) != null)
        if (session(e) != null) e.presentation.text = "Follow This Session"
    }

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.setActive(e.project ?: return, session(e))
    }
}

class StartSessionAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.startSession(e.project ?: return)
    }
}

class ResumeSessionAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.let(SessionOps::canResume) == true)

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.resume(e.project ?: return, session(e))
    }
}

/** Bring the row's herdr pane forward: shown only for a session herdr hosts (cached, so cheap on BGT). */
class ShowInHerdrAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        val project = e.project
        val id = session(e)?.sessionId
        showOnRow(e, project != null && id != null && HerdrService.of(project).cli.hosts(id))
    }

    override fun actionPerformed(e: AnActionEvent) {
        SessionOps.showInHerdr(e.project ?: return, session(e)?.sessionId ?: return)
    }
}

/** Hide the row's session in this project until it works again. */
class HideSessionAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.let(TidyOps::canHide) == true)

    override fun actionPerformed(e: AnActionEvent) {
        TidyOps.hide(e.project ?: return, listOf(session(e)?.sessionId ?: return))
    }
}

/** Forget the row's session in the daemon: its record goes, the transcript stays. */
class ForgetSessionAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, session(e)?.let(TidyOps::canForget) == true)

    override fun actionPerformed(e: AnActionEvent) {
        TidyOps.forget(e.project ?: return, listOf(session(e)?.sessionId ?: return))
    }
}

/** Hide every ended session of the selected group. */
class HideEndedInGroupAction : SessionAction() {
    private fun group(e: AnActionEvent) = (node(e) as? Node.Group)?.group

    override fun update(e: AnActionEvent) {
        val count = group(e)?.let { TidyOps.tidyIn(it).size } ?: 0
        e.presentation.text = "Hide Ended Sessions" + if (count > 0) " ($count)" else ""
        showOnRow(e, count > 0)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val group = group(e) ?: return
        TidyOps.hide(e.project ?: return, TidyOps.tidyIn(group).map { it.sessionId })
    }
}

/** Forget every ended session of the selected group in the daemon. */
class ForgetEndedInGroupAction : SessionAction() {
    private fun group(e: AnActionEvent) = (node(e) as? Node.Group)?.group

    override fun update(e: AnActionEvent) {
        val count = group(e)?.let { TidyOps.forgettableIn(it).size } ?: 0
        e.presentation.text = "Forget Ended Sessions…" + if (count > 0) " ($count)" else ""
        showOnRow(e, count > 0)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val group = group(e) ?: return
        TidyOps.forget(e.project ?: return, TidyOps.forgettableIn(group).map { it.sessionId })
    }
}

/** Pick hidden sessions to show again; the count is in the label. */
class ShowHiddenAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        val project = e.project
        val count = project?.let { SessionControlSettings.of(it).hidden().size } ?: 0
        e.presentation.text = "MoonlightCode: Show Hidden Sessions" + if (count > 0) " ($count)" else ""
        e.presentation.isEnabled = count > 0
        e.presentation.isVisible = project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        TidyOps.showHidden(e.project ?: return)
    }
}

class RemoveEmptyGroupsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        TidyOps.removeEmptyGroups(e.project ?: return)
    }
}

/** Auto-resume on or off for this project — Automatic, or back to the default, Ask. */
class AutoResumeToggleAction : ToggleAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun isSelected(e: AnActionEvent): Boolean =
        e.project?.let { SessionLaunches.of(it).mode() == AutoResumeMode.Automatic } ?: false

    override fun setSelected(e: AnActionEvent, state: Boolean) {
        SessionLaunches.of(e.project ?: return).setMode(if (state) AutoResumeMode.Automatic else AutoResumeMode.Ask)
    }
}

class RefreshSessionsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        MoonlightApi.getInstance().refresh()
    }
}

/**
 * Answer this session's hold. That lives in Agentic Support, which may not be installed —
 * checked rather than assumed, because a dead click on a session that is genuinely stopped
 * is a bad way to learn that.
 */
class ReviewPlanAction : SessionAction() {
    override fun update(e: AnActionEvent) = showOnRow(e, (node(e) as? Node.Session)?.held != null)

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val target = ActionManager.getInstance().getAction(REVIEW_PLAN_ACTION)
        if (target == null) {
            SessionOps.warn(
                project,
                "MoonlightCode Agentic Support is not installed, so a held plan or action cannot be answered from here. " +
                    "Answer it from VS Code or the desktop app until it is.",
            )
            return
        }
        ActionManager.getInstance().tryToExecute(target, e.inputEvent, e.getData(PlatformDataKeys.CONTEXT_COMPONENT), e.place, true)
    }

    companion object {
        const val REVIEW_PLAN_ACTION = "Moonlight.Gate.ReviewPlan"
    }
}

class NewGroupAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val name = SessionOps.promptGroupName(project, "New Session Group") ?: return
        GroupStore.of(project).create(name)
        SessionOps.ensureCustomMode(project)
    }
}

/** Put a session in a group, creating one on the way if there is none yet. */
class AddToGroupAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && session(e)?.adopted == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val session = session(e) ?: return
        val store = GroupStore.of(project)
        val choices = store.custom().map { SessionOps.Choice<String?>(it.name, "${it.sessionIds.size} session(s)", it.id) } +
            SessionOps.Choice<String?>("New group…", "create one and put this session in it", null)
        SessionOps.pick(project, "Add \"${session.title ?: session.sessionId}\" to which group?", choices) { picked ->
            val groupId = picked ?: SessionOps.promptGroupName(project, "New Session Group")?.let { store.create(it).id } ?: return@pick
            store.assign(session.sessionId, groupId)
            SessionOps.ensureCustomMode(project)
        }
    }
}

class RemoveFromGroupAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && (node(e) as? Node.Session)?.groupId != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        GroupStore.of(project).unassign(session(e)?.sessionId ?: return)
    }
}

private fun customGroupId(e: AnActionEvent): String? = ((e.getData(SELECTED_NODE) as? Node.Group)?.group)?.customId

class RenameGroupAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && customGroupId(e) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val id = customGroupId(e) ?: return
        val store = GroupStore.of(project)
        val current = store.custom().firstOrNull { it.id == id }?.name ?: ""
        val name = SessionOps.promptGroupName(project, "Rename Group", current) ?: return
        store.rename(id, name)
    }
}

/** Its sessions are untouched — they fall back to their project group, so nothing is lost. */
class DeleteGroupAction : SessionAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && customGroupId(e) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        GroupStore.of(project).remove(customGroupId(e) ?: return)
    }
}
