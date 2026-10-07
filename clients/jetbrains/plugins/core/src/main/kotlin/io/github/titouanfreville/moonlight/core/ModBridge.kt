package io.github.titouanfreville.moonlight.core

import io.github.titouanfreville.moonlight.client.DiscoverableSession
import io.github.titouanfreville.moonlight.client.Json
import io.github.titouanfreville.moonlight.client.PLAN_HOLD
import io.github.titouanfreville.moonlight.client.Phase
import io.github.titouanfreville.moonlight.client.SessionStatus
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import kotlin.io.path.name

/**
 * The sessions the MoonlightCode mod for Claude Code governs, for the same panels the
 * daemon's sessions use. A port of VS Code's `moonlight-core/src/mod-bridge.ts`.
 *
 * The mod cannot listen, so it and the IDE meet in files, per session, under
 * `~/.moonlight/mod/sessions/<id>/` (the format is the mod's `hooks/bridge.ts`):
 * `state.json` (what the mod shows), `heartbeat` (touched every two seconds),
 * `inbox/<entry>.json` (one operator decision, written here) and `outbox/<entry>.json`
 * (the mod's answer, read here; then both files are removed). The agent cannot forge a
 * decision: the mod refuses its writes under `~/.moonlight`.
 */
object ModBridge {
    const val VERSION = 1

    /** A session whose heartbeat is older than this has no mod behind it any more. */
    const val HEARTBEAT_STALE_MS = 10_000L

    private val TO_DAEMON = mapOf(
        "plan" to Phase.Plan,
        "auto" to Phase.AutoImplement,
        "test" to Phase.Test,
        "review" to Phase.Review,
        "commit" to Phase.Commit,
    )

    fun daemonPhase(phase: String): Phase? = TO_DAEMON[phase]

    fun modPhase(phase: Phase): String = TO_DAEMON.entries.first { it.value == phase }.key

    /** A `state.json`, or `null` for one this IDE cannot read (another version, a torn write). */
    fun parseState(text: String): ModState? {
        val s = runCatching { Json.parse(text) }.getOrNull() as? Map<*, *> ?: return null
        if ((s["v"] as? Number)?.toInt() != VERSION) return null
        val sessionId = s["sessionId"] as? String ?: return null
        val phase = daemonPhase(s["phase"] as? String ?: return null) ?: return null
        val pending = (s["pending"] as? Map<*, *>)?.let { p ->
            daemonPhase(p["to"] as? String ?: "")?.let { ModState.Pending(it, p["reason"] as? String ?: "") }
        }
        val plan = (s["plan"] as? Map<*, *>)?.let { p ->
            val version = (p["version"] as? Number)?.toInt() ?: return@let null
            ModState.Plan(version, p["title"] as? String ?: "", p["markdown"] as? String ?: "", p["decided"] as? String)
        }
        return ModState(sessionId, s["root"] as? String, phase, pending, plan, (s["review"] as? Map<*, *>)?.let(::parseReview))
    }

    /** The `review` section: what the mod's Review panel holds. Unknown fields are skipped. */
    fun parseReview(r: Map<*, *>): ModReview {
        fun list(key: String) = (r[key] as? List<*>).orEmpty().mapNotNull { it as? Map<*, *> }
        fun int(m: Map<*, *>, key: String) = (m[key] as? Number)?.toInt() ?: 0
        return ModReview(
            scope = r["scope"] as? String ?: "session",
            files = list("files").mapNotNull { f ->
                val path = f["path"] as? String ?: return@mapNotNull null
                val absolute = f["absolute"] as? String ?: return@mapNotNull null
                ModReviewFile(path, absolute, f["status"] as? String ?: "M", int(f, "added"), int(f, "removed"), f["baseline"] as? String, f["skipped"] as? String)
            },
            comments = list("comments").mapNotNull { c ->
                ModReviewComment(
                    id = c["id"] as? String ?: return@mapNotNull null,
                    path = c["path"] as? String ?: return@mapNotNull null,
                    side = c["side"] as? String ?: "after",
                    start = int(c, "start"),
                    end = int(c, "end"),
                    body = c["body"] as? String ?: "",
                    excerpt = c["excerpt"] as? String,
                )
            },
            findings = list("findings").mapNotNull { f ->
                ModFinding(
                    id = f["id"] as? String ?: return@mapNotNull null,
                    key = f["key"] as? String ?: "",
                    severity = f["severity"] as? String ?: "low",
                    route = f["route"] as? String ?: "decision",
                    file = f["file"] as? String ?: "",
                    line = int(f, "line"),
                    summary = f["summary"] as? String ?: "",
                    detail = f["detail"] as? String ?: "",
                    fix = f["fix"] as? String,
                    decision = f["decision"] as? String ?: "keep",
                    note = f["note"] as? String,
                )
            },
            findingsStatus = r["findingsStatus"] as? String,
            runningSkill = (r["run"] as? Map<*, *>)?.get("skill") as? String,
            skills = (r["skills"] as? List<*>).orEmpty().filterIsInstance<String>(),
        )
    }

    /** A mod session as the session lists show it: governed, so adopted; waiting when it holds. */
    fun session(state: ModState): DiscoverableSession = DiscoverableSession(
        sessionId = state.sessionId,
        title = state.root?.let { "${Path.of(it).name} (Claude Code plugin)" } ?: "Claude Code plugin",
        root = state.root,
        adopted = true,
        status = if (hold(state, 0) != null) SessionStatus.WaitingInput else SessionStatus.Running,
        phase = state.phase,
        unreviewedFiles = 0,
    )

    /** What the session waits on, as a daemon hold: the plan first, else the phase request. */
    fun hold(state: ModState, sinceMs: Long): HeldApproval? {
        val plan = state.plan
        if (plan != null && plan.decided == null) {
            return HeldApproval(state.sessionId, PLAN_HOLD, plan.markdown, null, sinceMs, plan.version)
        }
        val pending = state.pending ?: return null
        val why = pending.reason.trim()
        return HeldApproval(state.sessionId, "phase change to ${pending.to.name}" + if (why.isNotEmpty()) ": $why" else "", null, null, sinceMs)
    }

    /** An entry file's name: sorts by time, so the mod applies decisions in order. */
    fun entryName(now: Long, random: String): String =
        "${now.toString().padStart(15, '0')}-${random.filter { it.isLetterOrDigit() }.take(12)}.json"

    fun parseAnswer(text: String): ModAnswer? {
        val a = runCatching { Json.parse(text) }.getOrNull() as? Map<*, *> ?: return null
        val ok = a["ok"] as? Boolean ?: return null
        return ModAnswer(ok, a["message"] as? String ?: "")
    }

    /** Every session a live mod governs, read from `dir`. */
    fun readStates(dir: Path, now: Long): List<ModState> {
        val folders = runCatching { Files.list(dir).use { it.toList() } }.getOrDefault(emptyList())
        return folders.mapNotNull { folder ->
            runCatching {
                if (now - Files.getLastModifiedTime(folder.resolve("heartbeat")).toMillis() > HEARTBEAT_STALE_MS) return@runCatching null
                parseState(Files.readString(folder.resolve("state.json")))?.takeIf { it.sessionId == folder.name }
            }.getOrNull()
        }
    }

    /**
     * Hands one decision to the mod and waits for its answer (it reads its inbox every two
     * seconds). Blocking — call off the EDT. An entry it has not taken by the deadline is
     * withdrawn, so it can never apply later behind the operator's back; an answer that
     * lands meanwhile still counts.
     */
    fun send(dir: Path, sessionId: String, entry: ModEntry, timeoutMs: Long = 10_000): ModAnswer {
        val folder = dir.resolve(sessionId)
        val name = entryName(System.currentTimeMillis(), java.util.UUID.randomUUID().toString())
        val inbox = folder.resolve("inbox").resolve(name)
        val outbox = folder.resolve("outbox").resolve(name)
        Files.createDirectories(inbox.parent)
        // Whole or not at all: the mod must never read half a decision.
        val temp = inbox.resolveSibling("$name.tmp")
        Files.writeString(temp, Json.write(mapOf("v" to VERSION) + entry.fields()))
        Files.move(temp, inbox, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        fun take(): ModAnswer? = runCatching { parseAnswer(Files.readString(outbox)) }.getOrNull()?.also {
            Files.deleteIfExists(inbox)
            Files.deleteIfExists(outbox)
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            take()?.let { return it }
            Thread.sleep(250)
        }
        Files.deleteIfExists(inbox)
        return take() ?: ModAnswer(false, "the Claude Code session did not answer in time (is it still running?). Nothing was applied.")
    }
}

data class ModState(
    val sessionId: String,
    val root: String?,
    val phase: Phase,
    val pending: Pending?,
    val plan: Plan?,
    /** Absent from a mod that predates the review bridge. */
    val review: ModReview? = null,
) {
    data class Pending(val to: Phase, val reason: String)
    data class Plan(val version: Int, val title: String, val markdown: String, val decided: String?)
}

/** One operator decision, as the mod reads it. */
sealed interface ModEntry {
    fun fields(): Map<String, Any?>

    data class SetPhase(val to: Phase) : ModEntry {
        override fun fields() = mapOf("kind" to "phase", "to" to ModBridge.modPhase(to))
    }

    data class Request(val approve: Boolean, val reason: String? = null) : ModEntry {
        override fun fields() = mapOf("kind" to "request", "approve" to approve) + (reason?.let { mapOf("reason" to it) } ?: emptyMap())
    }

    /** `side`: `before` or `after`. */
    data class ReviewComment(val path: String, val side: String, val start: Int, val end: Int, val body: String, val excerpt: String? = null) : ModEntry {
        override fun fields() = mapOf("kind" to "review-comment", "path" to path, "side" to side, "start" to start, "end" to end, "body" to body) +
            (excerpt?.let { mapOf("excerpt" to it) } ?: emptyMap())
    }

    data class ReviewCommentEdit(val id: String, val body: String) : ModEntry {
        override fun fields() = mapOf("kind" to "review-comment-edit", "id" to id, "body" to body)
    }

    data class ReviewUncomment(val id: String) : ModEntry {
        override fun fields() = mapOf("kind" to "review-uncomment", "id" to id)
    }

    data class ReviewSubmit(val summary: String = "") : ModEntry {
        override fun fields() = mapOf("kind" to "review-submit", "summary" to summary)
    }

    data object ReviewAccept : ModEntry {
        override fun fields() = mapOf("kind" to "review-accept")
    }

    data class ReviewAcceptFile(val path: String) : ModEntry {
        override fun fields() = mapOf("kind" to "review-accept-file", "path" to path)
    }

    data class ReviewRun(val skill: String) : ModEntry {
        override fun fields() = mapOf("kind" to "review-run", "skill" to skill)
    }

    data object ReviewCancel : ModEntry {
        override fun fields() = mapOf("kind" to "review-cancel")
    }

    /** `scope`: `session` (this session's changes) or `head` (since the last commit). */
    data class ReviewScope(val scope: String) : ModEntry {
        override fun fields() = mapOf("kind" to "review-scope", "scope" to scope)
    }

    /** `decision`: keep or dismiss; a note keeps it. */
    data class Finding(val id: String, val decision: String, val note: String? = null) : ModEntry {
        override fun fields() = mapOf("kind" to "finding", "id" to id, "decision" to decision) + (note?.let { mapOf("note" to it) } ?: emptyMap())
    }

    /** `verdict`: the mod's three, `approve`, `refine` or `reject`. */
    data class PlanVerdict(val version: Int, val verdict: String, val note: String) : ModEntry {
        override fun fields() = mapOf("kind" to "plan", "version" to version, "verdict" to verdict, "note" to note)
    }
}

data class ModAnswer(val ok: Boolean, val message: String)

/** A file under review: `baseline` is its saved copy, `/dev/null` for a created file, null against HEAD. */
data class ModReviewFile(
    val path: String,
    val absolute: String,
    val status: String,
    val added: Int,
    val removed: Int,
    val baseline: String?,
    val skipped: String?,
)

/** `side`: `before` or `after`; lines are 1-based on that side. */
data class ModReviewComment(val id: String, val path: String, val side: String, val start: Int, val end: Int, val body: String, val excerpt: String?)

/** `severity`: high, medium or low; `decision`: keep or dismiss. */
data class ModFinding(
    val id: String,
    val key: String,
    val severity: String,
    val route: String,
    val file: String,
    val line: Int,
    val summary: String,
    val detail: String,
    val fix: String?,
    val decision: String,
    val note: String?,
)

/** The mod's review, as its Review panel holds it. `runningSkill`: the AI review running, if any. */
data class ModReview(
    val scope: String,
    val files: List<ModReviewFile>,
    val comments: List<ModReviewComment>,
    val findings: List<ModFinding>,
    val findingsStatus: String?,
    val runningSkill: String?,
    val skills: List<String>,
)
