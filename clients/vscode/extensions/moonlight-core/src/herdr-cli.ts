/**
 * Runs the `herdr` CLI for the editor: lists its workspaces and panes, starts a Claude
 * Code session in one, focuses it, and hands it a prompt. Arguments go to `execFile` as a
 * list — no shell line is ever built from a session id, a path or a JSON config.
 *
 * The rules (what matches the repository, which arguments) live in `herdr.ts`; this file
 * only runs them, so it stays thin.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';

import * as controlApi from 'moonlight-control-client';

import type { HerdrHost, StartOptions } from './api';
import {
  agentStartArgs,
  createArgs,
  createdPane,
  findHerdr,
  herdrError,
  parsePanes,
  parseWorkspaces,
  placements,
  type HerdrPane,
  type Placement,
} from './herdr';
import { daemonMcpUrl } from './terminals';

/** How long a listing may take, and a start (which waits for Claude Code to be ready). */
const QUICK_MS = 10_000;
const START_MS = 75_000;
/** Pane listings are reused this long: the sidebar asks on every redraw. */
const PANES_TTL_MS = 3_000;

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export class HerdrCli implements HerdrHost {
  private panesCache: { at: number; panes: HerdrPane[] } | undefined;

  private binary(): string | undefined {
    if (process.platform === 'win32') {
      return undefined;
    }
    const configured = vscode.workspace.getConfiguration('moonlight.herdr').get<string>('path', '').trim();
    return findHerdr(configured, process.env.PATH, os.homedir(), isFile);
  }

  private run(args: string[], timeout = QUICK_MS): Promise<unknown> {
    const bin = this.binary();
    if (!bin) {
      return Promise.reject(new Error('herdr is not installed (set moonlight.herdr.path if it is somewhere unusual).'));
    }
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${herdrError(String(stderr || err.message))}`));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch {
          reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: unreadable answer`));
        }
      });
    });
  }

  async available(): Promise<boolean> {
    // A listing answers only when the server is running: the one fact a start needs.
    try {
      await this.run(['workspace', 'list']);
      return true;
    } catch {
      return false;
    }
  }

  private async panes(fresh = false): Promise<HerdrPane[]> {
    if (!fresh && this.panesCache && Date.now() - this.panesCache.at < PANES_TTL_MS) {
      return this.panesCache.panes;
    }
    try {
      const panes = parsePanes(await this.run(['pane', 'list']));
      this.panesCache = { at: Date.now(), panes };
      return panes;
    } catch (err) {
      // A stopped server answers the same for a few seconds: no process per redraw.
      this.panesCache = { at: Date.now(), panes: [] };
      throw err;
    }
  }

  async placements(roots: readonly string[], lastUsed: string | undefined, repoName: string): Promise<Placement[]> {
    const [workspaces, panes] = await Promise.all([this.run(['workspace', 'list']).then(parseWorkspaces), this.panes(true)]);
    return placements(roots, workspaces, panes, lastUsed, repoName);
  }

  async start(
    sessionId: string,
    placement: Placement,
    cwd: string,
    options: StartOptions = {}
  ): Promise<{ pane: string; workspaceId: string | undefined }> {
    // The same checks and wiring as an editor terminal: our id shape, the launch variable
    // that keeps the verbs working after /resume, the daemon's MCP config when it governs.
    if (!controlApi.isSafeSessionId(sessionId)) {
      throw new Error(`refusing to launch — unexpected session id shape (${sessionId}).`);
    }
    const url = options.daemon !== false ? await daemonMcpUrl(sessionId) : undefined;
    const mcpJson = url ? controlApi.mcpConfigJson(url) : undefined;
    const created = await this.run(createArgs(placement, cwd, { [controlApi.LAUNCH_ENV]: sessionId }));
    const pane = createdPane(created);
    if (!pane) {
      throw new Error('herdr made no pane to start the session in.');
    }
    await this.run(agentStartArgs(sessionId, pane, mcpJson), START_MS);
    this.panesCache = undefined;
    const workspaceId = placement.kind === 'workspace' ? pane.split(':')[0] : placement.workspace.id;
    return { pane, workspaceId };
  }

  async paneOf(sessionId: string): Promise<string | undefined> {
    try {
      return (await this.panes()).find((p) => p.sessionId === sessionId)?.paneId;
    } catch {
      return undefined;
    }
  }

  async hosted(): Promise<ReadonlySet<string>> {
    try {
      return new Set((await this.panes()).flatMap((p) => (p.sessionId ? [p.sessionId] : [])));
    } catch {
      return new Set();
    }
  }

  async focus(sessionId: string): Promise<boolean> {
    const pane = await this.paneOf(sessionId);
    if (!pane) {
      return false;
    }
    await this.run(['agent', 'focus', pane]);
    return true;
  }

  async prompt(sessionId: string, text: string): Promise<boolean> {
    const pane = await this.paneOf(sessionId);
    if (!pane) {
      return false;
    }
    // herdr pastes it as one submission, and refuses an agent stuck on a question
    // rather than typing over it.
    await this.run(['agent', 'prompt', pane, text]);
    return true;
  }
}
