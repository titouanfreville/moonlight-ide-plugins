package io.github.titouanfreville.moonlight.agentic

import io.github.titouanfreville.moonlight.core.ModEntry

/**
 * A plan verdict for a session the MoonlightCode mod governs, in the mod's words — a port
 * of `mod-route.ts`.
 *
 * The plan panel is the same for both backends; only the delivery differs. The mod takes
 * one entry with the composed feedback as its note. The IDE's four verdicts become the
 * mod's three, and the feedback keeps the IDE's verdict tag, so the agent still reads
 * which of the four it was.
 */
fun modPlanEntry(version: Int, plan: String, comments: Map<Int, String>, verdict: PlanVerdict): ModEntry.PlanVerdict =
    ModEntry.PlanVerdict(
        version = version,
        verdict = when (verdict) {
            PlanVerdict.Approve -> "approve"
            PlanVerdict.NoGo -> "reject"
            PlanVerdict.OpenQuestion, PlanVerdict.Refine -> "refine"
        },
        note = if (verdict.approves && comments.isEmpty()) "" else denialReason(plan, comments, verdict),
    )
