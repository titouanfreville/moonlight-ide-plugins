#!/bin/sh
# MoonlightCode backstop: a classic PreToolUse hook, registered in
# ~/.claude/settings.json. It runs in every Claude Code session, mod or not.
#
# When this machine is governed (~/.moonlight/mod/governed exists, a file only the
# operator can create), a session whose moonlight mod heartbeat is missing or
# stale may only use read-only tools: no mod loaded means no gate, so fail closed.
# This also stops a session without the mod from writing on behalf of a
# governed one (a cross-session route).

MAX_AGE_SECONDS=10

input=$(cat)
[ -f "$HOME/.moonlight/mod/governed" ] || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

case "$tool" in
  Read|Grep|Glob|LSP|WebFetch|WebSearch|ToolSearch|TodoWrite|AskUserQuestion) exit 0 ;;
esac

# The id builds a path: only the characters a session id has (no `/`, no `..`).
case "$session_id" in
  ''|*[!A-Za-z0-9_-]*) session_id='' ;;
esac

heartbeat="$HOME/.moonlight/mod/sessions/$session_id/heartbeat"
if [ -n "$session_id" ] && [ -f "$heartbeat" ]; then
  # GNU stat first: BSD stat rejects -c, while GNU stat reads `-f %m` as a
  # filesystem query and prints to stdout before failing.
  modified=$(stat -c %Y "$heartbeat" 2>/dev/null || stat -f %m "$heartbeat" 2>/dev/null)
  case "$modified" in
    ''|*[!0-9]*) ;;
    *) [ $(( $(date +%s) - modified )) -le "$MAX_AGE_SECONDS" ] && exit 0 ;;
  esac
fi

reason="Moonlight: the gate mod is not running in this session (no fresh heartbeat), so $tool is refused. Load the moonlight mod, or ask the operator."
jq -n --arg reason "$reason" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
