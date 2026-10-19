# The IDE panels over the Claude Code mod

The VS Code and JetBrains panels (sessions, phase, phase requests, plan review, the review queue with its diffs and comments, and the AI review) work the same whichever backend governs a session: the MoonlightCode daemon, or the `moonlightcode` mod inside Claude Code. This is the file bridge between the mod and the IDEs.

- Mod side: `moonlight/hooks/bridge.ts` (format, validation), `register.tsx` (`publishState`, `applyInbox`).
- VS Code: `moonlight-core/src/mod-bridge.ts`, routed in `moonlight-agentic-support/src/gate.ts`, `moonlight-session-control/src/phase-route.ts` and `moonlight-ai-review/src/review-source.ts` (mapping in `mod-review.ts`, AI review panel in `ai-review-view.ts`).
- JetBrains: `core/.../ModBridge.kt`, routed in `agentic-support/.../Gate.kt`, `session-control/.../SessionOps.kt` and `ai-review/.../ReviewSource.kt` (mapping in `ModReviewMapping.kt`, AI review tab in `AiReviewTab.kt`).

## Why files

The mod cannot listen: it reads and writes files, makes outbound HTTP, and runs timers. So the IDE cannot call it, and the two meet in files. The agent cannot forge an operator decision: the mod's gate refuses every agent write under `~/.moonlight`, in every phase.

## Files

Per session, under `~/.moonlight/mod/sessions/<session id>/`, beside the heartbeat:

| File | Written by | Content |
|---|---|---|
| `heartbeat` | mod, every 2 s | a timestamp; older than 10 s means no live mod |
| `state.json` | mod, while it governs, on change | `{ v: 1, sessionId, root, title, phase, pending: {to, reason} \| null, plan: {version, title, markdown, decided?} \| null, review, updatedMs }` |
| `inbox/<entry>.json` | IDE, one decision each | `{ v: 1, kind, ... }`: see the kinds below |
| `outbox/<entry>.json` | mod | `{ v: 1, ok, message }` |

`title` is the session's name for the session lists, as Claude Code shows it: the operator's rename, else the title Claude Code generated (both read from the transcript), else the first line of the operator's first prompt; `null` until then, and the IDEs show the folder name.

### `review`

`{ scope: "session"|"head", files, comments, findings, findingsStatus, run: {skill} | null, skills }`

- `files`: `{ path (root-relative), absolute, status, added, removed, baseline?, skipped? }`. `baseline` is the saved copy the mod took before the session's first write (read it directly), `/dev/null` for a file the session created; absent in `head` scope, where the before side is `git show HEAD:<file>`.
- `comments`: `{ id, path, side: before|after, start, end (1-based), body, excerpt? }`. No replies, no resolve: a comment leaves the list when the review is sent.
- `findings`: what the last AI review skill found (`moonlight-findings`), each `{ id, key, severity, route, file, line, summary, detail, fix?, decision: keep|dismiss, note? }`.
- The file list is recomputed when a baseline is taken, after each applied decision, and every 10 s otherwise.

### Inbox kinds

| Kind | Fields | Effect |
|---|---|---|
| `phase` | `to` | the operator's phase change |
| `request` | `approve`, `reason?` | answers the agent's phase request |
| `plan` | `version`, `verdict`, `note`, `comments?` | the plan verdict |
| `review-comment` | `path`, `side`, `start`, `end`, `body`, `excerpt?` | adds a line comment on a file under review |
| `review-comment-edit` / `review-uncomment` | `id` (+ `body`) | edits or removes one |
| `review-submit` | `summary?` | sends the comments and kept findings to the agent as one prompt |
| `review-accept` | | closes the review (refused while comments or kept findings are pending) |
| `review-accept-file` | `path` | "Mark reviewed": the file's baseline becomes its current content (session scope only), so it leaves the list and comes back with its next change, whatever tool makes it |
| `review-run` / `review-cancel` | `skill` | runs an installed review skill, or frees a run that will not answer |
| `review-scope` | `scope`: `session` or `head` | what the review covers: this session's changes, or everything since the last commit |
| `finding` | `id`, `decision`, `note?` | triage; a note keeps the finding |

The mod writes `state.json` before the answers, so an IDE that reads its answer then the state finds its change there.

- Phases use the mod's names (`plan`, `auto`, `test`, `review`, `commit`); the IDEs map them to the daemon's (`Plan`, `AutoImplement`, ...).
- Entry names start with a zero-padded time, so the mod applies them in order. The IDE writes an entry whole (temp file, then rename), waits up to 10 s for its answer, then removes both files. An entry the mod has not answered by then is withdrawn, so it never applies behind the operator's back.
- The mod reads its inbox on its 2 s tick, only while it governs, through the same functions its panes use: `operatorSetPhase`, `decide`, `sendPlanVerdict`. A plan verdict for another version than the current one, or on lines outside the plan, is refused.
- The IDE's four plan verdicts map to the mod's three (open question and refine both send the plan back; no-go rejects). The IDE's composed feedback, which carries its own verdict tag, travels as the note.

## The IDE side

- **Sessions**: the mod's live sessions (fresh heartbeat, readable `state.json`) are merged with the daemon's, read every 2 s whether or not a daemon answers. They show as adopted (the mod governs every session it loads in), titled `<folder> (Claude Code plugin)`.
- **Holds**: an undecided plan becomes a plan hold (it opens the plan panel), else a pending phase request becomes an action hold (Allow / Refuse).
- **Writes**: `governor(sessionId)` says where a decision goes; `sendToMod` writes the entry and waits for the answer.
- **Status bar**: a session the mod governs shows its phase with `· plugin`, whatever the daemon's state.
- **Review**: the review queue lists the mod's files beside the daemon's; the diff's before side is the saved copy (or HEAD); comments go to the mod. Under the mod, Reject sends its message as a file comment at once and the file stays in the queue (a blank Reject is refused); Ignore is not offered, and threads take no replies and no resolve.
- **AI review**: VS Code's **MoonlightCode: Open AI Review** panel and JetBrains' **AI Review** tab run a review skill and triage its findings, then **Send review** or **Accept**.

## Not covered

- Findings for daemon sessions: the daemon has no findings API.
- A newer bridge version than an IDE reads: its `state.json` is skipped (the session does not show) rather than misread.
