package io.github.titouanfreville.moonlight.review

import io.github.titouanfreville.moonlight.client.BaselineView
import io.github.titouanfreville.moonlight.client.CommentScope
import io.github.titouanfreville.moonlight.client.DiffSide
import io.github.titouanfreville.moonlight.client.FeedbackDelivery
import io.github.titouanfreville.moonlight.client.RejectResponse
import io.github.titouanfreville.moonlight.client.ReviewComment
import io.github.titouanfreville.moonlight.client.ReviewQueueItem
import io.github.titouanfreville.moonlight.client.SubmitReviewResponse
import io.github.titouanfreville.moonlight.core.Governor
import io.github.titouanfreville.moonlight.core.ModEntry
import io.github.titouanfreville.moonlight.core.ModReview
import io.github.titouanfreville.moonlight.core.MoonlightApi
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.TimeUnit

/**
 * The review calls of this plugin, on whichever backend governs the session: the daemon
 * (its control API), or the MoonlightCode mod inside Claude Code (its review in
 * `state.json`, its decisions through the inbox; see [ModReviewMapping]). A port of VS
 * Code's `review-source.ts`, with the daemon client's names and shapes so the panel code
 * only swaps `core.control.x` for `ReviewSource.x`. Blocking — call off the EDT.
 */
object ReviewSource {
    private const val NOT_FOR_MOD = "not available for sessions the Claude Code plugin governs"

    private val core: MoonlightApi get() = MoonlightApi.getInstance()

    fun isModSession(sessionId: String): Boolean = core.governor(sessionId) == Governor.Mod

    fun modReview(sessionId: String): ModReview? = if (isModSession(sessionId)) core.modReview(sessionId) else null

    /** One decision to the mod; a refusal throws with the mod's own words. */
    fun send(sessionId: String, entry: ModEntry): String {
        val answer = core.sendToMod(sessionId, entry)
        if (!answer.ok) throw IllegalStateException(answer.message)
        return answer.message
    }

    private fun modQueue(session: String?, path: String?): List<ReviewQueueItem> =
        core.sessions().filter { isModSession(it.sessionId) }
            .flatMap { s -> core.modReview(s.sessionId)?.let { ModReviewMapping.queueItems(s.sessionId, s.title, it) }.orEmpty() }
            .filter { (session == null || it.sessionId == session) && (path == null || it.filePath == path) }

    fun reviewQueue(session: String? = null, path: String? = null, diffs: Boolean = true): List<ReviewQueueItem> {
        val fromMod = modQueue(session, path)
        if (session != null && isModSession(session)) return fromMod
        return try {
            core.control.reviewQueue(session, path, diffs) + fromMod
        } catch (e: Exception) {
            // No daemon: the mod's sessions are still reviewable. With none, say why.
            if (fromMod.isNotEmpty() || core.sessions().any { isModSession(it.sessionId) }) fromMod else throw e
        }
    }

    fun baseline(sessionId: String, filePath: String): BaselineView {
        val review = modReview(sessionId) ?: return core.control.baseline(sessionId, filePath)
        val source = ModReviewMapping.baselineSource(ModReviewMapping.fileAt(review, filePath))
        val text = when (source) {
            is ModReviewMapping.BaselineSource.Copy -> runCatching { Files.readString(Path.of(source.path)) }.getOrNull()
            is ModReviewMapping.BaselineSource.Head -> gitShowHead(Path.of(source.absolute))
            else -> null
        }
        return ModReviewMapping.baselineView(source, text)
    }

    private fun gitShowHead(file: Path): String? = runCatching {
        val process = ProcessBuilder("git", "show", "HEAD:./${file.fileName}").directory(file.parent.toFile()).start()
        val out = process.inputStream.use { String(it.readAllBytes()) }
        process.errorStream.close()
        if (process.waitFor(10, TimeUnit.SECONDS) && process.exitValue() == 0) out else null
    }.getOrNull()

    fun comments(sessionId: String): List<ReviewComment> {
        if (!isModSession(sessionId)) return core.control.comments(sessionId)
        return core.modReview(sessionId)?.let(ModReviewMapping::commentViews).orEmpty()
    }

    fun addComment(
        sessionId: String,
        scope: CommentScope,
        path: String,
        side: DiffSide,
        startLine: Int,
        endLine: Int,
        body: String,
        anchorText: String? = null,
        parentId: String? = null,
    ) {
        if (!isModSession(sessionId)) {
            core.control.addComment(sessionId, scope, path, side, startLine, endLine, body, anchorText, parentId)
            return
        }
        if (parentId != null) throw IllegalStateException("Replies are $NOT_FOR_MOD: edit the comment instead.")
        val review = core.modReview(sessionId) ?: throw IllegalStateException("no review in that session")
        val lines = if (scope == CommentScope.File) 0 to 0 else startLine to endLine
        send(sessionId, ModReviewMapping.commentEntry(review, path, side, lines.first, lines.second, body, anchorText).getOrThrow())
    }

    fun updateComment(sessionId: String, id: String, body: String? = null, resolved: Boolean? = null) {
        if (!isModSession(sessionId)) {
            core.control.updateComment(sessionId, id, body, resolved)
            return
        }
        if (resolved != null) throw IllegalStateException("Resolving is $NOT_FOR_MOD: delete the comment instead.")
        if (body != null) send(sessionId, ModEntry.ReviewCommentEdit(id, body))
    }

    fun deleteComment(sessionId: String, id: String) {
        if (isModSession(sessionId)) send(sessionId, ModEntry.ReviewUncomment(id)) else core.control.deleteComment(sessionId, id)
    }

    /** The mod prompts the agent itself, so its review is always delivered (`Queued`). */
    fun submitReview(sessionId: String): SubmitReviewResponse? {
        if (!isModSession(sessionId)) return core.control.submitReview(sessionId)
        val counts = core.modReview(sessionId)?.let(ModReviewMapping::counts) ?: return null
        val count = counts.comments + counts.kept
        if (count == 0) return null
        send(sessionId, ModEntry.ReviewSubmit())
        return SubmitReviewResponse(count, emptyList(), null, FeedbackDelivery.Queued)
    }

    fun markDelivered(sessionId: String, commentIds: List<String>) {
        if (!isModSession(sessionId)) core.control.markDelivered(sessionId, commentIds)
    }

    fun accept(sessionId: String, filePath: String) {
        if (!isModSession(sessionId)) {
            core.control.accept(sessionId, filePath)
            return
        }
        val file = core.modReview(sessionId)?.let { ModReviewMapping.fileAt(it, filePath) }
            ?: throw IllegalStateException("this file is not under review in that session")
        send(sessionId, ModEntry.ReviewAcceptFile(file.path))
    }

    /**
     * Under the mod, a reject is a comment on the file, sent at once. As under the daemon,
     * the file leaves the queue; a blank reject sends nothing. Leaving the queue takes a new
     * baseline, so the agent's fix is what the next review shows.
     */
    fun reject(sessionId: String, filePath: String, message: String): RejectResponse {
        if (!isModSession(sessionId)) return core.control.reject(sessionId, filePath, message)
        if (message.isNotBlank()) {
            addComment(sessionId, CommentScope.File, filePath, DiffSide.After, 0, 0, message)
            send(sessionId, ModEntry.ReviewSubmit())
        }
        accept(sessionId, filePath)
        return RejectResponse(false, FeedbackDelivery.Queued)
    }

    fun setIgnored(sessionId: String, filePath: String, ignored: Boolean) {
        if (isModSession(sessionId)) throw IllegalStateException("Ignore is $NOT_FOR_MOD.")
        core.control.setIgnored(sessionId, filePath, ignored)
    }
}
