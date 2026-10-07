package io.github.titouanfreville.moonlight.core

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.wm.IdeFocusManager
import com.intellij.util.concurrency.AppExecutorUtil
import io.github.titouanfreville.moonlight.client.ControlApi
import io.github.titouanfreville.moonlight.client.DaemonLauncher
import io.github.titouanfreville.moonlight.client.DaemonOptions
import io.github.titouanfreville.moonlight.client.DaemonStartResult
import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.EngineEvent
import io.github.titouanfreville.moonlight.client.EventStream
import io.github.titouanfreville.moonlight.client.EventStreamHandlers
import io.github.titouanfreville.moonlight.client.HookStatusEntry
import io.github.titouanfreville.moonlight.client.Os
import io.github.titouanfreville.moonlight.client.SessionStatus
import io.github.titouanfreville.moonlight.client.UsageResponse
import io.github.titouanfreville.moonlight.client.daemonBinaryName
import io.github.titouanfreville.moonlight.client.stateAnchor
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * MoonlightCode Core — the one backend connection every MoonlightCode plugin shares.
 *
 * It contributes no UI. It exists so the feature plugins can ship and be installed
 * separately without each opening its own connection and forming its own opinion about
 * what the fleet is doing. One instance serves every project window in the IDE.
 */
@Service(Service.Level.APP)
class MoonlightService : MoonlightApi, Disposable {
    override val version: Int = 1
    override val control: ControlApi = ControlApi()
    override val terminals: SessionTerminals = SessionTerminals { sessions }

    private val launcher = DaemonLauncher()
    private val gate = GateState()

    // The daemon's sessions, and the Claude Code mod's (see ModBridge); `sessions` is
    // both, which is all a panel needs to know.
    @Volatile private var daemonSessions: List<DiscoverableSession> = emptyList()
    @Volatile private var modStates: List<ModState> = emptyList()
    /** When each mod hold was first seen, so "waiting 40s" means what it says. */
    private val modHoldSince = java.util.concurrent.ConcurrentHashMap<String, Pair<String, Long>>()
    private var modPoll: ScheduledFuture<*>? = null
    @Volatile private var sessions: List<DiscoverableSession> = emptyList()
    @Volatile private var gating: List<HookStatusEntry> = emptyList()
    @Volatile private var usage: UsageResponse? = null
    @Volatile private var backendError: String? = null

    private val refreshLock = Any()
    private var poll: ScheduledFuture<*>? = null
    private var stream: EventStream? = null

    // A daemon downloaded on demand, once verified. Held here so the poll does not re-stat
    // the cache every tick, and so one in-flight download is shared by every tick during it.
    @Volatile private var downloadedDaemon: String? = null
    @Volatile private var installing = false

    /**
     * Earliest time a failed install may be retried. Without it a 404 or a checksum
     * mismatch re-fetched the whole asset on every five-second tick — and a nightly-pinned
     * build's 404 is permanent, because the nightly release is recreated on each push.
     */
    @Volatile private var retryInstallAfter = 0L

    // The fallback: the MoonlightCode mod for Claude Code (see ClaudeMod). It is asked
    // about only while the daemon is down: spawning the CLI on every IDE start, for a
    // state that matters only then, would be paid for nothing.
    @Volatile private var claudeMod = ClaudeModState.Unknown
    @Volatile private var failedPolls = 0
    @Volatile private var modOffered = false
    @Volatile private var installingMod = false
    private val claudeSettings = ClaudeMod.settingsFileAt(ClaudeMod.settingsPath())

    /** Start polling and streaming. Idempotent; called from every project's startup. */
    @Synchronized
    fun start() {
        if (poll != null) return
        poll = AppExecutorUtil.getAppScheduledExecutorService()
            .scheduleWithFixedDelay({ refreshBlocking() }, 0, POLL_INTERVAL_MS, TimeUnit.MILLISECONDS)
        // The mod's sessions, on the mod's own two-second tick, whether or not a daemon
        // answers: the mod governs exactly when the daemon does not.
        modPoll = AppExecutorUtil.getAppScheduledExecutorService()
            .scheduleWithFixedDelay({ refreshMod() }, 0, MOD_POLL_MS, TimeUnit.MILLISECONDS)
        // The gate rides the event stream rather than the poll: a hold is not a fact that
        // can wait five seconds for its turn — the session is stopped until someone answers.
        stream = EventStream(object : EventStreamHandlers {
            override fun onEvent(event: EngineEvent) {
                if (event is EngineEvent.SessionAlert) onEdt { publisher().sessionAlert(event.session, event.alert) }
                if (gate.apply(event)) fireHolds()
            }

            override fun onDesync(reason: String) = resyncHolds()
        }).start()
        resyncHolds()
    }

    override fun dispose() {
        synchronized(this) {
            poll?.cancel(false)
            poll = null
            modPoll?.cancel(false)
            modPoll = null
            stream?.close()
            stream = null
        }
    }

    override fun sessions(): List<DiscoverableSession> = sessions
    override fun gating(): List<HookStatusEntry> = gating
    override fun usage(): UsageResponse? = usage
    override fun backendError(): String? = backendError
    override fun claudeMod(): ClaudeModState = claudeMod

    override fun refresh(): CompletableFuture<Unit> =
        CompletableFuture.supplyAsync({ refreshBlocking() }, AppExecutorUtil.getAppExecutorService())

    private fun refreshBlocking() {
        synchronized(refreshLock) {
            try {
                // Sessions and gating are the load-bearing pair: if either is unreachable the
                // backend genuinely is, and the status bar must say so.
                val nextSessions = control.discoverableSessions()
                val nextGating = control.gatingStatus()
                // Usage is fetched separately and allowed to fail. A backend that predates
                // `/control/usage` must not report as entirely down over a missing quota
                // reading — and the previous figure is kept rather than blanked, so a blip
                // does not make it flicker.
                val nextUsage = try {
                    control.usage()
                } catch (_: Exception) {
                    usage
                }
                // Only fire when something moved: this ticks every five seconds, and waking
                // every surface each time would make them redraw for nothing.
                val same = backendError == null && nextSessions == daemonSessions && nextGating == gating && nextUsage == usage
                daemonSessions = nextSessions
                sessions = mergedSessions()
                gating = nextGating
                usage = nextUsage
                backendError = null
                failedPolls = 0
                launcher.reachable()
                if (!same) fireSessions()
            } catch (e: Exception) {
                val reported = explainOutage(e.message ?: e.toString())
                // An unreachable backend is an ordinary state, rendered by the status plugin.
                // The last known lists are kept so a blip does not blank every view.
                if (backendError != reported) {
                    backendError = reported
                    fireSessions()
                }
                // The first failure of a streak learns whether the mod covers for the
                // daemon; a streak long enough that autostart could not fix it offers it.
                failedPolls += 1
                if (failedPolls == 1) {
                    AppExecutorUtil.getAppExecutorService().execute { checkMod() }
                } else if (failedPolls == OFFER_MOD_AFTER_FAILURES) {
                    AppExecutorUtil.getAppExecutorService().execute { offerMod() }
                }
            }
        }
    }

    private fun checkMod() {
        val next = runCatching { ClaudeMod.readState(::runClaude, claudeSettings) }.getOrDefault(ClaudeModState.Unknown)
        if (next != claudeMod) {
            claudeMod = next
            fireSessions()
        }
    }

    /** Offered once per IDE run, after the daemon stayed down long enough for autostart to have had its go. */
    private fun offerMod() {
        if (modOffered || PropertiesComponent.getInstance().getBoolean(MOD_DONT_ASK_KEY)) return
        checkMod()
        if (claudeMod != ClaudeModState.Missing && claudeMod != ClaudeModState.Off) return
        modOffered = true
        NotificationGroupManager.getInstance().getNotificationGroup("MoonlightCode Sessions")
            .createNotification(
                "No MoonlightCode daemon is running, so Claude Code sessions are not gated. Install the MoonlightCode " +
                    "plugin for Claude Code? It gates each session itself until a daemon runs. This installs " +
                    "\"moonlightcode\" from the moonlight marketplace and turns on function hooks in ~/.claude/settings.json.",
                NotificationType.WARNING,
            )
            .addAction(NotificationAction.createSimpleExpiring("Install") { installClaudeMod(null) })
            .addAction(NotificationAction.createSimpleExpiring("Not now") {})
            .addAction(NotificationAction.createSimpleExpiring("Don't ask again") {
                PropertiesComponent.getInstance().setValue(MOD_DONT_ASK_KEY, true)
            })
            .notify(null)
    }

    override fun installClaudeMod(project: Project?) {
        if (installingMod) return
        installingMod = true
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Installing the MoonlightCode plugin for Claude Code", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val result = ClaudeMod.install(::runClaude, claudeSettings, bundledMarketplace())
                    checkMod()
                    when (result) {
                        is ModInstall.Installed -> notify(
                            "MoonlightCode plugin installed for Claude Code. New Claude Code sessions are gated by it while " +
                                "no daemon runs; restart the sessions already open to gate them too.",
                            NotificationType.INFORMATION,
                            project,
                        )
                        is ModInstall.Failed -> notify("MoonlightCode plugin not installed: ${result.error}", NotificationType.ERROR, project)
                    }
                } catch (e: Exception) {
                    notify("MoonlightCode plugin not installed: ${e.message ?: e}", NotificationType.ERROR, project)
                } finally {
                    installingMod = false
                }
            }
        })
    }

    /**
     * The marketplace bundled in this plugin's jar, written out to the IDE's system
     * directory: Claude Code keeps the path a local marketplace was added from, so it must
     * outlive this plugin's own (versioned) folder. `files.txt` lists what the build copied.
     */
    private fun bundledMarketplace(): Path? = try {
        val index = javaClass.getResourceAsStream("$BUNDLED_MOD/files.txt")?.use { String(it.readAllBytes()) }
        if (index == null) {
            null
        } else {
            val target = daemonStorage().resolve("claude-mod")
            target.toFile().deleteRecursively()
            for (relative in index.lines().map(String::trim).filter(String::isNotEmpty)) {
                // The index is this build's own; a path that climbs out of it is refused all the same.
                val out = target.resolve(relative).normalize()
                if (!out.startsWith(target)) throw IOException("bundled mod path escapes its folder: $relative")
                val bytes = javaClass.getResourceAsStream("$BUNDLED_MOD/$relative")?.use { it.readAllBytes() }
                    ?: throw IOException("bundled mod file missing: $relative")
                Files.createDirectories(out.parent)
                Files.write(out, bytes)
            }
            target
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Runs the `claude` CLI. Through a login shell on macOS and Linux, as the terminal
     * launch does, because an IDE started from the dock lacks the PATH that finds
     * `claude`. The arguments travel as the shell's positional parameters, never inside
     * the script.
     */
    private fun runClaude(args: List<String>): CliResult {
        val command = if (Os.current() == Os.Windows) {
            listOf("cmd", "/c", "claude") + args
        } else {
            val shell = System.getenv("SHELL")?.takeIf { it.isNotBlank() } ?: "/bin/sh"
            listOf(shell, "-l", "-c", "exec claude \"\$@\"", "claude") + args
        }
        val process = ProcessBuilder(command).start()
        val stdout = CompletableFuture.supplyAsync { process.inputStream.use { String(it.readAllBytes()) } }
        val stderr = CompletableFuture.supplyAsync { process.errorStream.use { String(it.readAllBytes()) } }
        if (!process.waitFor(CLI_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            throw IOException("claude ${args.joinToString(" ")} timed out")
        }
        return CliResult(process.exitValue(), stdout.get(), stderr.get())
    }

    /**
     * Start a daemon, and say *why* there is no backend when the reason is a choice or a
     * missing binary — "connection refused" alone sends an operator looking for a crash when
     * the answer is that this IDE was told not to start one.
     *
     * An IDE that opens is expected to make sure the daemon is running: it is what governs
     * sessions, so reporting "no backend" and stopping there would leave the fleet
     * ungoverned while looking like it is working. Racing another IDE is safe.
     */
    private fun explainOutage(message: String): String {
        val settings = MoonlightSettings.getInstance()
        val options = DaemonOptions(path = settings.daemonPath() ?: downloadedDaemon, autostart = settings.autostart())
        val started = launcher.ensure(options)
        if (started == DaemonStartResult.NoBinary && options.autostart && settings.daemonPath() == null) {
            installDaemon()
        }
        return when (started) {
            DaemonStartResult.NoBinary -> "$message (moonlightd not found)"
            DaemonStartResult.Disabled ->
                "$message (autostart is off — start moonlightd yourself, or enable it in Settings ▸ Tools ▸ MoonlightCode)"
            else -> message
        }
    }

    /**
     * Fetch the daemon the first time `PATH` turns up empty. Only then: an operator who
     * pointed at their own build, or turned autostart off, has already answered.
     */
    private fun installDaemon() {
        if (downloadedDaemon != null || installing || System.currentTimeMillis() < retryInstallAfter) return
        installing = true
        AppExecutorUtil.getAppExecutorService().execute {
            try {
                when (val result = ensureDownloadedDaemon(daemonStorage(), daemonBinaryName())) {
                    is InstallResult.Installed -> downloadedDaemon = result.binary.toString()
                    is InstallResult.Cached -> downloadedDaemon = result.binary.toString()
                    is InstallResult.Failed -> {
                        retryInstallAfter = System.currentTimeMillis() + INSTALL_RETRY_MS
                        // Surfaced, not just logged: this path exists for people who have
                        // nothing but the plugin, and a reason buried in idea.log is one they
                        // never see.
                        notify("MoonlightCode could not download moonlightd: ${result.error}", NotificationType.WARNING)
                    }
                    else -> Unit
                }
            } finally {
                installing = false
            }
        }
    }

    /** Re-read the outstanding holds from the server, after a desync or at start. */
    private fun resyncHolds() {
        AppExecutorUtil.getAppExecutorService().execute {
            try {
                gate.resync(control.pendingApprovals())
                fireHolds()
            } catch (_: Exception) {
                // An unreachable backend is already reported by the poll; a second, louder
                // complaint from here would only duplicate it.
            }
        }
    }

    override fun heldApproval(sessionId: String): HeldApproval? = modHoldOf(sessionId) ?: gate.approval(sessionId)
    override fun heldApprovals(): List<HeldApproval> {
        val mine = modStates.map { it.sessionId }.toSet()
        return (gate.approvals().filter { it.sessionId !in mine } + modStates.mapNotNull { modHoldOf(it.sessionId) })
            .sortedBy { it.sinceMs }
    }
    override fun proposedPlan(sessionId: String): String? =
        modStates.firstOrNull { it.sessionId == sessionId }?.plan?.markdown ?: gate.plan(sessionId)

    override fun modReview(sessionId: String): ModReview? = modStates.firstOrNull { it.sessionId == sessionId }?.review

    override fun governor(sessionId: String): Governor =
        if (modStates.any { it.sessionId == sessionId }) Governor.Mod else Governor.Daemon

    override fun sendToMod(sessionId: String, entry: ModEntry): ModAnswer =
        try {
            ModBridge.send(modDir(), sessionId, entry).also { refreshMod() }
        } catch (e: Exception) {
            ModAnswer(false, e.message ?: e.toString())
        }

    private fun modDir(): Path = Path.of(stateAnchor(), ".moonlight", "mod", "sessions")

    private fun mergedSessions(): List<DiscoverableSession> {
        val mine = modStates.map { it.sessionId }.toSet()
        return daemonSessions.filter { it.sessionId !in mine } + modStates.map(ModBridge::session)
    }

    private fun modHoldOf(sessionId: String): HeldApproval? {
        val state = modStates.firstOrNull { it.sessionId == sessionId } ?: return null
        return ModBridge.hold(state, modHoldSince[sessionId]?.second ?: System.currentTimeMillis())
    }

    @Synchronized
    private fun refreshMod() {
        val next = ModBridge.readStates(modDir(), System.currentTimeMillis())
        if (next == modStates) return
        modStates = next
        val now = System.currentTimeMillis()
        for (state in next) {
            val hold = ModBridge.hold(state, now)
            val key = hold?.let { "${it.what}#${it.planVersion ?: ""}" }
            if (key == null) modHoldSince.remove(state.sessionId)
            else if (modHoldSince[state.sessionId]?.first != key) modHoldSince[state.sessionId] = key to now
        }
        sessions = mergedSessions()
        fireSessions()
        fireHolds()
    }

    override fun activeSession(project: Project): ActiveSession? {
        val known = sessions
        val state = project.service<ProjectSessions>()
        // 1. The session linked to the agent-host tab in front of you — the only answer
        //    that stays right when several agent tabs are open at once.
        // Links and pins name the conversation they were made on; one whose process has
        // since `/resume`d or `/clear`ed is followed through its launch.
        val forPanel = state.activePanelKey()?.let(state::panelSession)?.let { currentConversation(it, known) }
        if (forPanel != null && known.any { it.sessionId == forPanel }) {
            return ActiveSession(forPanel, ActiveSession.How.Panel)
        }
        // 2. A session we launched in this window. Only when there is exactly one, since
        //    several owned terminals are as ambiguous as none.
        val ownedHere = terminals.ownedIn(project)
        val owned = known.filter { it.sessionId in ownedHere }
        if (owned.size == 1) return ActiveSession(owned[0].sessionId, ActiveSession.How.Owned)
        // 3. The operator's project-wide pin, while it still exists.
        val pinned = state.pinnedSession()?.let { currentConversation(it, known) }
        if (pinned != null && known.any { it.sessionId == pinned }) {
            return ActiveSession(pinned, ActiveSession.How.Pinned)
        }
        // 4. Exactly one session in this project — a guess, labelled as one, and only when
        //    there is no competition: naming the wrong session as governed is worse than
        //    admitting we don't know.
        val folders = projectFolders(project)
        val here = known.filter { s -> s.root?.let { root -> folders.any { isInside(root, it) } } == true }
        val running = here.filter { it.status == SessionStatus.Running }
        val candidates = running.ifEmpty { here }
        return if (candidates.size == 1) ActiveSession(candidates[0].sessionId, ActiveSession.How.Sole) else null
    }

    override fun setPinnedSession(project: Project, sessionId: String?) {
        project.service<ProjectSessions>().setPinnedSession(sessionId)
        fireSessions()
    }

    override fun activePanelKey(project: Project): String? = project.service<ProjectSessions>().activePanelKey()

    override fun pinToActivePanel(project: Project, sessionId: String?): Boolean {
        val linked = project.service<ProjectSessions>().linkActivePanel(sessionId)
        if (linked) fireSessions()
        return linked
    }

    override fun owningProject(sessionId: String): Project? {
        val root = sessions.firstOrNull { it.sessionId == sessionId }?.root
        val owners = ProjectManager.getInstance().openProjects.filter { candidate ->
            !candidate.isDisposed && ownsSession(sessionId, activeSession(candidate)?.sessionId, root, projectFolders(candidate))
        }
        return pickOwner(owners, focusedProject())
    }

    /** The project window the operator was last in, if any. */
    fun focusedProject(): Project? = IdeFocusManager.getGlobalInstance().lastFocusedFrame?.project

    /** Called by a project when something about *which* session is active moved. */
    internal fun activeSessionMayHaveChanged() = fireSessions()

    private fun fireSessions() = onEdt { publisher().sessionsChanged() }

    private fun fireHolds() = onEdt { publisher().holdsChanged() }

    private fun publisher(): MoonlightListener =
        ApplicationManager.getApplication().messageBus.syncPublisher(MoonlightListener.TOPIC)

    /**
     * Listeners are told on the EDT so every surface can redraw without hopping threads
     * itself. `any()` modality: these are redraws, not model changes, and a modal dialog
     * open somewhere must not freeze the status bar behind it.
     */
    private fun onEdt(action: () -> Unit) {
        val app = ApplicationManager.getApplication()
        if (app.isDisposed) return
        app.invokeLater({ if (!app.isDisposed) action() }, ModalityState.any())
    }

    companion object {
        /** How often the backend is polled — one loop for every plugin and every window. */
        const val POLL_INTERVAL_MS: Long = 5000

        /** The mod's own tick: its state can change no faster. */
        private const val MOD_POLL_MS: Long = 2000

        private const val INSTALL_RETRY_MS: Long = 10 * 60_000

        /** How many failed polls in a row (five seconds apart) before the mod is offered. */
        private const val OFFER_MOD_AFTER_FAILURES = 3
        private const val MOD_DONT_ASK_KEY = "moonlight.claudeMod.dontAsk"
        private const val CLI_TIMEOUT_SECONDS = 120L
        /** Where the build puts the mod in this plugin's resources (see build.gradle.kts). */
        private const val BUNDLED_MOD = "/moonlight/claude-mod"

        fun getInstance(): MoonlightService = ApplicationManager.getApplication().service()

        /** Where a downloaded daemon is cached — the IDE's system directory, not the config one. */
        fun daemonStorage(): Path = Path.of(PathManager.getSystemPath(), "moonlight")

        fun notify(content: String, type: NotificationType, project: Project? = null) {
            NotificationGroupManager.getInstance().getNotificationGroup("MoonlightCode")
                .createNotification(content, type)
                .notify(project)
        }
    }
}
