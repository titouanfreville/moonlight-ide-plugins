# MoonlightCode Core

No UI. Owns the one backend connection the other MoonlightCode extensions share: a
single poll loop, the session and gating state it produces, and the registry of
terminals we started.

It exists because some state genuinely cannot be duplicated across extensions. The
terminal registry is the clear case — the review extension delivers into a terminal
the session-control extension launched, so exactly one of them has to own that map.
Session status is the other: independent polling lets the review surface believe a
session is idle while the status bar shows it working, and the operator ends up
reviewing a moving target on a stale read.

Everything else declares `extensionDependencies` on this, so VSCode guarantees it is
installed and activated first.

## When no daemon runs

Core starts `moonlightd`, or downloads it in released builds. When the daemon still
does not answer after three polls, Core offers to install the MoonlightCode plugin for
Claude Code (`moonlightcode@moonlight`), which gates each Claude Code session itself
and stands by whenever a daemon governs. It also turns on function hooks in
`~/.claude/settings.json`. The plugin comes from the repository's marketplace, or from
the copy bundled in this extension when GitHub is out of reach. Run
**MoonlightCode: Install the Claude Code Plugin (No-Daemon Fallback)** to do it by hand.
Installed this way, it also gates the sessions Anthropic's own Claude Code extension
starts.

## Sessions the Claude Code plugin governs

Core also lists the sessions the MoonlightCode plugin for Claude Code governs, read
every two seconds from `~/.moonlight/mod/sessions/`, whether or not a daemon answers.
The plan panel, the hold notifications and the phase pickers work on them as on the
daemon's: `governor(sessionId)` says which backend a decision goes to, and
`sendToMod` hands it over. The format is in `clients/claude-code/fallback-bridge.md`.
