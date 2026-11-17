/**
 * Start a Claude Code session MoonlightCode owns from its first line: in an editor
 * terminal, or in a herdr pane that outlives the editor.
 *
 * The id is minted here and pinned with `--session-id`, so the session we start is the
 * one we govern and deliver reviews to. What follows the launch depends on who governs:
 * the daemon adopts it once detection sees it; the Claude Code plugin governs every
 * session it runs in, so there is nothing to adopt.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import * as controlApi from 'moonlight-control-client';
import type { MoonlightApi, Placement } from 'moonlight-core';

import { governorFor, hostFor, type Governor, type Host } from './start-plan';

/**
 * How long to wait for a session we just launched to appear, before telling the operator
 * it is not governed yet. Detection polls the transcript every 750ms, but a fresh
 * session writes nothing until it is prompted.
 */
const POLL_MS = 750;
const ATTEMPTS = 20;
const LAST_WORKSPACE = 'moonlight.herdr.lastWorkspace';

export async function startSession(context: vscode.ExtensionContext, core: MoonlightApi, asked?: Host): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const sessionId = globalThis.crypto?.randomUUID?.();
  if (!sessionId) {
    void vscode.window.showErrorMessage('Could not generate a session id.');
    return;
  }
  const governor = governorFor(core.backendError(), core.claudeMod?.() ?? 'unknown');
  if (governor === 'none') {
    const go = await vscode.window.showWarningMessage(
      'No MoonlightCode daemon is answering and the Claude Code plugin is not enabled, so nothing would govern this session.',
      'Start it ungoverned',
      'Install the Claude Code plugin'
    );
    if (go === 'Install the Claude Code plugin') {
      await vscode.commands.executeCommand('moonlight.core.installClaudeMod');
      return;
    }
    if (go !== 'Start it ungoverned') {
      return;
    }
  }
  const host = asked ?? (await chooseHost(core));
  if (!host) {
    return;
  }
  const daemon = governor === 'daemon';
  let where: string;
  if (host === 'herdr') {
    const started = await startInHerdr(context, core, sessionId, folder, daemon);
    if (!started) {
      return;
    }
    where = `in herdr (${started})`;
  } else {
    core.terminals.start(sessionId, folder?.uri.fsPath, { daemon });
    where = 'in a terminal';
  }
  await settle(core, sessionId, governor, host, where);
}

async function chooseHost(core: MoonlightApi): Promise<Host | undefined> {
  const setting = vscode.workspace.getConfiguration('moonlight.sessions').get<string>('startIn', 'ask');
  const running = core.herdr ? await core.herdr.available() : false;
  const plan = hostFor(setting, running);
  if (plan === 'herdr-down') {
    const go = await vscode.window.showWarningMessage(
      'No herdr server is running, so the session cannot start in herdr. Start herdr, or start it in a terminal.',
      'Start in a terminal'
    );
    return go ? 'terminal' : undefined;
  }
  if (plan !== 'ask') {
    return plan;
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(server-process) In herdr', description: 'outlives the editor; reattach from any terminal', host: 'herdr' as Host },
      { label: '$(terminal) In an editor terminal', description: 'ends with the editor', host: 'terminal' as Host },
    ],
    { placeHolder: 'Where should the session run?' }
  );
  return picked?.host;
}

/** The roots herdr panes are matched against: every folder open here. */
function roots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/** Start in herdr; returns where it went, for the message, or `undefined` when cancelled or failed. */
async function startInHerdr(
  context: vscode.ExtensionContext,
  core: MoonlightApi,
  sessionId: string,
  folder: vscode.WorkspaceFolder | undefined,
  daemon: boolean
): Promise<string | undefined> {
  const herdr = core.herdr;
  if (!herdr || !folder) {
    void vscode.window.showErrorMessage(
      herdr ? 'Open a folder first: a herdr session starts in it.' : 'This MoonlightCode Core has no herdr support. Update it.'
    );
    return undefined;
  }
  const cwd = folder.uri.fsPath;
  const lastUsed = context.workspaceState.get<string>(LAST_WORKSPACE);
  let placement: Placement | undefined;
  try {
    const choices = await herdr.placements(roots(), lastUsed, path.basename(cwd));
    placement = await pickPlacement(choices, lastUsed);
  } catch (err) {
    void vscode.window.showErrorMessage(`MoonlightCode: could not read herdr's workspaces. ${message(err)}`);
    return undefined;
  }
  if (!placement) {
    return undefined;
  }
  const chosen = placement;
  try {
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Starting Claude Code in herdr (${describe(chosen)})…` },
      () => herdr.start(sessionId, chosen, cwd, { daemon })
    );
    if (started.workspaceId) {
      await context.workspaceState.update(LAST_WORKSPACE, started.workspaceId);
    }
    return describe(chosen);
  } catch (err) {
    void vscode.window.showErrorMessage(`MoonlightCode: the session did not start in herdr. ${message(err)}`);
    return undefined;
  }
}

async function pickPlacement(choices: Placement[], lastUsed: string | undefined): Promise<Placement | undefined> {
  // Asked not to ask: the last workspace used here, when it is still there.
  const reuse = vscode.workspace.getConfiguration('moonlight.herdr').get<boolean>('reuseLastPlace', false);
  const remembered = choices.find((c) => c.kind === 'tab' && c.workspace.id === lastUsed);
  if (reuse && remembered) {
    return remembered;
  }
  type Item = vscode.QuickPickItem & { placement?: Placement };
  const items: Item[] = [];
  let section: string | undefined;
  for (const c of choices) {
    const group = c.kind === 'workspace' ? 'New' : c.inRepo ? 'This repository' : 'Other workspaces';
    if (group !== section) {
      items.push({ label: group, kind: vscode.QuickPickItemKind.Separator });
      section = group;
    }
    items.push({
      label: c.kind === 'workspace' ? `$(add) New workspace "${c.label}"` : `${c.kind === 'tab' ? '$(window)' : '$(split-horizontal)'} ${c.workspace.label}`,
      description:
        c.kind === 'tab' ? `new tab${c.workspace.id === lastUsed ? ' · last used here' : ''}` : c.kind === 'split' ? `split beside ${c.pane}` : 'at the repository root',
      placement: c,
    });
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Where in herdr?' });
  return picked?.placement;
}

function describe(p: Placement): string {
  return p.kind === 'workspace' ? `new workspace "${p.label}"` : `${p.workspace.label}, ${p.kind === 'tab' ? 'new tab' : 'split'}`;
}

/**
 * After the launch: the daemon adopts the session once detection has seen it (the
 * engine drops an adoption for a session not yet in the fleet). Under the Claude Code
 * plugin there is nothing to adopt: wait for the plugin to report it, and say so.
 */
async function settle(core: MoonlightApi, sessionId: string, governor: Governor, host: Host, where: string): Promise<void> {
  const short = sessionId.slice(0, 8);
  const show = host === 'herdr' ? ['Show in herdr'] : [];
  const offerShow = async (pick: string | undefined): Promise<void> => {
    if (pick === 'Show in herdr') {
      await core.herdr?.focus(sessionId);
    }
  };
  if (governor === 'none') {
    void vscode.window.showInformationMessage(`Session ${short} started ${where}, ungoverned.`, ...show).then(offerShow);
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Starting session ${short} ${where} — waiting for it to appear…` },
    async () => {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        await core.refresh();
        const session = core.sessions().find((s) => s.session_id === sessionId);
        if (!session) {
          continue;
        }
        if (governor === 'mod') {
          void vscode.window
            .showInformationMessage(`Session ${short} started ${where}. The Claude Code plugin governs it, in ${session.phase}.`, ...show)
            .then(offerShow);
          return;
        }
        try {
          if (!session.adopted) {
            await controlApi.adopt(sessionId);
            await core.refresh();
          }
          void vscode.window
            .showInformationMessage(
              `Session ${short} started ${where} and adopted — governed from its next tool call, and reviews can be delivered to it.`,
              ...show
            )
            .then(offerShow);
        } catch (err) {
          void vscode.window.showWarningMessage(
            `Session started, but adopting it failed: ${message(err)} Use "Adopt a Claude Code Session" to retry.`
          );
        }
        return;
      }
      // Detection works off the transcript (or the plugin's state file), which only
      // appears once the session writes something. Say so rather than imply it is governed.
      void vscode.window
        .showWarningMessage(
          governor === 'daemon'
            ? `Session ${short} started ${where}, but detection has not seen it yet, so it is NOT governed. It is detected once it writes its first transcript line — send it a prompt, then run "Adopt a Claude Code Session".`
            : `Session ${short} started ${where}, but the Claude Code plugin has not reported it yet. Check that the plugin is enabled in that session.`,
          ...show
        )
        .then(offerShow);
    }
  );
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
