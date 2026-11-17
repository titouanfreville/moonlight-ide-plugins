/**
 * The sessions hidden in this window — `workspaceState`, like the custom groups: hiding
 * is how you arrange the work in front of you, not something the daemon or another
 * window should follow. See `tidy.ts` for when a hidden session comes back.
 */
import * as vscode from 'vscode';

import type { HiddenMap } from './tidy';

const HIDDEN_KEY = 'moonlight.hiddenSessions';

export class HiddenStore {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when sessions are hidden or shown again, so the views can refresh. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {}

  all(): HiddenMap {
    return this.memento.get<HiddenMap>(HIDDEN_KEY) ?? {};
  }

  ids(): ReadonlySet<string> {
    return new Set(Object.keys(this.all()));
  }

  async replace(hidden: HiddenMap): Promise<void> {
    await this.memento.update(HIDDEN_KEY, hidden);
    this.changed.fire();
  }

  async hide(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    await this.replace({ ...this.all(), ...Object.fromEntries(ids.map((id) => [id, now])) });
  }

  async unhide(ids: readonly string[]): Promise<void> {
    const drop = new Set(ids);
    await this.replace(Object.fromEntries(Object.entries(this.all()).filter(([id]) => !drop.has(id))));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
