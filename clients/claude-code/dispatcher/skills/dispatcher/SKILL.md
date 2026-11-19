---
name: dispatcher
description: Size each task and run it in a subagent on the model and effort it is worth (scout, executor, planner, deep). Use before starting any task in a session where the dispatcher is on, when picking or sizing a subagent, or when the user says "lighter" or "go max".
---

# Dispatcher

Cost follows the task, not a fixed session setting. The main session judges and writes briefs; subagents do the work.

## Authorization
This skill is the instruction that allows setting `effort` (and `model`) on the Agent tool. Set both on every delegated call.

## Env check
Once per session, check `CLAUDE_CODE_EFFORT_LEVEL`. If it is set, tell the user it overrides every agent's effort, so the levels below only change the model.

## Rubric
Score the task on:
- **Scope**: one file, one module, several modules, several repos.
- **Newness**: known pattern or new design.
- **Risk**: migrations, security, PII, prod data, public API.
- **Ambiguity**: is the outcome specified, or must it be decided?
- **Testability**: can tests or a command prove the result?

Then pick the level:

| Level | Model / effort | For |
|---|---|---|
| scout | haiku / low | find, read, list usages |
| executor | sonnet / medium | specified edits, known patterns, conflicts, bumps, running checks |
| planner | opus / medium | bounded plans and fixes inside one module |
| deep | opus / high (max on "go max") | new features across modules or repos, architecture, migrations, security |

Any risk item pushes the pick to at least planner. Stay in the main session (no delegation) for a handful of tool calls, or for work that needs the whole conversation.

Before picking, check memory for calibration notes on this kind of task and follow them.

## Families, not fixed agents
Pick the best-fitting agent first: a specialist when one exists (a code reviewer, a security auditor, Explore...). Then size it to the level with `model` + `effort` on the Agent call. The plugin's `scout`, `executor`, `planner` and `deep-planner` agents are only the default bodies for when no specialist fits.

## Flow
1. Announce the pick in one line: `→ <task>: <agent> <model>/<effort> (<why>)`.
2. Write a self-contained brief: the goal, what is already ruled out, the files, the scope, and how to prove the result. The agent knows nothing else.
3. The user can override: "lighter" drops one level, "go max" runs deep at max.
4. When an agent returns a question, ask the user, then send the answer to the same agent with SendMessage.
5. A partial result (it hit `maxTurns`) is resumed with SendMessage, not restarted.

## Guards
- **One escalation at most**: a failed or weak result is rerun one level up, once. If that fails too, stop and ask the user.
- **Never retry lower**: an over-sized pick keeps its result; log it as a miss.
- **No progress means stop**: two returns with nothing new (same error, same question) means report and ask.
- **Cost line**: close the task with what ran, e.g. `executor sonnet/medium: 2 runs, escalated`.

## Calibration
Save each miss (too small and escalated, or too big for the result) to memory as one fact, e.g. "GitHub conflict: sonnet/low enough". The rubric reads these before the next pick.
