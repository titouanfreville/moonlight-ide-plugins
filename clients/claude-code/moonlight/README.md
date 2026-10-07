# MoonlightCode for Claude Code (`moonlightcode` mod)

A Claude Code plugin of function hooks that brings MoonlightCode into the session itself, without the daemon:

- **Phases**: the daemon's five (Plan → Auto → Test → Review → Commit). Plan and Commit keep project files read-only while Claude Code runs in auto mode; Auto, Test and Review let it write. Per project, Plan by default.
- **Plan panel**: the agent presents its plan with `present_plan`; you comment its lines and answer Approve, Ask for changes, or Reject. Claude Code's own plan mode is not used: it would leave auto mode.
- **Review panel**: the changed files, each file's diff, comments anchored to diff lines, and the triage of what an AI review skill found.

Design and test evidence: [`.bmad-output/spike-1-mod-findings.md`](../../../.bmad-output/spike-1-mod-findings.md).

## Install it

From this repository's marketplace, for every session (function hooks are early access: the variable is needed):

```bash
claude plugin marketplace add titouanfreville/moonlight-ide-plugins --sparse .claude-plugin clients/claude-code
claude plugin install moonlightcode@moonlight
```

and in the `env` block of `~/.claude/settings.json`: `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"`.

The MoonlightCode VS Code and JetBrains plugins do both for you: when no daemon can be started, they offer to install it (or run **MoonlightCode: Install the Claude Code Plugin**). They take the repository's marketplace, or the copy bundled in them when GitHub is out of reach. Installed this way, the mod also gates the sessions Anthropic's own Claude Code plugins start, which no launch flag of ours reaches.

## With the daemon

The mod is the fallback, not a second gate. At session start it reads `~/.moonlight/control.json` (`$MOONLIGHT_HOME` when set) and asks the daemon's `/control/gating-status`:

- **The daemon answers with its hooks installed**: it governs, and the mod stands by. No sandbox config, no `/phase`, `/ml-plan`, `present_plan` or `request_phase`: the daemon's own `mcp__moonlight__*` verbs and the IDE panels are the way. The hint under the prompt says `☾ gated by the MoonlightCode daemon`. The Review panel (`/ml-review`) still works.
- **No answer within 1.5 s, or hooks missing**: the mod governs, as below.
- While it stands by, the mod still refuses Edit, Write and NotebookEdit on its own files (the mod, `~/.moonlight`, Claude Code's settings).
- **The daemon stops governing mid-session**: after three missed probes in a row (about 6 s, so a daemon restart flips nothing), the mod takes the session over, in Plan unless another live mod session governs the project (below): the stored phase is not trusted otherwise, since the mod's sandbox did not guard it meanwhile. A toast and a note to the agent say so; `/phase` moves on.
- A session the mod governs stays the mod's when the daemon comes back: two gates would hold two phases. New sessions go to the daemon.
- The daemon is checked with `/control/gating-status` at session start (its hooks must be installed), then with the cheaper `/control/health` while it governs, 3 s each.
- While it stands by, the mod takes its own deny entries out of the project's sandbox (the gate's own files stay denied), so leftovers from an earlier phase never block a session the daemon governs. The mod records what it added per project, so one project's phase change never touches another's lists.
- A takeover keeps the project's phase when another live session already governs the project with the mod: the phase is the project's, and that session kept it guarded.

## In the IDE

The MoonlightCode VS Code and JetBrains panels show the sessions the mod governs beside the daemon's: their phase, a phase request waiting (Allow / Refuse), the plan to review. Decisions made there reach the mod through files under `~/.moonlight/mod/sessions/<id>/`; see [`../fallback-bridge.md`](../fallback-bridge.md).

## Load it from a checkout

To develop the mod, load the working copy instead:

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ~/path/to/moonlight-ide-plugins/clients/claude-code/moonlight
```

To load it in every session, set it in the `env` block of `~/.claude/settings.json`:

```json
"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
"CLAUDE_CODE_PLUGIN_DIRS": "~/path/to/moonlight-ide-plugins/clients/claude-code/moonlight",
"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
```

## Phases

The same workflow as the MoonlightCode daemon (`crates/domain/src/phase.rs`). Claude Code runs in auto mode in every phase; the mod's policy is what differs.

| Phase | Project files | Notes (`.ai/`, `.bmad-output/`, `.bmad/`) | Next |
|---|---|---|---|
| **◐ Plan** | read-only | writable | Auto |
| **● Auto** | writable | writable | Test |
| **● Test** | writable | writable | Review |
| **● Review** | writable | writable | Commit |
| **■ Commit** | read-only | read-only: everything frozen until you commit | Plan |

- In the read-only phases (Plan, Commit), Bash and Monitor run under the sandbox with the project denied (in every phase, both are refused unless the sandbox is safe and carries the gate's deny list), the Edit and Write tools only reach the folders still open (`/tmp` always is), and any other tool must be on the read-only allow-list.
- In every phase, the agent can't write the gate's own files: the mod, `~/.moonlight`, the project's `.moonlight/`, and Claude Code's settings (`.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json`), so an Auto session can't widen the next Plan. Bash is refused while the effective sandbox has an `allowWrite` entry that opens one of them.
- The gate fails closed: a gate hook that fails or runs out of time refuses its call, and an unreadable `.claude/settings.local.json` makes the gate refuse tools (with a toast) until it is fixed.
- When you change the phase yourself (`/phase`, the hint, the pane), the agent finds a note about it at its next turn, and a pending `request_phase` is dropped.
- `present_plan` is a Plan tool: it is refused in the other phases. Approving a plan moves Plan to Auto.
- `next` is cyclic: after Commit, Plan starts the next unit of work. You may also jump to any phase.
- Aliases, as the daemon takes them: `discovery`, `discover` for Plan; `implement`, `autoimplement`, `auto-implement` for Auto.

The phase is **per project**, shared by every session open on it. A session that sets a project to a read-only phase makes Bash read-only there for the other sessions too, since they share the project's sandbox settings.

Loading it turns the gate on for the session's project, in **Plan**: Bash runs under Claude Code's sandbox with the project read-only, and only the notes folders (`.ai/`, `.bmad-output/`, `.bmad/`) are writable. Type `/phase auto` to work normally.

The phase shows **under the prompt**, on the hint line: the current one as a badge (**◐ PLAN** yellow, **● AUTO** green, **● TEST** cyan, **● REVIEW** blue, **■ COMMIT** red), its rule in the same colour, then a dim **· next: …** that steps to the next phase, then Claude Code's own hint. `/phase` opens the Moonlight pane: the badge, then the five phases as dim words to jump to any. When the agent asks for a phase change, a band shows **above the prompt** with **Approve** (`y`) and **Deny** (`n`); otherwise nothing is drawn there.

The panes keep colour for state: the phase badge carries its phase's colour, the diff keeps Claude Code's own. The rest is plain or dim text. 🤖 marks what the AI reviewer found, with its severity as a word (**high**, medium, dim low); 💬 marks your comments, whose text hangs under them behind a `┃` rail.

The panes, the hint and the band draw on the **terminal and desktop** surfaces. The VS Code extension draws no mod UI today, so use the commands there.

## Commands (operator only: refused when the model, the SDK or a plugin runs them)

| Command | What it does |
|---|---|
| `/phase` | Show the phase, its rule and the next one, and open the Moonlight pane |
| `/phase plan\|auto\|test\|review\|commit` | Change the phase (aliases accepted) |
| `/phase next` | Move to the next phase (Commit → Plan) |
| `/phase approve` · `/phase deny` | Answer the agent's `request_phase` |
| `/ml-plan` | Open or close the Plan panel, and print the plan with line numbers, its comments and its state |
| `/ml-plan comment <line[-end]> <text>` | Comment a line or a range of the plan; `\n` starts a new line |
| `/ml-plan uncomment <id>` | Remove a comment |
| `/ml-plan approve [note]` | Approve the plan: the phase moves to Auto, and the agent is told to implement it |
| `/ml-plan refine <note>` | Send the comments and the note back: the agent revises and presents the whole plan again |
| `/ml-plan reject <reason>` | Reject the plan: the agent stops |
| `/ml-review` | Open or close the Review panel, and list changed files and comments |
| `/ml-review comment <path:line[-end]> <text>` | Comment a line or a range of the current file; `\n` starts a new line |
| `/ml-review uncomment <id>` | Remove a comment |
| `/ml-review submit [summary]` | Send every comment to the agent as one message (the panel's **Send review**), then clear them |
| `/ml-review accept` | Close the review: the next one starts from here |
| `/ml-review run [skill]` | Run one review skill (the only attached one, else name any installed one; your list is left as it is) |
| `/ml-review cancel` | Free the panel from a review that will not answer |
| `/ml-review attach <skill>` · `detach <skill>` | Your own list of review skills to choose from at run time |
| `/ml-review skills [reset]` | The review skills offered, and the attached ones not installed; `reset` drops your own list |
| `/ml-review scope session\|head` | Review this session's changes, or everything since `HEAD` |

`/ml-review` rather than `/review`: `/review` is the alias of Claude Code's built-in `/code-review`.

## Plan panel

In the Plan phase, the agent proposes a plan by calling `mcp__moonlightcode__present_plan` with the whole plan as Markdown (and an optional title). The tool answers at once and tells the agent to stop and wait; the verdict reaches it later as a `[moonlight]` prompt, which starts a turn. `EnterPlanMode` and `ExitPlanMode` are refused in Plan, with a pointer to `present_plan`: Claude Code's plan mode would leave auto mode.

- Each call is the session's next version (**v1**, **v2**…), saved to `~/.moonlight/mod/sessions/<session>/plan/v<N>.md`. A new version starts with no comments.
- The **Plan** pane opens with focus: **Plan vN** and its title, then the plan line by line, numbered, each drawn as Claude's replies are: headings, bullets (nested by their indent), **bold**, `code` and links through Markdown; code blocks highlighted in their fence's language, the fence shown only as that language. Table rows stay plain text, since a row drawn alone is not a table.
- Click the **`+`** before a line to comment it; click a second `+` to extend to a range; click the same single line again to clear. `•` marks a line with a comment, `✕` removes one. Type the comment, then Enter; end a line with `\` to write several.
- **Note (optional)**: an overall note for the agent; Enter saves it.
- **✓ Approve**: moves the phase to Auto (from Plan, or Commit), then tells the agent to implement the plan, with your note and comments to keep in mind.
- **✎ Ask for changes**, once there is a comment or a note: sends them, each comment with the plan lines it is about; the agent revises and calls `present_plan` again.
- **✕ Reject** asks for a reason (required), then tells the agent to stop. The phase does not change.
- The note is sent as typed, Enter or not; a reject reason or a `/ml-plan` note goes with it.
- After a verdict, the version shows as decided. If the send fails, a toast says why, an approval's phase change is undone, and the comments and the note come back, unless the agent has presented a newer version meanwhile.

In VS Code, where no mod UI draws, use `/ml-plan`: it prints the plan with its line numbers to comment.

## Review panel

In the terminal's fullscreen layout, at least 110 columns wide, the panel docks on the right; elsewhere it shows above the prompt. Type `/ml-review` to open or close it. When it has focus, the arrow keys scroll, Tab walks the buttons, and Esc returns to the prompt.

- **Files view**: click a file to open its diff. `r` refreshes the list.
- **File view**: the diff, GitHub style. Claude Code's own highlighter draws each line: line numbers, `+`/`-`, green/red, syntax colours.
  - **Unified** by default; **side by side** once the panel is at least 140 columns wide. **Split / Unified** (`s`) forces one or the other.
  - **⤢ Expand** (`e`), docked panel only: reopens the panel at the terminal's full width, like a modal. **⤡ Shrink** goes back to the dock's normal width. A width you set by hand wins.
  - Click the **`+`** in front of a line to comment it. Click a second `+` to extend to a range: every row between, removed, added and context lines alike, so a whole changed block takes one comment. Click the same single line again to clear. The line under the header shows the selection (`src/f.ts:2-4 (+ removed 2-3)`).
  - `▌` marks the selection, `•` a line with a comment.
  - Type the comment, then press Enter. For several lines, end a line with `\` before Enter: it joins the draft shown above the field, and the next line without `\` saves the comment. `✕` removes a comment.
  - `b` goes back to the files view.
- **Send**: once there is a comment, **Send review** (`s` in the files view, **Send** in a file's header) sends every comment to the agent as one message: grouped by file, in line order, each with the lines it is about. The files view's **Summary** field adds an optional overall note; Enter there submits too. The review goes in as a prompt, so the agent starts on it at once, or as soon as its current turn ends. If the send fails, the comments come back.

- **✓ All good** (`a` in the files view, also in a file's header, or `/ml-review accept`), when no comment is pending: accepts the review. The agent is told all is good, the saved copies are dropped, and the next review shows only what the agent changes from then on.

### AI review: an existing review skill, attached

The mod has no review skill of its own: it attaches the ones you already use. A skill matches bare or under its plugin (`bmad-method:bmad-code-review`), and only the installed ones are offered.

Which skills are attached, first match wins:

1. **Yours**: `/ml-review attach <skill>` and `detach <skill>` keep your own list; `/ml-review skills reset` drops it.
2. **Your team's**: the plugin's `reviewSkills` option, comma-separated. A team sets it for everyone in managed or shared settings:

   ```json
   "pluginConfigs": { "moonlightcode": { "options": { "reviewSkills": "deep-review, bmad-code-review, code-review" } } }
   ```

3. **Built in**: `bmad-code-review` (BMAD) and `code-review` (Claude Code).

- **Run one**: **▸ Run AI review** (`i`) in the files view. With one skill attached it runs it; with several it asks which. Or `/ml-review run <skill>`, or invoke an attached skill yourself as usual.
- **One review at a time**: while it runs, the panel shows **⏳ \<skill\> running…** and refuses a second run; **Cancel** frees it from a review that will not answer.
- When the running review's skill starts, the mod appends to its prompt the review's scope (the panel's files, with the saved copies to diff against) and asks for one `moonlight-findings` JSON block at the end, the format MoonlightCode's desktop panel reads. Only that skill's prompt gets it, not an attached skill it calls in turn. How the skill reviews is left to it.
- When an answer ends with that block, its findings load into the panel (outside a review run, only if you have not started triaging: a note or a dismissal keeps the current findings), worst first: in the files view's **AI review** list, and under their line in the file's diff. A block that does not parse shows as an error, never as a clean review; a review that ends without one says so.
- **Triage** each finding: **✕ Dismiss** drops it from this pass (**↺ Keep** brings it back); **✎ Note** adds your decision about it, which the agent is told wins over the reviewer.
- **Send review** sends the kept findings, with your notes, together with your comments, as one message. **✓ All good** waits until no kept finding is left.

### What is diffed

- **This session** (the default once Claude has changed a file): each file against a copy the mod saved just before Claude first changed it with Edit, Write or NotebookEdit. No git needed.
  - Copies live in `~/.moonlight/mod/sessions/<session>/baseline/`, out of the agent's reach. A copy is named by its content, so the same content is stored once.
  - Files over 1 MB and binary files are not copied; the panel lists them with the reason.
  - Changes made through Bash (`sed -i`, a formatter…) have no copy: switch to **Since last commit** to see them.
  - The copies are dropped on **All good** and on `/clear`. A session that ends otherwise keeps them for `--resume`; after a week without a heartbeat, the next session start removes them.
- **Since last commit** (`v` toggles): everything changed against `HEAD`. Untracked files count their lines as added (binary ones say so; past 200 untracked files the rest are listed uncounted). If the session's root is inside a git repository, the panel reviews that repository. Otherwise it looks for repositories up to 4 levels below the root, skipping `node_modules`, `target`, `.venv`, `dist` and `build`, and lists each one's changes under its folder name.

Paths in comments start from the session root.

## Develop

```bash
claude plugin validate .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
```

The mod protects its own folder from the agent in every phase. To let an agent edit it, the operator creates `~/.moonlight/mod/dev-unlock`; the agent can't create that file. Plan still applies.

The backstop (`hooks/backstop.sh`) is a classic `PreToolUse` hook, registered in `~/.claude/settings.json`. It is active only while `~/.moonlight/mod/governed` exists. In that state, a session without a fresh heartbeat from the mod can only use read-only tools.
