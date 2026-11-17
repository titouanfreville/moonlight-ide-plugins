//! Which conversation a launched Claude Code process is in *now*.
//!
//! An IDE that launches a session mints an id, passes it as `--session-id`, and binds the
//! session's `moonlight` MCP endpoint to it. That id names a **conversation**, not the
//! process — and a process changes conversation: `/resume` switches to an existing one,
//! `/clear` starts a fresh one. After either, the hooks report the new id (Claude Code
//! sends the current conversation in every hook payload), while the MCP endpoint is still
//! bound to the launch id. Every verb then fails with `session not found` for an id the
//! daemon has never seen — while the gate, which follows the hooks, carries on governing
//! the new one. An agent that can be denied but cannot ask for a phase or propose a plan.
//!
//! The fix is a second, stable identity for the *process*: the launch id. The launcher
//! exports it as [`LAUNCH_ENV`] on the `claude` process; Claude Code passes its
//! environment to the hooks and stdio MCP servers it spawns, so every hook arrives saying
//! both "this launch" and "this conversation". This registry folds those into
//! `launch → current conversation`, and the verb paths resolve through it on every call
//! instead of trusting the id they were handed at launch.
//!
//! In memory only, deliberately. The MCP endpoints live in the daemon process, so they die
//! with it — a persisted mapping would outlive everything that consults it — and the next
//! hook from a running session rebuilds its entry.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use moonlight_domain::ids::SessionId;

/// The environment variable a launcher sets on the `claude` process it starts.
pub const LAUNCH_ENV: &str = "MOONLIGHT_LAUNCH_ID";

/// The launch id this process inherited, if it is one we are willing to trust.
///
/// Validated like a session id, because it travels into the daemon's routing and an id
/// that is not the shape we mint means something upstream is wrong, not something to
/// route on.
pub fn launch_id_from_env() -> Option<String> {
    std::env::var(LAUNCH_ENV).ok().filter(|id| is_launch_id(id))
}

/// The shape every launcher mints: a UUID-like run of hex digits and dashes.
pub fn is_launch_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The Claude Code process this process runs for: its parent, and the parent's parent
/// when the parent is a shell (Claude Code runs hook commands through one, which may or
/// may not `exec` them). Both halves call this — the hook client and the stdio MCP
/// shim — so they name the same pid without either being told it.
///
/// Costs one `ps`; callers keep it off hot paths.
#[cfg(unix)]
pub fn claude_process_ids() -> Vec<u32> {
    let parent = std::os::unix::process::parent_id();
    let mut ids = vec![parent];
    if let Some((grandparent, command)) = parent_of(parent) {
        if is_shell(&command) {
            ids.push(grandparent);
        }
    }
    ids
}

#[cfg(not(unix))]
pub fn claude_process_ids() -> Vec<u32> {
    Vec::new()
}

#[cfg(unix)]
fn parent_of(pid: u32) -> Option<(u32, String)> {
    let out = std::process::Command::new("ps")
        .args(["-o", "ppid=,comm=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    parse_ps_line(&String::from_utf8(out.stdout).ok()?)
}

/// `ps -o ppid=,comm=` prints `  123 /bin/zsh`: the parent pid, then the command.
fn parse_ps_line(line: &str) -> Option<(u32, String)> {
    let (ppid, command) = line.trim().split_once(char::is_whitespace)?;
    Some((ppid.trim().parse().ok()?, command.trim().to_string()))
}

/// A login shell shows as `-zsh`; a path as `/bin/sh`.
fn is_shell(command: &str) -> bool {
    let name = command.rsplit('/').next().unwrap_or(command).trim_start_matches('-');
    matches!(name, "sh" | "bash" | "zsh" | "dash" | "fish")
}

/// What one observation did to a launch's entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchObservation {
    /// First time this launch was seen.
    New,
    /// Still the same conversation.
    Unchanged,
    /// The process changed conversation — `/resume` or `/clear`.
    Moved { from: SessionId },
}

/// `launch id → the conversation that launch is currently in`.
///
/// Also `Claude Code process id → its conversation`, for processes no IDE launched: they
/// carry no launch id, yet their stdio MCP server is just as stuck on the conversation it
/// spawned in. Claude Code is the parent of both its hooks (through a shell) and its MCP
/// servers, so its pid is the one key both halves can name without being told.
#[derive(Debug, Default)]
pub struct LaunchRegistry {
    current: RwLock<HashMap<String, SessionId>>,
    processes: RwLock<HashMap<u32, SessionId>>,
}

/// The registry, shared between the hook gate (which writes it) and the verb paths and
/// control API (which read it).
pub type SharedLaunches = Arc<LaunchRegistry>;

impl LaunchRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that `launch` is now in `session`. Called for every hook that carries one.
    pub fn observe(&self, launch: &str, session: &SessionId) -> LaunchObservation {
        let mut current = self.current.write().unwrap_or_else(|p| p.into_inner());
        match current.insert(launch.to_string(), session.clone()) {
            None => LaunchObservation::New,
            Some(previous) if &previous == session => LaunchObservation::Unchanged,
            Some(previous) => LaunchObservation::Moved { from: previous },
        }
    }

    /// The conversation `launch` is in now, if any hook has said.
    pub fn current(&self, launch: &str) -> Option<SessionId> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(launch)
            .cloned()
    }

    /// The session a verb bound to `launch` acts on: the launch's current conversation,
    /// or — before any hook has arrived — the launch id itself, which is the conversation
    /// the launcher pinned with `--session-id`. That fallback is exactly today's
    /// behaviour, so a launch that never moves is unaffected.
    pub fn resolve(&self, launch: &str) -> SessionId {
        self.current(launch)
            .unwrap_or_else(|| SessionId::new(launch.to_string()))
    }

    /// Record that the Claude Code process `pid` is now in `session`. Called with each pid
    /// a hook names as its own; pid 0 and 1 name no Claude Code process and are ignored.
    pub fn observe_process(&self, pid: u32, session: &SessionId) {
        if pid <= 1 {
            return;
        }
        self.processes
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .insert(pid, session.clone());
    }

    /// The conversation the Claude Code process `pid` is in now, if a hook has said.
    pub fn process_current(&self, pid: u32) -> Option<SessionId> {
        self.processes
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&pid)
            .cloned()
    }

    /// The launch a conversation is currently the subject of, so a client that started
    /// that launch can follow it to its new conversation.
    ///
    /// Several launches can sit in one conversation (two terminals resuming the same
    /// one); the lowest launch id is returned so the answer is stable between calls.
    pub fn launch_of(&self, session: &SessionId) -> Option<String> {
        self.current
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|(_, s)| *s == session)
            .map(|(launch, _)| launch.clone())
            .min()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(s: &str) -> SessionId {
        SessionId::new(s.to_string())
    }

    #[test]
    fn a_launch_follows_the_conversation_its_hooks_report() {
        let launches = LaunchRegistry::new();
        assert_eq!(
            launches.observe("a05a347e", &sid("a05a347e")),
            LaunchObservation::New
        );
        assert_eq!(
            launches.observe("a05a347e", &sid("a05a347e")),
            LaunchObservation::Unchanged
        );
        // `/resume` into an existing conversation.
        assert_eq!(
            launches.observe("a05a347e", &sid("213d1944")),
            LaunchObservation::Moved {
                from: sid("a05a347e")
            }
        );
        assert_eq!(launches.current("a05a347e"), Some(sid("213d1944")));
    }

    /// The failure this exists for: a verb bound to the launch id found no such session.
    #[test]
    fn a_verb_resolves_to_the_current_conversation_not_the_launch_id() {
        let launches = LaunchRegistry::new();
        launches.observe("a05a347e", &sid("213d1944"));
        assert_eq!(launches.resolve("a05a347e"), sid("213d1944"));
    }

    #[test]
    fn before_any_hook_a_launch_resolves_to_itself() {
        assert_eq!(LaunchRegistry::new().resolve("a05a347e"), sid("a05a347e"));
    }

    #[test]
    fn a_conversation_names_its_launch_stably() {
        let launches = LaunchRegistry::new();
        launches.observe("bbbbbbbb", &sid("213d1944"));
        launches.observe("aaaaaaaa", &sid("213d1944"));
        assert_eq!(
            launches.launch_of(&sid("213d1944")).as_deref(),
            Some("aaaaaaaa")
        );
        assert_eq!(launches.launch_of(&sid("nobody")), None);
    }

    /// A process no IDE launched: its hooks name its pid, and a `/resume` moves it.
    #[test]
    fn a_process_follows_the_conversation_its_hooks_report() {
        let launches = LaunchRegistry::new();
        assert_eq!(launches.process_current(4242), None);
        launches.observe_process(4242, &sid("ad055831"));
        launches.observe_process(4242, &sid("efdf1598"));
        assert_eq!(launches.process_current(4242), Some(sid("efdf1598")));
    }

    #[test]
    fn a_ps_line_reads_as_parent_and_command() {
        assert_eq!(parse_ps_line("  123 /bin/zsh\n"), Some((123, "/bin/zsh".into())));
        assert_eq!(parse_ps_line("1 launchd"), Some((1, "launchd".into())));
        assert_eq!(parse_ps_line(""), None);
        assert_eq!(parse_ps_line("abc sh"), None);
    }

    #[test]
    fn only_shells_count_as_the_hook_wrapper() {
        assert!(is_shell("/bin/sh"));
        assert!(is_shell("-zsh"));
        assert!(is_shell("bash"));
        assert!(!is_shell("claude"));
        assert!(!is_shell("/usr/local/bin/node"));
    }

    #[cfg(unix)]
    #[test]
    fn this_process_names_its_parent_first() {
        assert_eq!(
            claude_process_ids().first().copied(),
            Some(std::os::unix::process::parent_id())
        );
    }

    #[test]
    fn pids_that_name_no_claude_process_are_ignored() {
        let launches = LaunchRegistry::new();
        launches.observe_process(0, &sid("s"));
        launches.observe_process(1, &sid("s"));
        assert_eq!(launches.process_current(0), None);
        assert_eq!(launches.process_current(1), None);
    }

    #[test]
    fn only_the_minted_shape_is_a_launch_id() {
        assert!(is_launch_id("c391cd75-fef3-47a8-9ff9-2544aff34d09"));
        assert!(!is_launch_id("abc'; id; echo '"));
        assert!(!is_launch_id("../../etc/passwd"));
        assert!(!is_launch_id(""));
    }
}
