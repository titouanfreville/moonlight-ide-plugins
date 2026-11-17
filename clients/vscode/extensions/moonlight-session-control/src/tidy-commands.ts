/**
 * The commands that tidy the session lists: hide here, forget in the daemon, bring
 * hidden sessions back, drop empty custom groups. The rules are in `tidy.ts`.
 */
import * as vscode from 'vscode';
import * as controlApi from 'moonlight-control-client';
import type { DiscoverableSession } from 'moonlight-control-client';
import type { MoonlightApi } from 'moonlight-core';

import type { GroupStore } from './groups-store';
import type { HiddenStore } from './hidden-store';
import { nodeSession } from './panel-route';
import { emptyGroups, tidyBlocker } from './tidy';

/** A session id from a tree-style node or a plain id. */
const idOf = (arg: unknown): string | undefined => (typeof arg === 'string' ? arg : nodeSession(arg)?.session_id);

/** What a refused forget means, in the operator's terms. */
function forgetError(err: unknown): string {
  const status = /HTTP (\d+)/.exec(err instanceof Error ? err.message : String(err))?.[1];
  if (status === '404') {
    return 'the daemon does not know it (or predates forgetting: update moonlightd)';
  }
  if (status === '409') {
    return 'it is working or waiting on you';
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerTidyCommands(
  context: vscode.ExtensionContext,
  core: MoonlightApi,
  groups: GroupStore,
  hidden: HiddenStore
): void {
  const held = (): ReadonlySet<string> => new Set((core.heldApprovals?.() ?? []).map((h) => h.sessionId));
  const label = (id: string, sessions: readonly DiscoverableSession[]): string => {
    const s = sessions.find((x) => x.session_id === id);
    return s ? controlApi.sessionLabel(s, sessions) : controlApi.shortId(id);
  };

  /** Hide the ones that may be hidden; say which were kept and why. */
  const hideSessions = async (ids: readonly string[]): Promise<void> => {
    const sessions = core.sessions();
    const holds = held();
    const blocked = new Map<string, string>();
    for (const id of ids) {
      const s = sessions.find((x) => x.session_id === id);
      const why = s ? tidyBlocker(s, holds.has(id)) : undefined;
      if (why) {
        blocked.set(id, why);
      }
    }
    const hiding = ids.filter((id) => !blocked.has(id));
    if (hiding.length > 0) {
      await hidden.hide(hiding);
    }
    if (blocked.size > 0) {
      const why = [...blocked].map(([id, reason]) => `${label(id, sessions)}: ${reason}`).join('; ');
      void vscode.window.showInformationMessage(`Not hidden — ${why}`);
    }
  };

  /** Forget in the daemon, after asking: it deletes its records, not the transcripts. */
  const forgetSessions = async (ids: readonly string[]): Promise<void> => {
    if (ids.length === 0) {
      return;
    }
    const sessions = core.sessions();
    const what = ids.length === 1 ? `"${label(ids[0], sessions)}"` : `${ids.length} sessions`;
    const go = await vscode.window.showWarningMessage(
      `Forget ${what}?`,
      {
        modal: true,
        detail:
          'The MoonlightCode daemon deletes its record, so it leaves the list everywhere. The transcript stays, and the session comes back only if it works again.',
      },
      'Forget'
    );
    if (go !== 'Forget') {
      return;
    }
    const failed = new Map<string, string>();
    for (const id of ids) {
      try {
        await controlApi.forget(id);
      } catch (err) {
        failed.set(id, forgetError(err));
      }
    }
    // Forgotten here too: a hidden entry for a session the daemon dropped has nothing to hide.
    await hidden.unhide(ids.filter((id) => !failed.has(id)));
    await core.refresh();
    if (failed.size > 0) {
      const why = [...failed].map(([id, reason]) => `${label(id, sessions)}: ${reason}`).join('; ');
      void vscode.window.showWarningMessage(`Not forgotten — ${why}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('moonlight.sessions.hide', async (node?: unknown) => {
      const id = idOf(node);
      if (id) {
        await hideSessions([id]);
      }
    }),
    vscode.commands.registerCommand('moonlight.sessions.forget', async (node?: unknown) => {
      const id = idOf(node);
      if (id) {
        await forgetSessions([id]);
      }
    }),
    vscode.commands.registerCommand('moonlight.sessions.hideSessions', (ids: unknown) =>
      hideSessions(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [])
    ),
    vscode.commands.registerCommand('moonlight.sessions.forgetSessions', (ids: unknown) =>
      forgetSessions(Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : [])
    ),

    /** The hidden sessions, to bring back: any, or all. */
    vscode.commands.registerCommand('moonlight.sessions.showHidden', async () => {
      const sessions = core.sessions();
      const ids = Object.keys(hidden.all());
      if (ids.length === 0) {
        void vscode.window.showInformationMessage('No session is hidden in this window.');
        return;
      }
      type Item = vscode.QuickPickItem & { id: string };
      const items: Item[] = ids.map((id) => {
        const s = sessions.find((x) => x.session_id === id);
        return {
          id,
          label: label(id, sessions),
          description: s ? `${s.adopted ? 'governed' : 'not gated'} · ${s.status}` : 'no longer listed',
          detail: s?.root ?? undefined,
        };
      });
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Show which sessions again? (They also come back on their own when they work again.)',
      });
      if (picked && picked.length > 0) {
        await hidden.unhide(picked.map((p) => p.id));
      }
    }),

    /** Custom groups none of whose sessions is listed any more. */
    vscode.commands.registerCommand('moonlight.sessions.removeEmptyGroups', async () => {
      const empty = emptyGroups(groups.custom(), core.sessions());
      if (empty.length === 0) {
        void vscode.window.showInformationMessage('No custom group is empty.');
        return;
      }
      const go = await vscode.window.showWarningMessage(
        `Remove ${empty.length === 1 ? 'the empty group' : `${empty.length} empty groups`}?`,
        { modal: true, detail: empty.map((g) => g.name).join(', ') },
        'Remove'
      );
      if (go !== 'Remove') {
        return;
      }
      for (const g of empty) {
        await groups.remove(g.id);
      }
    })
  );
}
