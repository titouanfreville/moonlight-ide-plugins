/**
 * The MoonlightCode sidebar: one webview with three tabs — Sessions, Review, AI review —
 * the same features as the JetBrains tool window, in one place.
 *
 * It replaces the two tree views ("Governed", "Not adopted") and the AI review editor
 * panel. A tree row is one line with four slots; the phase cycle, a held plan and a
 * session's review did not fit in it, and spreading them over three surfaces made the
 * operator hunt for the session they were already looking at.
 *
 * The extension computes everything (`panel-model.ts`); the webview only draws it and
 * posts back what was clicked. Each click lands on an existing command, so the palette,
 * the status bar and this view keep doing the same thing.
 *
 * The review belongs to moonlight-ai-review: its tabs ask that extension through
 * commands (`moonlight.review.panelData` and friends), the way this extension already
 * reaches agentic-support for held plans.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { DiscoverableSession } from 'moonlight-control-client';
import type { MoonlightApi, ReviewPanelData } from 'moonlight-core';

import type { GroupStore } from './groups-store';
import { panelModel, reviewFailure, reviewTarget, type Tab } from './panel-model';
import { isTab, phaseMove, routeOf, type Inbound } from './panel-route';
import { advanceSessionPhase, setSessionPhase } from './phase-route';

export const PANEL_VIEW_ID = 'moonlight.panel';

const STATE_KEY = 'moonlight.panel.state';
const AI_REVIEW_ID = 'titouanfreville.moonlight-ai-review';

export class MoonlightPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private tab: Tab;
  private selected: string | undefined;
  private reviewInstalled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped per render, so a slow review answer never overwrites a newer one. */
  private generation = 0;
  /**
   * Holds, while the sidebar is not on screen. The activity-bar badge needs a resolved
   * view, which exists only once the sidebar has been shown in this window: until then
   * (and whenever it is hidden) this item carries the one alert worth interrupting for.
   */
  private readonly holdsItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly core: MoonlightApi,
    private readonly groups: GroupStore
  ) {
    const saved = context.workspaceState.get<{ tab?: Tab; selected?: string }>(STATE_KEY) ?? {};
    this.tab = isTab(saved.tab) ? saved.tab : 'sessions';
    this.selected = saved.selected;
    void this.detectReview();
    context.subscriptions.push(vscode.extensions.onDidChange(() => void this.detectReview()));
    this.holdsItem.command = { title: 'Show MoonlightCode', command: 'moonlight.panel.show', arguments: [{ tab: 'sessions' }] };
    context.subscriptions.push(this.holdsItem);
  }

  /** Show a tab, on a session when one is named. Behind `moonlight.panel.show`. */
  async show(tab: Tab | undefined, sessionId: string | undefined): Promise<void> {
    if (tab) {
      this.tab = tab;
    }
    if (sessionId) {
      this.selected = sessionId;
    }
    this.save();
    await vscode.commands.executeCommand(`${PANEL_VIEW_ID}.focus`);
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: Inbound) => void this.onMessage(m));
    view.onDidChangeVisibility(() => this.refresh());
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Redraw soon. Coalesced: a poll tick, a hold and a review change often land together. */
  refresh(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.render();
    }, 100);
  }

  /**
   * Whether moonlight-ai-review is installed, from the extension list — not from its
   * commands: those exist only once it has activated, and both extensions start at
   * startup, so asking for them first said "not installed" for an installed extension.
   */
  private async detectReview(): Promise<void> {
    const installed = vscode.extensions.getExtension(AI_REVIEW_ID) !== undefined;
    if (installed !== this.reviewInstalled) {
      this.reviewInstalled = installed;
      this.refresh();
    }
  }

  /** The review of one session, activating moonlight-ai-review first when it has not started yet. */
  private async reviewOf(sessionId: string): Promise<ReviewPanelData | undefined> {
    const extension = vscode.extensions.getExtension(AI_REVIEW_ID);
    if (!extension) {
      return undefined;
    }
    if (!extension.isActive) {
      await extension.activate();
    }
    return vscode.commands.executeCommand<ReviewPanelData | undefined>('moonlight.review.panelData', sessionId);
  }

  private save(): void {
    void this.context.workspaceState.update(STATE_KEY, { tab: this.tab, selected: this.selected });
  }

  private async render(): Promise<void> {
    const generation = ++this.generation;
    const sessions = this.core.sessions();
    const holds = this.core.heldApprovals?.() ?? [];
    // Holds are the one number worth interrupting for: on the activity bar once the view
    // exists, and in the status bar while the sidebar is not on screen.
    const tooltip = `${holds.length} session(s) waiting on you`;
    if (this.view) {
      this.view.badge = holds.length > 0 ? { value: holds.length, tooltip } : undefined;
    }
    if (holds.length > 0 && !this.view?.visible) {
      this.holdsItem.text = `$(bell-dot) ${holds.length} waiting`;
      this.holdsItem.tooltip = `${tooltip}. Click to answer.`;
      this.holdsItem.show();
    } else {
      this.holdsItem.hide();
    }
    if (!this.view?.visible) {
      return;
    }
    const target = reviewTarget(sessions, this.selected);
    let review: ReviewPanelData | undefined;
    if (target && this.reviewInstalled) {
      // A failure is said, not shown as "Reading the review…" forever.
      try {
        review = (await this.reviewOf(target.session_id)) ?? reviewFailure('MoonlightCode AI Review did not answer for this session.');
      } catch (err) {
        review = reviewFailure(err instanceof Error ? err.message : String(err));
      }
    }
    if (generation !== this.generation || !this.view) {
      return;
    }
    const model = panelModel({
      sessions,
      holds,
      backendError: this.core.backendError(),
      claudeMod: this.core.claudeMod?.() ?? 'unknown',
      following: this.core.activeSession()?.sessionId,
      groupBy: this.groups.mode(),
      groups: this.groups.custom(),
      tab: this.tab,
      selected: this.selected,
      review,
      reviewInstalled: this.reviewInstalled,
      colorBlind: vscode.workspace.getConfiguration('moonlight.accessibility').get<boolean>('colorBlind', false),
    });
    void this.view.webview.postMessage({ type: 'model', model });
  }

  private session(id: string | undefined): DiscoverableSession | undefined {
    return this.core.sessions().find((s) => s.session_id === id);
  }

  private async onMessage(m: Inbound): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          break;
        case 'tab':
          if (isTab(m.tab)) {
            this.tab = m.tab;
            this.save();
          }
          break;
        case 'select':
          this.selected = m.id;
          this.save();
          break;
        case 'phase': {
          const phase = phaseMove(m.phase, this.session(m.id));
          if (phase) {
            await setSessionPhase(this.core, m.id, phase);
            await this.core.refresh();
          }
          break;
        }
        case 'next': {
          const session = this.session(m.id);
          if (session) {
            await advanceSessionPhase(this.core, session);
            await this.core.refresh();
          }
          break;
        }
        default: {
          const route = routeOf(m, 'id' in m ? this.session(m.id) : undefined);
          if (route) {
            await vscode.commands.executeCommand(route.command, ...route.args);
          }
          // Opening a finding moves to an editor: nothing here changed.
          if (m.type === 'openFinding') {
            return;
          }
        }
      }
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    }
    this.refresh();
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}';" />
<link rel="stylesheet" href="${css}" />
<title>MoonlightCode</title>
</head>
<body>
<div class="vtabs" role="tablist" aria-label="MoonlightCode views" id="vtabs"></div>
<div id="holds" aria-live="polite"></div>
<main class="view" id="view" role="tabpanel"><p class="empty">Loading sessions…</p></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
