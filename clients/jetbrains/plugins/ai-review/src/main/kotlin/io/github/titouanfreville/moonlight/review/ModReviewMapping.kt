package io.github.titouanfreville.moonlight.review

import io.github.titouanfreville.moonlight.client.BaselineView
import io.github.titouanfreville.moonlight.client.CommentAuthor
import io.github.titouanfreville.moonlight.client.CommentScope
import io.github.titouanfreville.moonlight.client.DiffSide
import io.github.titouanfreville.moonlight.client.ReviewComment
import io.github.titouanfreville.moonlight.client.ReviewQueueItem
import io.github.titouanfreville.moonlight.core.ModEntry
import io.github.titouanfreville.moonlight.core.ModFinding
import io.github.titouanfreville.moonlight.core.ModReview
import io.github.titouanfreville.moonlight.core.ModReviewFile

/**
 * A session the MoonlightCode mod for Claude Code governs, in the shapes the review panel
 * already speaks (the daemon's) — a port of VS Code's `mod-review.ts`. Pure, so tested
 * without an IDE.
 */
object ModReviewMapping {
    /** The mod's files, as queue items: diffs are never inlined (the diff tab opens them). */
    fun queueItems(sessionId: String, title: String?, review: ModReview): List<ReviewQueueItem> =
        review.files.filter { it.skipped == null }.map { f ->
            ReviewQueueItem(
                sessionId = sessionId,
                sessionTitle = title,
                filePath = f.absolute,
                touches = 1,
                tool = "Edit",
                created = f.baseline == "/dev/null" || f.status == "A" || f.status == "??",
                fromHead = f.baseline == null,
                diff = "",
                diffOmitted = true,
            )
        }

    fun fileAt(review: ModReview, absolute: String): ModReviewFile? = review.files.firstOrNull { it.absolute == absolute }

    /** Where the before side comes from; the reading is the caller's. */
    sealed interface BaselineSource {
        data class Copy(val path: String) : BaselineSource
        data object Created : BaselineSource
        data class Head(val absolute: String) : BaselineSource
        data class Unavailable(val reason: String) : BaselineSource
    }

    fun baselineSource(file: ModReviewFile?): BaselineSource = when {
        file == null -> BaselineSource.Unavailable("the file is no longer under review")
        file.baseline == "/dev/null" -> BaselineSource.Created
        file.baseline != null -> BaselineSource.Copy(file.baseline!!)
        else -> BaselineSource.Head(file.absolute)
    }

    fun baselineView(source: BaselineSource, text: String?): BaselineView = when (source) {
        BaselineSource.Created -> BaselineView.Created
        is BaselineSource.Unavailable -> BaselineView.Unavailable(source.reason)
        is BaselineSource.Copy -> text?.let { BaselineView.Content(it) } ?: BaselineView.Unavailable("the saved copy is gone")
        // Not in the last commit: an untracked file, new as far as git knows.
        is BaselineSource.Head -> text?.let { BaselineView.FromHead(it) } ?: BaselineView.Created
    }

    /** The mod's comments as daemon comments: one thread each, never sent, never resolved. */
    fun commentViews(review: ModReview): List<ReviewComment> = review.comments.mapNotNull { c ->
        val file = review.files.firstOrNull { it.path == c.path } ?: return@mapNotNull null
        ReviewComment(
            id = c.id,
            scope = CommentScope.Line,
            path = file.absolute,
            side = if (c.side == "before") DiffSide.Before else DiffSide.After,
            startLine = c.start,
            endLine = c.end,
            body = c.body,
            anchorText = c.excerpt,
            sent = false,
            resolved = false,
            outdated = false,
            author = CommentAuthor.Operator,
            parentId = null,
        )
    }

    /** A new comment as the mod takes it; a file-wide one sits on line 1 and says so. */
    fun commentEntry(review: ModReview, path: String, side: DiffSide, startLine: Int, endLine: Int, body: String, anchorText: String?): Result<ModEntry> {
        val file = fileAt(review, path) ?: return Result.failure(IllegalArgumentException("this file is not under review in that session"))
        // Checked here: the file-wide prefix would get an empty comment past the mod's own check.
        if (body.isBlank()) return Result.failure(IllegalArgumentException("a comment needs some text"))
        val fileWide = startLine < 1
        return Result.success(
            ModEntry.ReviewComment(
                path = file.path,
                side = if (side == DiffSide.Before) "before" else "after",
                start = if (fileWide) 1 else startLine,
                end = if (fileWide) 1 else maxOf(endLine, startLine),
                body = if (fileWide) "(About the whole file) $body" else body,
                excerpt = anchorText?.takeIf { !fileWide && it.isNotEmpty() },
            ),
        )
    }

    private val RANK = mapOf("high" to 0, "medium" to 1, "low" to 2)

    /** Worst first, then by place. */
    fun sortedFindings(findings: List<ModFinding>): List<ModFinding> =
        findings.sortedWith(compareBy<ModFinding>({ RANK[it.severity] ?: 3 }, { it.file }, { it.line }))

    data class Counts(val comments: Int, val kept: Int, val dismissed: Int)

    /** What Send review would carry: the comments, and the findings kept. */
    fun counts(review: ModReview) = Counts(
        comments = review.comments.size,
        kept = review.findings.count { it.decision == "keep" },
        dismissed = review.findings.count { it.decision == "dismiss" },
    )
}
