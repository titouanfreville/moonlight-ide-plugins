/**
 * MoonlightCode Core — the one backend connection the other extensions share.
 *
 * It contributes no UI. It exists so that the feature extensions can ship and be
 * installed separately without each one opening its own connection, running its own
 * poll loop, and forming its own opinion about what the fleet is doing.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as controlApi from 'moonlight-control-client';

import {
  type ClaudeModState,
  type CliResult,
  claudeSettingsPath,
  installMod,
  readModState,
  settingsFileAt,
} from './claude-mod';

import { windowOwnsSession } from './ownership';
import { isClaudePanel, matchPanelSession } from './panel-match';

import { ensureDownloadedDaemon } from './daemon-install';
import { modHold, modSession, readModStates, sendToMod, type ModState } from './mod-bridge';
import type {
  DiscoverableSession,
  HookStatusEntry,
  UsageResponse,
} from 'moonlight-control-client';
import type { ActiveSession, MoonlightApi } from './api';
import { GateState } from './gate-state';
import { SessionTerminals } from './terminals';

/**
 * How often the backend is polled. One loop for every extension — the point of
 * putting this in core rather than in each feature.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * What the operator has configured about starting the daemon.
 *
 * Read per call rather than captured at activation, so changing the setting takes
 * effect on the next poll instead of requiring a window reload — the point of a
 * setting over an environment variable is that you can change your mind without
 * restarting the editor.
 */
function daemonOptions(): controlApi.DaemonOptions {
  const config = vscode.workspace.getConfiguration('moonlight');
  const path = config.get<string | null>('daemon.path') ?? undefined;
  return {
    // An empty string in settings.json reads as "unset", not as a path to nothing.
    path: path?.trim() ? path.trim() : undefined,
    autostart: config.get<boolean>('daemon.autostart') ?? true,
  };
}

/**
 * Runs the `claude` CLI. Through a login shell on macOS and Linux, because an
 * editor started from the dock does not get the PATH a terminal has, and
 * `claude` is usually installed somewhere only that PATH names. The arguments
 * travel as the shell's positional parameters, never inside the script.
 */
function runClaude(args: readonly string[]): Promise<CliResult> {
  const quoted = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  const [file, argv, shell] =
    process.platform === 'win32'
      ? ['claude', args.map(quoted), true]
      : [process.env.SHELL || '/bin/sh', ['-lc', 'exec claude "$@"', 'claude', ...args], false];
  return new Promise((resolve, reject) => {
    execFile(file, argv, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, shell }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && typeof code !== 'number') {
        reject(err);
        return;
      }
      resolve({ code: err ? (code as number) : 0, stdout, stderr });
    });
  });
}

/** How many failed polls in a row (five seconds apart) before the mod is offered. */
const OFFER_MOD_AFTER_FAILURES = 3;
const MOD_DONT_ASK_KEY = 'moonlight.claudeMod.dontAsk';

export function activate(context: vscode.ExtensionContext): MoonlightApi {
  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);

  // The daemon's sessions, and the Claude Code mod's (see mod-bridge.ts); `sessions`
  // is both, which is all a panel needs to know.
  let daemonSessions: readonly DiscoverableSession[] = [];
  let modStates: readonly ModState[] = [];
  let sessions: readonly DiscoverableSession[] = [];
  let gating: readonly HookStatusEntry[] = [];
  let usage: UsageResponse | undefined;
  let backendError: string | undefined;

  // ---------------------------------------------------------------------------
  // The fallback: the MoonlightCode mod for Claude Code (see claude-mod.ts). It
  // is asked about only while the daemon is down: spawning the CLI on every
  // window open, for a state that matters only then, would be paid for nothing.
  // ---------------------------------------------------------------------------
  let claudeMod: ClaudeModState = 'unknown';
  let failedPolls = 0;
  let modOffered = false;
  let installingMod: Promise<void> | undefined;
  const claudeSettings = settingsFileAt(claudeSettingsPath());

  const checkMod = async (): Promise<void> => {
    const next = await readModState(runClaude, claudeSettings).catch((): ClaudeModState => 'unknown');
    if (next !== claudeMod) {
      claudeMod = next;
      changed.fire();
    }
  };

  /**
   * The bundled marketplace, copied out of the extension to global storage: the
   * extension's own folder changes path with every update, and Claude Code keeps
   * the path a local marketplace was added from.
   */
  const bundledMarketplace = (): string | undefined => {
    const from = path.join(context.extensionPath, 'claude-mod');
    if (!fs.existsSync(path.join(from, '.claude-plugin', 'marketplace.json'))) {
      return undefined;
    }
    const to = path.join(context.globalStorageUri.fsPath, 'claude-mod');
    try {
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
      return to;
    } catch {
      return undefined;
    }
  };

  const installClaudeMod = (): Promise<void> => {
    installingMod ??= (async () => {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing the MoonlightCode plugin for Claude Code…' },
        () => installMod(runClaude, claudeSettings, bundledMarketplace())
      );
      await checkMod();
      if (result.ok) {
        void vscode.window.showInformationMessage(
          'MoonlightCode plugin installed for Claude Code. New Claude Code sessions are gated by it while no ' +
            'daemon runs; restart the sessions already open to gate them too.'
        );
      } else {
        void vscode.window.showErrorMessage(`MoonlightCode plugin not installed: ${result.error}`);
      }
    })().finally(() => {
      installingMod = undefined;
    });
    return installingMod;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('moonlight.core.installClaudeMod', () => installClaudeMod())
  );

  /** Offered once per window, after the daemon stayed down long enough for autostart to have had its go. */
  const offerMod = async (): Promise<void> => {
    if (modOffered || context.globalState.get<boolean>(MOD_DONT_ASK_KEY)) {
      return;
    }
    await checkMod();
    if (claudeMod !== 'missing' && claudeMod !== 'off') {
      return;
    }
    modOffered = true;
    const choice = await vscode.window.showWarningMessage(
      'No MoonlightCode daemon is running, so Claude Code sessions are not gated. Install the MoonlightCode ' +
        'plugin for Claude Code? It gates each session itself until a daemon runs. This installs ' +
        '"moonlightcode" from the moonlight marketplace and turns on function hooks in ~/.claude/settings.json.',
      'Install',
      'Not now',
      "Don't ask again"
    );
    if (choice === 'Install') {
      await installClaudeMod();
    } else if (choice === "Don't ask again") {
      await context.globalState.update(MOD_DONT_ASK_KEY, true);
    }
  };

  const terminals = new SessionTerminals(context);

  // A daemon downloaded on demand, once it has been verified. Held here rather than
  // re-derived per tick so the five-second poll does not stat the cache forever, and
  // so a single in-flight download is shared by every tick that arrives during it.
  let downloadedDaemon: string | undefined;
  let installing: Promise<void> | undefined;
  /**
   * Earliest time a failed install may be tried again.
   *
   * The guard used to read only `downloadedDaemon || installing`, neither of which a
   * failure sets — so a 404 or a checksum mismatch re-fetched the whole asset on every
   * five-second tick, forever. `nightly.yml` deletes and recreates its release on each
   * push, which makes that 404 permanent for a nightly-pinned build: a request storm
   * against GitHub with no end and no way for the operator to see why.
   *
   * Ten minutes, and the state is per window, so quitting and reopening retries at
   * once — the two moments when a retry is actually worth something.
   */
  let retryInstallAfter = 0;
  const INSTALL_RETRY_MS = 10 * 60_000;

  /**
   * Fetch the daemon the first time `PATH` turns up empty.
   *
   * Only on `no-binary`: an operator who pointed at their own build, or turned
   * autostart off, has already answered the question this would be asking.
   */
  const installDaemon = (): void => {
    if (downloadedDaemon || installing || Date.now() < retryInstallAfter) {
      return;
    }
    installing = (async () => {
      const result = await ensureDownloadedDaemon(
        context.globalStorageUri.fsPath,
        controlApi.daemonBinaryName()
      );
      if (result.kind === 'installed' || result.kind === 'cached') {
        downloadedDaemon = result.binary;
      } else if (result.kind === 'failed') {
        retryInstallAfter = Date.now() + INSTALL_RETRY_MS;
        // Surfaced, not just logged. This path exists for people who have nothing but
        // the extension, so "no backend" with the reason buried in a console they
        // never open is the one audience it cannot afford to fail silently for.
        void vscode.window.showWarningMessage(
          `MoonlightCode could not download moonlightd: ${result.error}`
        );
      }
    })().finally(() => {
      installing = undefined;
    });
  };

  const refresh = async (): Promise<void> => {
    try {
      // Usage rides the same tick: the server caches the account quota, so the
      // extra call costs a directory read rather than a round-trip to Anthropic.
      //
      // It is fetched SEPARATELY and allowed to fail. Sessions and gating are the
      // load-bearing pair — if either is unreachable the backend genuinely is, and
      // the status bar must say so. Usage is decoration. Putting all three in one
      // `Promise.all` made a backend that simply predates `/control/usage` report
      // as entirely down: one 404 rejected the whole tick, so no session list, no
      // gating status, and every dependent extension concluded it had no backend —
      // a total blackout caused by a missing quota reading.
      const [nextSessions, nextGating] = await Promise.all([
        controlApi.discoverableSessions(),
        controlApi.gatingStatus(),
      ]);
      // Keeps the previous reading rather than blanking it, so an endpoint that
      // blips does not make the figures flicker.
      const nextUsage = await controlApi.usage().catch(() => usage);
      // Only fire when something actually moved: this ticks every five seconds, and
      // waking every dependent each time would make them redraw for nothing.
      const same =
        backendError === undefined &&
        JSON.stringify(nextSessions) === JSON.stringify(daemonSessions) &&
        JSON.stringify(nextGating) === JSON.stringify(gating) &&
        JSON.stringify(nextUsage) === JSON.stringify(usage);
      daemonSessions = nextSessions;
      sessions = mergedSessions();
      gating = nextGating;
      usage = nextUsage;
      backendError = undefined;
      failedPolls = 0;
      controlApi.daemonReachable();
      if (!same) {
        changed.fire();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A window that opens is expected to make sure the daemon is running: it is
      // what governs sessions, so reporting "no backend" and leaving it at that means
      // the fleet runs ungoverned while this extension looks like it is working.
      // Racing another window is safe — the loser exits (see apps/daemon).
      const options = daemonOptions();
      const started = controlApi.ensureDaemon({
        ...options,
        // An explicit setting always wins: a download must never quietly replace the
        // build an operator named.
        path: options.path ?? downloadedDaemon,
      });
      if (started.kind === 'no-binary' && options.autostart !== false && !options.path) {
        installDaemon();
      }
      // Say *why* there is no backend when the reason is a choice or a missing
      // binary. "Connection refused" alone sends an operator looking for a crash when
      // the answer is that this window was told not to start one.
      const reported =
        started.kind === 'no-binary'
          ? `${message} (moonlightd not found)`
          : started.kind === 'disabled'
            ? `${message} (autostart is off — start moonlightd yourself, or enable moonlight.daemon.autostart)`
            : message;
      // A backend that isn't running is an ordinary state, not a failure to report
      // loudly — the status extension renders it. Keep the last known lists so a
      // brief blip doesn't blank every view.
      if (backendError !== reported) {
        backendError = reported;
        changed.fire();
      }
      // The first failure of a streak learns whether the mod covers for the
      // daemon; a streak long enough that autostart could not fix it offers it.
      failedPolls += 1;
      if (failedPolls === 1) {
        void checkMod();
      } else if (failedPolls === OFFER_MOD_AFTER_FAILURES) {
        void offerMod();
      }
    }
  };

  void refresh();
  const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // ---------------------------------------------------------------------------
  // The Claude Code mod's sessions. Read on a timer of their own, every two seconds
  // (the mod's own tick), whether or not a daemon answers: the mod governs exactly
  // when the daemon does not.
  // ---------------------------------------------------------------------------
  const modDir = () => path.join(controlApi.stateAnchor(), '.moonlight', 'mod', 'sessions');
  /** When each mod hold was first seen, so "waiting 40s" means what it says. */
  const modHoldSince = new Map<string, { key: string; since: number }>();

  function mergedSessions(): readonly DiscoverableSession[] {
    const mine = new Set(modStates.map((s) => s.sessionId));
    return [...daemonSessions.filter((s) => !mine.has(s.session_id)), ...modStates.map(modSession)];
  }

  const modHoldOf = (sessionId: string) => {
    const state = modStates.find((s) => s.sessionId === sessionId);
    return state ? modHold(state, modHoldSince.get(sessionId)?.since ?? Date.now()) : undefined;
  };

  const refreshMod = (): void => {
    const next = readModStates(modDir(), Date.now());
    if (JSON.stringify(next.map(({ updatedMs: _u, ...rest }) => rest)) ===
        JSON.stringify(modStates.map(({ updatedMs: _u, ...rest }) => rest))) {
      return;
    }
    modStates = next;
    for (const state of next) {
      const hold = modHold(state, Date.now());
      const key = hold ? `${hold.what}#${hold.planVersion ?? ''}` : '';
      if (!hold) {
        modHoldSince.delete(state.sessionId);
      } else if (modHoldSince.get(state.sessionId)?.key !== key) {
        modHoldSince.set(state.sessionId, { key, since: Date.now() });
      }
    }
    sessions = mergedSessions();
    changed.fire();
    heldChanged.fire();
  };
  const modTimer = setInterval(refreshMod, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(modTimer) });

  // ---------------------------------------------------------------------------
  // The gate: holds, and the plans behind them.
  //
  // This rides the event stream rather than the poll, because a hold is not a fact
  // that can wait five seconds for its turn — the session is stopped until someone
  // answers it. The poll stays the authority for everything else.
  // ---------------------------------------------------------------------------
  const heldChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(heldChanged);

  const gate = new GateState();

  /** Re-read the outstanding holds from the server, after a desync or at activation. */
  const resyncHolds = async (): Promise<void> => {
    try {
      gate.resync(await controlApi.pendingApprovals());
      heldChanged.fire();
    } catch {
      // An unreachable backend is already reported by the poll loop; a second,
      // louder complaint from here would only duplicate it.
    }
  };

  const stream = controlApi.subscribeEvents({
    onEvent: (event) => {
      if (gate.apply(event)) {
        heldChanged.fire();
      }
    },
    onDesync: () => void resyncHolds(),
  });
  context.subscriptions.push(stream);
  void resyncHolds();

  // Survives a window reload: the operator should not have to re-pin every time.
  const PIN_KEY = 'moonlight.pinnedSession';
  const PANEL_PINS_KEY = 'moonlight.panelSessions';
  let pinned = context.workspaceState.get<string>(PIN_KEY);
  let panelPins = context.workspaceState.get<Record<string, string>>(PANEL_PINS_KEY) ?? {};

  /**
   * A handle for the focused agent panel. `TabInputWebview` exposes only a view
   * type, so the tab's label is what separates two panels of the same kind.
   */
  const activePanelKey = (): string | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!tab || !(tab.input instanceof vscode.TabInputWebview)) {
      return undefined;
    }
    return `${tab.input.viewType}::${tab.label}`;
  };

  // Switching tabs switches which session the UI is about, so redraw on tab change.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabGroups(() => changed.fire()),
    vscode.window.tabGroups.onDidChangeTabs(() => changed.fire())
  );

  // The session of the agent panel last in front of you, so moving into an editor
  // to read what the agent wrote keeps the UI on that agent instead of snapping back
  // to an older workspace pin. In memory only: after a reload, focus re-derives it.
  let lastPanelSession: string | undefined;

  const activeSession = (): ActiveSession | undefined => {
    const known = sessions;
    const exists = (id: string | undefined): id is string =>
      !!id && known.some((s) => s.session_id === id);
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const claudePanel =
      tab?.input instanceof vscode.TabInputWebview && isClaudePanel(tab.input.viewType);

    // 1. The session the operator linked to the panel in front of you. Explicit, so it
    //    outranks anything read off the tab.
    const key = activePanelKey();
    const forPanel = key ? panelPins[key] : undefined;
    if (exists(forPanel)) {
      lastPanelSession = forPanel;
      return { sessionId: forPanel, how: 'panel' };
    }
    // 2. The session a focused Claude Code panel names in its tab label. This is what
    //    makes several agent panels each follow their own session with no pinning.
    if (claudePanel && tab) {
      const matched = matchPanelSession(tab.label, known, folders);
      if (matched) {
        lastPanelSession = matched;
        return { sessionId: matched, how: 'panel' };
      }
    }
    // 3. A session we launched — the id is certain, not inferred. Only when there is
    //    exactly one, since several owned terminals are as ambiguous as none.
    const owned = known.filter((s) => terminals.has(s.session_id));
    if (owned.length === 1) {
      return { sessionId: owned[0].session_id, how: 'owned' };
    }
    // A Claude panel is in front of you but its tab names no session we can resolve
    // (a brand-new, untitled one, or an ambiguous title). Every remembered answer
    // below is about some *other* panel, so only the labelled guess is left.
    if (!claudePanel) {
      // 4. The agent panel you were last in — you are in an editor, not a new agent.
      if (exists(lastPanelSession)) {
        return { sessionId: lastPanelSession, how: 'recent' };
      }
      // 5. The operator's workspace-wide pin, while it still exists.
      if (exists(pinned)) {
        return { sessionId: pinned, how: 'pinned' };
      }
    }
    // 6. Exactly one session running in this workspace. A guess, labelled as one —
    //    and only when there is no competition, because naming the wrong session as
    //    governed is worse than admitting we don't know.
    const here = known.filter(
      (s) => s.root && folders.some((f) => s.root === f || s.root!.startsWith(`${f}/`))
    );
    const running = here.filter((s) => s.status === 'Running');
    const candidates = running.length > 0 ? running : here;
    return candidates.length === 1
      ? { sessionId: candidates[0].session_id, how: 'sole' }
      : undefined;
  };

  return {
    version: 2,
    activeSession,
    ownsSession: (sessionId) =>
      windowOwnsSession(
        sessionId,
        activeSession()?.sessionId,
        sessions.find((s) => s.session_id === sessionId)?.root ?? undefined,
        (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
      ),
    setPinnedSession: (sessionId) => {
      pinned = sessionId;
      void context.workspaceState.update(PIN_KEY, sessionId);
      changed.fire();
    },
    activePanelKey,
    pinToActivePanel: (sessionId) => {
      const key = activePanelKey();
      if (!key) {
        return false;
      }
      panelPins = { ...panelPins };
      if (sessionId) {
        panelPins[key] = sessionId;
      } else {
        delete panelPins[key];
      }
      void context.workspaceState.update(PANEL_PINS_KEY, panelPins);
      changed.fire();
      return true;
    },
    sessions: () => sessions,
    gating: () => gating,
    usage: () => usage,
    sessionUsage: (sessionId) => usage?.sessions.find((s) => s.session_id === sessionId),
    backendError: () => backendError,
    claudeMod: () => claudeMod,
    installClaudeMod,
    refresh,
    onDidChange: changed.event,
    heldApproval: (sessionId) => modHoldOf(sessionId) ?? gate.approval(sessionId),
    heldApprovals: () =>
      [
        ...gate.approvals().filter((h) => !modStates.some((s) => s.sessionId === h.sessionId)),
        ...modStates.flatMap((s) => modHoldOf(s.sessionId) ?? []),
      ].sort((a, b) => a.sinceMs - b.sinceMs),
    onDidChangeHeldApprovals: heldChanged.event,
    proposedPlan: (sessionId) =>
      modStates.find((s) => s.sessionId === sessionId)?.plan?.markdown ?? gate.plan(sessionId),
    governor: (sessionId) => (modStates.some((s) => s.sessionId === sessionId) ? 'mod' : 'daemon'),
    modReview: (sessionId) => modStates.find((s) => s.sessionId === sessionId)?.review,
    sendToMod: async (sessionId, entry) => {
      const answer = await sendToMod(modDir(), sessionId, entry);
      refreshMod();
      return answer;
    },
    terminals,
  };
}

export function deactivate(): void {}
