package io.github.titouanfreville.moonlight.sessions

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.github.titouanfreville.moonlight.client.LAUNCH_ENV
import io.github.titouanfreville.moonlight.client.isSafeSessionId
import io.github.titouanfreville.moonlight.client.safeEndpointUrl
import io.github.titouanfreville.moonlight.core.isInside
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * herdr, the terminal workspace manager, as a place to run Claude Code sessions — the
 * JetBrains side of VS Code's `herdr.ts` and `herdr-cli.ts`; keep the rules in step.
 *
 * A session started in herdr lives in a pane of the herdr server, not in the IDE: it
 * survives closing the IDE, can be reattached from any terminal, and shows in herdr's
 * sidebar like any other agent. herdr's Claude integration reports each pane's session id
 * (`agent_session.value`), which is MoonlightCode's session id too: that ties a pane to a
 * session with no guessing.
 *
 * In this plugin rather than core: the plugins update one at a time, and an API this
 * plugin needed from a newer core would be missing beside an older one.
 */
data class HerdrWorkspace(val id: String, val label: String, val number: Int, val focused: Boolean)

data class HerdrPane(
    val paneId: String,
    val workspaceId: String,
    /** The pane's folder, when herdr knows it. */
    val cwd: String?,
    /** The Claude Code session in the pane, from herdr's Claude integration. */
    val sessionId: String?,
    val focused: Boolean,
)

/** Where a new session goes: beside an existing workspace's work, or a workspace of its own. */
sealed interface Placement {
    data class Tab(val workspace: HerdrWorkspace, val inRepo: Boolean) : Placement
    data class Split(val workspace: HerdrWorkspace, val pane: String, val inRepo: Boolean) : Placement
    data class NewWorkspace(val label: String) : Placement
}

private fun JsonElement?.obj(): JsonObject? = if (this != null && isJsonObject) asJsonObject else null
private fun JsonObject?.str(key: String): String? = this?.get(key)?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotEmpty() }
private fun JsonObject?.bool(key: String): Boolean = this?.get(key)?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false

private fun parse(json: String): JsonObject? = runCatching { JsonParser.parseString(json).obj() }.getOrNull()

private fun resultList(json: String, key: String): List<JsonObject> =
    parse(json)?.get("result").obj()?.get(key)?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull { it.obj() } ?: emptyList()

/** `herdr workspace list`. Entries without an id are dropped rather than guessed. */
fun parseWorkspaces(json: String): List<HerdrWorkspace> = resultList(json, "workspaces").mapNotNull { w ->
    val id = w.str("workspace_id") ?: return@mapNotNull null
    HerdrWorkspace(id, w.str("label") ?: id, w.get("number")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0, w.bool("focused"))
}

/** `herdr pane list`. The folder the shell is in now, over the one it started in. */
fun parsePanes(json: String): List<HerdrPane> = resultList(json, "panes").mapNotNull { p ->
    val pane = p.str("pane_id") ?: return@mapNotNull null
    val workspace = p.str("workspace_id") ?: return@mapNotNull null
    HerdrPane(pane, workspace, p.str("foreground_cwd") ?: p.str("cwd"), p.get("agent_session").obj().str("value"), p.bool("focused"))
}

/**
 * The choices for a new session, best first. herdr does not tie workspaces to folders, so
 * the repository decides: a workspace with a pane in it (or in one of its worktrees,
 * `roots`) is this repository's. Those first — the one last used here, else the one with
 * most panes in the repository — then every other workspace, then a new workspace named
 * after the repository (first when nothing matches).
 */
fun placements(roots: List<String>, workspaces: List<HerdrWorkspace>, panes: List<HerdrPane>, lastUsed: String?, repoName: String): List<Placement> {
    // Core's rule for "this path is inside that folder" (`isInside(path, folder)`),
    // case-insensitive where the file system is.
    fun inRepo(p: HerdrPane) = p.cwd != null && roots.any { isInside(p.cwd, it) }
    fun score(w: HerdrWorkspace) = panes.count { it.workspaceId == w.id && inRepo(it) }
    fun rank(w: HerdrWorkspace) = (if (w.id == lastUsed && score(w) > 0) 1000 else 0) + score(w)
    val ordered = workspaces.sortedWith(compareByDescending<HerdrWorkspace> { rank(it) }.thenBy { it.number })
    val choices = ordered.flatMap { w ->
        val matches = score(w) > 0
        // Split beside the pane you would be looking at: the focused one, else one in the repository.
        val beside = panes.firstOrNull { it.workspaceId == w.id && it.focused }
            ?: panes.firstOrNull { it.workspaceId == w.id && inRepo(it) }
            ?: panes.firstOrNull { it.workspaceId == w.id }
        listOfNotNull(Placement.Tab(w, matches), beside?.let { Placement.Split(w, it.paneId, matches) })
    }
    val fresh = Placement.NewWorkspace(repoName)
    return if (ordered.any { score(it) > 0 }) choices + fresh else listOf(fresh) + choices
}

/** A herdr agent name for a session: `ml-` and the id's first block, herdr's `[a-z][a-z0-9_-]{0,31}`. */
fun agentName(sessionId: String): String = "ml-" + sessionId.take(8).lowercase().filter { it.isLetterOrDigit() }

/** The arguments that make the pane a placement needs, with the launch variable set. Never takes focus. */
fun createArgs(placement: Placement, cwd: String, env: Map<String, String>): List<String> {
    val vars = env.flatMap { (k, v) -> listOf("--env", "$k=$v") }
    return when (placement) {
        is Placement.Tab -> listOf("tab", "create", "--workspace", placement.workspace.id, "--cwd", cwd) + vars + "--no-focus"
        is Placement.Split -> listOf("pane", "split", placement.pane, "--direction", "right", "--cwd", cwd) + vars + "--no-focus"
        is Placement.NewWorkspace -> listOf("workspace", "create", "--cwd", cwd, "--label", placement.label) + vars + "--no-focus"
    }
}

/** The pane a creation command answered with: `root_pane` for a tab or workspace, `pane` for a split. */
fun createdPane(json: String): String? {
    val result = parse(json)?.get("result").obj()
    return result?.get("root_pane").obj().str("pane_id") ?: result?.get("pane").obj().str("pane_id")
}

/**
 * `herdr agent start` for a session: Claude Code with our session id, and the daemon's MCP
 * config when the daemon governs. Arguments after `--` reach Claude Code as a list: no
 * shell line is built, so the JSON needs no quoting.
 */
fun agentStartArgs(sessionId: String, pane: String, mcpJson: String?): List<String> =
    listOf("agent", "start", agentName(sessionId), "--kind", "claude", "--pane", pane, "--timeout", "60000", "--", "--session-id", sessionId) +
        (mcpJson?.let { listOf("--mcp-config", it) } ?: emptyList())

/** The `--mcp-config` value for a daemon endpoint, as plain JSON; null for an endpoint we will not run. */
fun mcpConfigJson(url: String): String? {
    val safe = safeEndpointUrl(url) ?: return null
    val server = JsonObject().apply { addProperty("type", "http"); addProperty("url", safe) }
    return JsonObject().apply { add("mcpServers", JsonObject().apply { add("moonlight", server) }) }.toString()
}

fun placementLabel(p: Placement): String = when (p) {
    is Placement.Tab -> "${p.workspace.label}: new tab"
    is Placement.Split -> "${p.workspace.label}: split beside ${p.pane}"
    is Placement.NewWorkspace -> "New workspace \"${p.label}\""
}

/** herdr's error message (JSON on stderr), or the raw text. */
fun herdrError(stderr: String): String =
    parse(stderr)?.get("error").obj()?.let { it.str("message") ?: it.str("code") } ?: stderr.trim()

/**
 * The `herdr` binary: the configured path, else the first on PATH or in the usual install
 * folders. An IDE started from the Dock may get a short PATH without Homebrew's folder.
 */
fun findHerdr(configured: String, envPath: String?, home: String, exists: (String) -> Boolean): String? {
    if (configured.isNotBlank()) return configured.takeIf(exists)
    val dirs = (envPath ?: "").split(File.pathSeparatorChar).filter { it.isNotBlank() } +
        listOf("/opt/homebrew/bin", "/usr/local/bin", "$home/.local/bin", "$home/.cargo/bin")
    return dirs.map { "$it/herdr" }.firstOrNull(exists)
}

/**
 * Runs `herdr` for the IDE. Arguments go to the process as a list — never a shell line
 * built from a session id, a path or a JSON config. Blocking: call off the EDT.
 */
class HerdrCli(private val configuredPath: () -> String) {
    @Volatile private var panesCache: Pair<Long, List<HerdrPane>>? = null

    private fun binary(): String? {
        if (System.getProperty("os.name").lowercase().startsWith("windows")) return null
        return findHerdr(configuredPath(), System.getenv("PATH"), System.getProperty("user.home"), { File(it).isFile })
    }

    private fun run(args: List<String>, timeoutMs: Long = QUICK_MS): String {
        val bin = binary() ?: throw IllegalStateException("herdr is not installed (set its path in Settings ▸ Tools ▸ MoonlightCode Sessions).")
        val process = ProcessBuilder(listOf(bin) + args).redirectErrorStream(false).start()
        val out = process.inputStream.bufferedReader().readText()
        val err = process.errorStream.bufferedReader().readText()
        if (!process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)) {
            process.destroyForcibly()
            throw IllegalStateException("herdr ${args.take(2).joinToString(" ")}: timed out")
        }
        if (process.exitValue() != 0) throw IllegalStateException("herdr ${args.take(2).joinToString(" ")}: ${herdrError(err.ifBlank { out })}")
        return out
    }

    /** A listing answers only while a herdr server runs: the one fact a start needs. */
    fun available(): Boolean = runCatching { run(listOf("workspace", "list")) }.isSuccess

    private fun panes(fresh: Boolean = false): List<HerdrPane> {
        val cached = panesCache
        if (!fresh && cached != null && System.currentTimeMillis() - cached.first < PANES_TTL_MS) return cached.second
        return try {
            parsePanes(run(listOf("pane", "list"))).also { panesCache = System.currentTimeMillis() to it }
        } catch (e: Exception) {
            // A stopped server answers the same for a few seconds: no process per redraw.
            panesCache = System.currentTimeMillis() to emptyList()
            throw e
        }
    }

    fun placements(roots: List<String>, lastUsed: String?, repoName: String): List<Placement> =
        placements(roots, parseWorkspaces(run(listOf("workspace", "list"))), panes(fresh = true), lastUsed, repoName)

    /** Start Claude Code with our session id at `placement`; returns the workspace it went to. */
    fun start(sessionId: String, placement: Placement, cwd: String, mcpJson: String?): String? {
        require(isSafeSessionId(sessionId)) { "refusing to launch — unexpected session id shape ($sessionId)." }
        val pane = createdPane(run(createArgs(placement, cwd, mapOf(LAUNCH_ENV to sessionId))))
            ?: throw IllegalStateException("herdr made no pane to start the session in.")
        run(agentStartArgs(sessionId, pane, mcpJson), START_MS)
        panesCache = null
        return when (placement) {
            is Placement.Tab -> placement.workspace.id
            is Placement.Split -> placement.workspace.id
            is Placement.NewWorkspace -> pane.substringBefore(':')
        }
    }

    fun paneOf(sessionId: String): String? = runCatching { panes().firstOrNull { it.sessionId == sessionId }?.paneId }.getOrNull()

    fun hosts(sessionId: String): Boolean = paneOf(sessionId) != null

    /** Bring the session's pane forward in herdr; false when herdr does not host it. */
    fun focus(sessionId: String): Boolean {
        val pane = paneOf(sessionId) ?: return false
        run(listOf("agent", "focus", pane))
        return true
    }

    private companion object {
        const val QUICK_MS = 10_000L
        const val START_MS = 75_000L
        const val PANES_TTL_MS = 3_000L
    }
}
