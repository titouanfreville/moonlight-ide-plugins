package io.github.titouanfreville.moonlight.sessions

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.Phase
import io.github.titouanfreville.moonlight.client.SessionStatus
import io.github.titouanfreville.moonlight.client.sessionLabel
import io.github.titouanfreville.moonlight.client.shortId
import io.github.titouanfreville.moonlight.core.ActiveSession
import io.github.titouanfreville.moonlight.core.Governor
import io.github.titouanfreville.moonlight.core.ModEntry
import io.github.titouanfreville.moonlight.core.MoonlightApi
import io.github.titouanfreville.moonlight.core.SessionLaunches
import io.github.titouanfreville.moonlight.core.describePanelKey
import io.github.titouanfreville.moonlight.core.isInside
import io.github.titouanfreville.moonlight.core.projectFolders
import java.util.UUID

/**
 * The operator actions behind every Session Control surface — tool window rows, the
 * toolbar, the status widget's click, the palette. One implementation each, so a session
 * adopted from the tree and one adopted from the status bar go through the same words.
 *
 * Control-API calls are blocking, so each runs on a pooled thread; popups and dialogs run
 * on the EDT, which is where every entry point here is called from.
 */
object SessionOps {
    private val core: MoonlightApi get() = MoonlightApi.getInstance()

    /**
     * How long to wait for detection to notice a session we just launched, before telling
     * the operator it is ungoverned. A fresh session writes nothing until it is prompted.
     */
    private const val ADOPT_POLL_MS = 750L
    private const val ADOPT_ATTEMPTS = 20

    /** Adopt a session, from a row or a picker of the unadopted ones. */
    fun adopt(project: Project, session: DiscoverableSession?) {
        if (session != null) {
            if (core.governor(session.sessionId) == Governor.Mod) {
                info(project, MOD_GOVERNED_ADOPT)
                return
            }
            doAdopt(project, session, linkPanel = false)
            return
        }
        val all = core.sessions()
        // A session the mod governs keeps its own gate: not a candidate.
        val candidates = all.filter { !it.adopted && core.governor(it.sessionId) != Governor.Mod }
        if (candidates.isEmpty()) {
            info(
                project,
                if (all.isEmpty()) "No Claude Code sessions detected yet. Run `claude` somewhere and wait a few seconds."
                else "Every detected session is already governed, by the daemon or by the MoonlightCode plugin inside Claude Code.",
            )
            return
        }
        pick(project, "Adopt a Claude Code session into MoonlightCode governance", candidates.map { s ->
            Choice(sessionLabel(s, candidates), s.root ?: s.sessionId, s)
        }) { doAdopt(project, it, linkPanel = true) }
    }

    private fun doAdopt(project: Project, session: DiscoverableSession, linkPanel: Boolean) = background(project) {
        core.control.adopt(session.sessionId)
        onEdt {
            // Adopting while an agent tab is in front is a statement about that tab: it is
            // the session you are working in. Recording it lets several tabs each track
            // their own session instead of sharing one project-wide guess.
            val linked = linkPanel && core.pinToActivePanel(project, session.sessionId)
            core.refresh()
            info(
                project,
                "Adopted \"${sessionLabel(session, core.sessions())}\" — it starts in Plan, where project writes are denied." +
                    (if (linked) " Linked to the tab in front of you — the status bar now follows it." else "") +
                    " Gating applies from its next tool call.",
            )
        }
    }

    /**
     * Change a session's phase. With no session named, the active one — clicking the phase
     * indicator should change *that* phase, not ask which session it was about.
     */
    fun setPhase(project: Project, session: DiscoverableSession?) {
        val target = session ?: activeAdopted(project)
        if (target != null) {
            pickPhase(project, target)
            return
        }
        pickAdopted(project, "Set the phase of which session?") { pickPhase(project, it) }
    }

    fun pickPhase(project: Project, session: DiscoverableSession) {
        val label = sessionLabel(session, core.sessions())
        pick(project, "Move \"$label\" from ${phaseLabel(session.phase)} to…", Phase.ORDERED.map { phase ->
            Choice(
                phaseLabel(phase) + if (phase == session.phase) " (current)" else "",
                if (phase.frozen) "project writes denied" else "project writes allowed",
                phase,
            )
        }) { phase -> movePhase(project, session, phase) }
    }

    /**
     * Move a session to `phase` without asking — the phase rail's click, where the pick is the
     * click. Picking the current phase pins it, as the picker's "(current)" choice does.
     */
    fun movePhase(project: Project, session: DiscoverableSession, phase: Phase) {
        val label = sessionLabel(session, core.sessions())
        background(project) {
            setSessionPhase(session.sessionId, phase)
            core.refresh()
            info(project, "\"$label\" → ${phaseLabel(phase)}. The phase is pinned now: a manual pick overrides auto-advance.")
        }
    }

    /** Advance to the next phase and return the session to auto (clears any pin). */
    fun advance(project: Project, session: DiscoverableSession?) {
        val target = session ?: activeAdopted(project)
        if (target == null) {
            pickAdopted(project, "Advance which session?") { advance(project, it) }
            return
        }
        background(project) {
            if (core.governor(target.sessionId) == Governor.Mod) {
                setSessionPhase(target.sessionId, nextPhase(target.phase))
            } else {
                core.control.advancePhase(target.sessionId)
            }
            core.refresh()
        }
    }

    /**
     * Set a phase on whichever backend governs the session. A refusal throws: a phase
     * change that silently did not happen leaves the operator believing writes are denied
     * (or allowed) when they are not.
     */
    private fun setSessionPhase(sessionId: String, phase: Phase) {
        if (core.governor(sessionId) == Governor.Mod) {
            val answer = core.sendToMod(sessionId, ModEntry.SetPhase(phase))
            if (!answer.ok) throw IllegalStateException("The Claude Code session did not change phase: ${answer.message}")
        } else {
            core.control.setPhase(sessionId, phase)
        }
    }

    /**
     * Say which session you are working in. Needed because Claude Code exposes no session
     * id: MoonlightCode knows for certain only the sessions it started, so rather than infer
     * and risk showing the wrong session's phase, the operator can say.
     *
     * Links to the agent-host tab in front (terminal or AI Chat) when there is one — the more
     * specific statement, and it keeps several tabs independent — else pins for the project.
     */
    fun setActive(project: Project, session: DiscoverableSession?) {
        if (session != null) {
            follow(project, session.sessionId)
            return
        }
        val all = core.sessions()
        val folders = projectFolders(project)
        // This project's sessions first — the likely answer — but never hide the rest: a
        // session can report a root that doesn't match how the project was opened.
        val here = all.filter { s -> s.root?.let { r -> folders.any { isInside(r, it) } } == true }
        val current = core.activeSession(project)?.sessionId
        val choices = (here + (all - here.toSet())).map { s ->
            Choice<String?>(
                (if (s.sessionId == current) "✓ " else "") + sessionLabel(s, all),
                "${if (s.adopted) phaseLabel(s.phase) else "not governed"} · ${s.status} · ${s.root ?: s.sessionId}",
                s.sessionId,
            )
        } + Choice<String?>("Clear pin", "fall back to detecting it automatically", null)
        pick(project, "Which session are you working in?", choices) { follow(project, it) }
    }

    private fun follow(project: Project, sessionId: String?) {
        val linked = core.pinToActivePanel(project, sessionId)
        if (!linked) core.setPinnedSession(project, sessionId)
        val tab = core.activePanelKey(project)?.let(::describePanelKey)
        info(
            project,
            when {
                sessionId != null && linked -> "Linked to $tab — switching tabs switches the session shown."
                sessionId != null -> "Pinned for this project — the status bar now shows its phase."
                linked -> "Link cleared for $tab."
                else -> "Pin cleared — the active session will be detected automatically."
            },
        )
    }

    /**
     * Start a Claude Code session MoonlightCode owns from its first line: in an IDE terminal,
     * or in a herdr pane that outlives the IDE. In step with VS Code's `start-session.ts`.
     *
     * The id is minted here and pinned with `--session-id`, so the session we start is the
     * one we govern and deliver reviews to. What follows depends on who governs: the daemon
     * adopts it once detection sees it (the engine drops an adopt for a session not yet in
     * the fleet); the Claude Code plugin governs every session it runs in, so there is
     * nothing to adopt. Call on the EDT.
     */
    fun startSession(project: Project, asked: Host? = null) {
        val governor = governorFor(core.backendError(), core.claudeMod())
        if (governor == StartGovernor.None) {
            val go = Messages.showOkCancelDialog(
                project,
                "No MoonlightCode daemon is answering and the Claude Code plugin is not enabled, so nothing would govern this session.",
                "Start Claude Session",
                "Start It Ungoverned",
                "Cancel",
                Messages.getWarningIcon(),
            )
            if (go != Messages.OK) return
        }
        val settings = SessionControlSettings.of(project)
        if (asked != null) return launchIn(project, asked, governor)
        if (settings.state.startIn == StartIn.Terminal) return launchIn(project, Host.Terminal, governor)
        // Whether a herdr server runs: a process, so off the EDT.
        ApplicationManager.getApplication().executeOnPooledThread {
            val running = HerdrService.of(project).cli.available()
            ApplicationManager.getApplication().invokeLater({
                when (hostFor(settings.state.startIn, running)) {
                    HostPlan.Terminal -> launchIn(project, Host.Terminal, governor)
                    HostPlan.Herdr -> launchIn(project, Host.Herdr, governor)
                    HostPlan.HerdrDown -> {
                        val go = Messages.showOkCancelDialog(
                            project,
                            "No herdr server is running, so the session cannot start in herdr. Start herdr, or start it in a terminal.",
                            "Start Claude Session",
                            "Start in a Terminal",
                            "Cancel",
                            Messages.getWarningIcon(),
                        )
                        if (go == Messages.OK) launchIn(project, Host.Terminal, governor)
                    }
                    HostPlan.Ask -> pick(
                        project,
                        "Where should the session run?",
                        listOf(
                            Choice("In herdr", "outlives the IDE; reattach from any terminal", Host.Herdr),
                            Choice("In an IDE terminal", "ends with the IDE", Host.Terminal),
                        ),
                    ) { launchIn(project, it, governor) }
                }
            }, project.disposed)
        }
    }

    private fun launchIn(project: Project, host: Host, governor: StartGovernor) {
        val sessionId = UUID.randomUUID().toString()
        when (host) {
            Host.Terminal -> {
                // Core binds the daemon's MCP endpoint only while the daemon answers.
                core.terminals.start(project, sessionId, project.basePath)
                settle(project, sessionId, governor, host, "in a terminal")
            }
            Host.Herdr -> startInHerdr(project, sessionId, governor)
        }
    }

    private fun startInHerdr(project: Project, sessionId: String, governor: StartGovernor) {
        val cwd = project.basePath ?: return error(project, "This project has no folder for a herdr session to start in.")
        val settings = SessionControlSettings.of(project)
        val herdr = HerdrService.of(project).cli
        ApplicationManager.getApplication().executeOnPooledThread {
            val last = settings.state.herdrLastWorkspace
            val choices = try {
                herdr.placements(projectFolders(project).ifEmpty { listOf(cwd) }, last, java.io.File(cwd).name)
            } catch (e: Exception) {
                return@executeOnPooledThread error(project, "MoonlightCode: could not read herdr's workspaces. ${e.message}")
            }
            ApplicationManager.getApplication().invokeLater({
                // Asked not to ask: the last workspace used here, when it is still there.
                val remembered = choices.firstOrNull { it is Placement.Tab && it.workspace.id == last }
                if (settings.state.herdrReuseLast && remembered != null) {
                    runHerdrStart(project, sessionId, remembered, cwd, governor)
                } else {
                    pick(project, "Where in herdr?", choices.map { Choice(placementTitle(it), placementNote(it, last), it) }) {
                        runHerdrStart(project, sessionId, it, cwd, governor)
                    }
                }
            }, project.disposed)
        }
    }

    private fun placementTitle(p: Placement): String = when (p) {
        is Placement.Tab -> p.workspace.label
        is Placement.Split -> p.workspace.label
        is Placement.NewWorkspace -> "New workspace \"${p.label}\""
    }

    private fun placementNote(p: Placement, last: String?): String = when (p) {
        is Placement.Tab -> listOfNotNull("new tab", "this repository".takeIf { p.inRepo }, "last used here".takeIf { p.workspace.id == last }).joinToString(" · ")
        is Placement.Split -> listOfNotNull("split beside ${p.pane}", "this repository".takeIf { p.inRepo }).joinToString(" · ")
        is Placement.NewWorkspace -> "at the project root"
    }

    private fun runHerdrStart(project: Project, sessionId: String, placement: Placement, cwd: String, governor: StartGovernor) {
        val where = "in herdr (${placementLabel(placement)})"
        object : Task.Backgroundable(project, "Starting Claude Code $where…", false) {
            override fun run(indicator: ProgressIndicator) {
                // The same wiring as an IDE terminal: the daemon's MCP config when it governs.
                val mcpJson = if (governor == StartGovernor.Daemon) {
                    try {
                        mcpConfigJson(core.control.mcpEndpoint(sessionId))
                    } catch (e: Exception) {
                        warn(project, "MoonlightCode: no MCP endpoint for this session (${e.message}). It starts without the moonlight verbs — it cannot propose a plan or request a phase.")
                        null
                    }
                } else {
                    null
                }
                try {
                    val workspace = HerdrService.of(project).cli.start(sessionId, placement, cwd, mcpJson)
                    if (workspace != null) SessionControlSettings.of(project).state.herdrLastWorkspace = workspace
                } catch (e: Exception) {
                    error(project, "MoonlightCode: the session did not start in herdr. ${e.message}")
                    return
                }
                settle(project, sessionId, governor, Host.Herdr, where)
            }
        }.queue()
    }

    /** After the launch: adopt under the daemon; under the Claude Code plugin, wait for it to report the session. */
    private fun settle(project: Project, sessionId: String, governor: StartGovernor, host: Host, where: String) {
        val short = shortId(sessionId)
        if (governor == StartGovernor.None) return notifyStarted(project, sessionId, host, "Session $short started $where, ungoverned.", NotificationType.INFORMATION)
        object : Task.Backgroundable(project, "Starting session $short $where — waiting for it to appear…", true) {
            override fun run(indicator: ProgressIndicator) {
                repeat(ADOPT_ATTEMPTS) {
                    if (indicator.isCanceled) return
                    Thread.sleep(ADOPT_POLL_MS)
                    core.refresh().get()
                    // The launch, wherever it is now: the operator may `/resume` another
                    // conversation before the minted one ever writes a line.
                    val current = core.sessions().firstOrNull { it.isOrContinues(sessionId) } ?: return@repeat
                    if (governor == StartGovernor.Mod) {
                        return notifyStarted(project, sessionId, host, "Session $short started $where. The Claude Code plugin governs it, in ${phaseLabel(current.phase)}.", NotificationType.INFORMATION)
                    }
                    try {
                        if (!current.adopted) core.control.adopt(current.sessionId)
                        core.refresh()
                        notifyStarted(project, sessionId, host, "Session $short started $where and adopted — governed from its next tool call, and reviews can be delivered to it.", NotificationType.INFORMATION)
                    } catch (e: Exception) {
                        warn(project, "Session started, but adopting it failed: ${e.message}. Use \"Adopt a Claude Code Session\" to retry.")
                    }
                    return
                }
                // Detection works off the transcript (or the plugin's state file), which only
                // appears once the session writes something. Say so rather than imply it is governed.
                notifyStarted(
                    project,
                    sessionId,
                    host,
                    if (governor == StartGovernor.Daemon) {
                        "Session $short started $where, but detection has not seen it yet, so it is NOT governed. " +
                            "It is detected once it writes its first transcript line — send it a prompt, then adopt it."
                    } else {
                        "Session $short started $where, but the Claude Code plugin has not reported it yet. Check that the plugin is enabled in that session."
                    },
                    NotificationType.WARNING,
                )
            }
        }.queue()
    }

    private fun notifyStarted(project: Project, sessionId: String, host: Host, message: String, type: NotificationType) {
        val note = NotificationGroupManager.getInstance().getNotificationGroup("MoonlightCode").createNotification(message, type)
        if (host == Host.Herdr) note.addAction(NotificationAction.createSimpleExpiring("Show in herdr") { showInHerdr(project, sessionId) })
        note.notify(project)
    }

    /** Bring the session's herdr pane forward. */
    fun showInHerdr(project: Project, sessionId: String) {
        background(project) {
            if (!HerdrService.of(project).cli.focus(sessionId)) info(project, "herdr does not host this session.")
        }
    }

    /**
     * After an automatic adoption: say what adoption did, not only that it happened. A
     * session gone quiet because its writes are denied looks like a broken agent unless the
     * message that governed it also says it is frozen and how to release it.
     */
    fun announceAutoAdopted(project: Project, session: DiscoverableSession) {
        NotificationGroupManager.getInstance().getNotificationGroup("MoonlightCode")
            .createNotification(
                "Adopted \"${sessionLabel(session, core.sessions())}\" automatically. It is on Plan, where project writes are denied.",
                NotificationType.INFORMATION,
            )
            // The session this toast is about, carried explicitly — re-resolving "the active
            // session" would quietly set the phase of a different one.
            .addAction(NotificationAction.createSimpleExpiring("Set phase…") { pickPhase(project, session) })
            .notify(project)
    }

    /** Whether "Resume Session" applies to a row: nothing of ours is running it, and it is not mid-turn. */
    fun canResume(session: DiscoverableSession): Boolean =
        core.terminals.get(session.sessionId) == null && session.status != SessionStatus.Running

    /**
     * Bring a session back in a terminal this window owns, on the conversation it was in.
     *
     * A launch this window remembers resumes as itself. Any other ended session gets a launch
     * of its own — but `claude --resume` beside a process still holding the conversation
     * forks it, so one the daemon does not report finished is confirmed first.
     */
    fun resume(project: Project, session: DiscoverableSession?) {
        val launches = SessionLaunches.of(project)
        if (session == null) {
            val resumable = launches.resumable()
            if (resumable.isEmpty()) {
                info(project, "Nothing to resume — no session launched in this window has ended.")
                return
            }
            pick(project, "Resume which session?", resumable.map { r ->
                Choice(
                    r.title ?: shortId(r.conversation ?: r.launchId),
                    (if (r.wasWorking) "was working · " else "") + (r.cwd ?: ""),
                    r,
                )
            }) { launches.resume(it, nudge = false).show() }
            return
        }
        core.terminals.get(session.sessionId)?.let {
            it.show()
            return
        }
        val remembered = launches.records().firstOrNull {
            it.conversation == session.sessionId || it.launchId == session.sessionId || it.launchId == session.launchId
        }
        if (remembered != null) {
            launches.resume(remembered, nudge = false).show()
            return
        }
        if (session.status != SessionStatus.Done && session.status != SessionStatus.Errored) {
            val go = Messages.showOkCancelDialog(
                project,
                "\"${session.title ?: shortId(session.sessionId)}\" is ${session.status} and may still be open in another terminal. " +
                    "Resuming it here starts a second Claude process on the same conversation.",
                "Resume Session",
                "Resume Here",
                Messages.getCancelButton(),
                Messages.getWarningIcon(),
            )
            if (go != Messages.OK) return
        }
        launches.resumeConversation(session.sessionId, session.root ?: project.basePath).show()
    }

    fun promptGroupName(project: Project, title: String, initial: String = ""): String? =
        Messages.showInputDialog(project, "Name for the session group", title, null, initial, object : com.intellij.openapi.ui.InputValidator {
            override fun checkInput(inputString: String?): Boolean = !inputString.isNullOrBlank()
            override fun canClose(inputString: String?): Boolean = checkInput(inputString)
        })?.trim()

    /**
     * Switch the view to custom grouping after the operator makes or fills a group. Without
     * this, a group made while grouping by project is filed somewhere the tree does not
     * render — which reads as the group not having been created.
     */
    fun ensureCustomMode(project: Project) {
        val settings = SessionControlSettings.of(project)
        if (settings.groupBy() != GroupBy.Custom) settings.setGroupBy(project, GroupBy.Custom)
    }

    private fun activeAdopted(project: Project): DiscoverableSession? {
        val active: ActiveSession = core.activeSession(project) ?: return null
        return core.sessions().firstOrNull { it.sessionId == active.sessionId && it.adopted }
    }

    private fun pickAdopted(project: Project, title: String, then: (DiscoverableSession) -> Unit) {
        val adopted = core.sessions().filter { it.adopted }
        if (adopted.isEmpty()) {
            info(project, "No adopted sessions — phase only governs sessions under MoonlightCode governance.")
            return
        }
        pick(project, title, adopted.map { s ->
            Choice(
                sessionLabel(s, adopted),
                "phase: ${phaseLabel(s.phase)}${if (s.phase.frozen) " (project writes DENIED)" else ""} · ${s.root ?: s.sessionId}",
                s,
            )
        }, then)
    }

    /** One row of a picker: what it says, the fact beside it, and the value it stands for. */
    data class Choice<T>(val label: String, val description: String, val value: T)

    fun <T> pick(project: Project, title: String, choices: List<Choice<T>>, then: (T) -> Unit) {
        val step = object : BaseListPopupStep<Choice<T>>(title, choices) {
            override fun getTextFor(value: Choice<T>): String = "${value.label}    —    ${value.description}"
            override fun onChosen(selectedValue: Choice<T>, finalChoice: Boolean): PopupStep<*>? =
                doFinalStep { then(selectedValue.value) }
        }
        JBPopupFactory.getInstance().createListPopup(step).showCenteredInCurrentWindow(project)
    }

    /** Run a control-API call off the EDT, reporting a failure where the operator asked. */
    fun background(project: Project, block: () -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                block()
            } catch (e: Exception) {
                error(project, e.message ?: e.toString())
            }
        }
    }

    fun onEdt(action: () -> Unit) = ApplicationManager.getApplication().invokeLater(action)

    fun info(project: Project, message: String) = notify(project, message, NotificationType.INFORMATION)
    fun warn(project: Project, message: String) = notify(project, message, NotificationType.WARNING)
    fun error(project: Project, message: String) = notify(project, message, NotificationType.ERROR)

    private fun notify(project: Project, message: String, type: NotificationType) {
        NotificationGroupManager.getInstance().getNotificationGroup("MoonlightCode").createNotification(message, type).notify(project)
    }
}

/** The phase after `phase`, as the daemon advances it: Commit goes back to Plan. */
internal fun nextPhase(phase: Phase): Phase = Phase.ORDERED[(Phase.ORDERED.indexOf(phase) + 1) % Phase.ORDERED.size]
