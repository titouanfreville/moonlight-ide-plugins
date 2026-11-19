# dispatcher

Makes every Claude Code session a dispatcher: it sizes each task, runs it in a subagent on the model and effort the task is worth, and reports back. Big cross-module planning gets Opus at high effort; a merge conflict gets Sonnet at medium. The main session stays on whatever `/model` and `/effort` you set.

## What is in it
- `hooks/` — a SessionStart hook that injects three lines into context (startup, resume, clear, compact), so the behavior is on by default.
- `skills/dispatcher/` — the rubric, flow, guards and calibration. It is also the instruction that allows setting `effort` on the Agent tool.
- `agents/` — `scout` (haiku/low, read-only), `executor` (sonnet/medium), `planner` (opus/medium), `deep-planner` (opus/high). Default bodies only: the skill prefers a specialist agent when one fits, and sizes it with `model` + `effort` on the call.

The agents have no `tools:` list on purpose: they keep every MCP server of the session (debugger, IDE, codegraph) so they can test and fix their own work. Hooks and permission mode of the session still apply to them, including the MoonlightCode gate.

## Load it
- One session: `claude --plugin-dir clients/claude-code/dispatcher`
- Every session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS`, or install it from this repo's marketplace:
  `/plugin install dispatcher --marketplace titouanfreville/moonlight-ide-plugins`

`CLAUDE_CODE_EFFORT_LEVEL`, when set, overrides every agent's effort; the skill tells you when it finds it.
