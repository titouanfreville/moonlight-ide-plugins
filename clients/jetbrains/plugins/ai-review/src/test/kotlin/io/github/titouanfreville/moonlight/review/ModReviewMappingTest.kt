package io.github.titouanfreville.moonlight.review

import io.github.titouanfreville.moonlight.client.BaselineView
import io.github.titouanfreville.moonlight.client.DiffSide
import io.github.titouanfreville.moonlight.core.ModEntry
import io.github.titouanfreville.moonlight.core.ModFinding
import io.github.titouanfreville.moonlight.core.ModReview
import io.github.titouanfreville.moonlight.core.ModReviewComment
import io.github.titouanfreville.moonlight.core.ModReviewFile
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Ported from `mod-review.test.ts`. */
class ModReviewMappingTest {
    private fun review(
        files: List<ModReviewFile> = listOf(
            ModReviewFile("src/a.ts", "/p/src/a.ts", "M", 1, 1, "/b/abc", null),
            ModReviewFile("src/new.ts", "/p/src/new.ts", "A", 3, 0, "/dev/null", null),
            ModReviewFile("logo.png", "/p/logo.png", "M", 0, 0, null, "binary"),
        ),
        comments: List<ModReviewComment> = emptyList(),
        findings: List<ModFinding> = emptyList(),
    ) = ModReview("session", files, comments, findings, null, null, listOf("code-review"))

    @Test
    fun `queue items - absolute paths, created and from-HEAD flags, skipped left out`() {
        assertEquals(
            listOf(Triple("/p/src/a.ts", false, false), Triple("/p/src/new.ts", true, false)),
            ModReviewMapping.queueItems("s1", "app", review()).map { Triple(it.filePath, it.created, it.fromHead) },
        )
        val head = review(files = listOf(ModReviewFile("a", "/p/a", "M", 1, 0, null, null)))
        assertTrue(ModReviewMapping.queueItems("s1", null, head)[0].fromHead)
    }

    @Test
    fun `baselines - saved copy, created, last commit`() {
        val r = review()
        assertEquals(BaselineView.Content("old"), ModReviewMapping.baselineView(ModReviewMapping.baselineSource(r.files[0]), "old"))
        assertEquals(BaselineView.Created, ModReviewMapping.baselineView(ModReviewMapping.baselineSource(r.files[1]), null))
        val head = ModReviewFile("a", "/p/a", "M", 1, 0, null, null)
        assertEquals(BaselineView.FromHead("c"), ModReviewMapping.baselineView(ModReviewMapping.baselineSource(head), "c"))
        assertEquals(BaselineView.Created, ModReviewMapping.baselineView(ModReviewMapping.baselineSource(head), null))
        assertTrue(ModReviewMapping.baselineView(ModReviewMapping.baselineSource(null), null) is BaselineView.Unavailable)
    }

    @Test
    fun `comments map both ways, by absolute path`() {
        val r = review(comments = listOf(ModReviewComment("c1", "src/a.ts", "before", 2, 3, "why?", "x")))
        val view = ModReviewMapping.commentViews(r).single()
        assertEquals("/p/src/a.ts", view.path)
        assertEquals(DiffSide.Before, view.side)
        assertEquals("x", view.anchorText)
        assertEquals(
            ModEntry.ReviewComment("src/a.ts", "after", 4, 5, "tighter", "y"),
            ModReviewMapping.commentEntry(r, "/p/src/a.ts", DiffSide.After, 4, 5, "tighter", "y").getOrThrow(),
        )
        val fileWide = ModReviewMapping.commentEntry(r, "/p/src/a.ts", DiffSide.After, 0, 0, "split it", null).getOrThrow() as ModEntry.ReviewComment
        assertEquals(1, fileWide.start)
        assertTrue(ModReviewMapping.commentEntry(r, "/elsewhere.ts", DiffSide.After, 1, 1, "x", null).isFailure)
        assertTrue(ModReviewMapping.commentEntry(r, "/p/src/a.ts", DiffSide.After, 0, 0, "  ", null).isFailure)
    }

    @Test
    fun `findings worst first, and what Send review carries`() {
        fun f(id: String, severity: String, decision: String) = ModFinding(id, id, severity, "patch", "a.ts", 1, id, "", null, decision, null)
        val r = review(
            comments = listOf(ModReviewComment("c1", "src/a.ts", "after", 1, 1, "x", null)),
            findings = listOf(f("L", "low", "keep"), f("H", "high", "dismiss"), f("M", "medium", "keep")),
        )
        assertEquals(listOf("H", "M", "L"), ModReviewMapping.sortedFindings(r.findings).map { it.id })
        assertEquals(ModReviewMapping.Counts(1, 2, 1), ModReviewMapping.counts(r))
    }
}
