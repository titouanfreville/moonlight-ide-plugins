/**
 * The AI review of a session the MoonlightCode mod governs: run a review skill, then
 * triage what it found — keep, dismiss, or keep with a note — and send the kept
 * findings with the line comments, or accept the review.
 *
 * The mod runs the skill in the session and reads its `moonlight-findings` block; this
 * panel shows the mod's review (`core.modReview`) and hands each decision to it. The
 * daemon has no findings, so a daemon session gets a pointer instead of a panel.
 */
import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ModFinding, ModReview, MoonlightApi } from 'moonlight-core';

import { pendingCounts, sortedFindings } from './mod-review';
import * as source from './review-source';

type Inbound =
  | { type: 'run'; skill: string }
  | { type: 'cancel' }
  | { type: 'scope'; scope: 'session' | 'head' }
  | { type: 'decide'; id: string; decision: 'keep' | 'dismiss' }
  | { type: 'note'; id: string; text: string }
  | { type: 'open'; file: string; line: number }
  | { type: 'submit' }
  | { type: 'accept' };

export class AiReviewPanel {
  private static current: AiReviewPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  // A note being typed is not redrawn under the operator: the mod republishes every
  // two seconds, and a redraw would drop what they are writing.
  private editing = false;

  static show(core: MoonlightApi, sessionId: string): void {
    if (AiReviewPanel.current) {
      AiReviewPanel.current.sessionId = sessionId;
      AiReviewPanel.current.panel.reveal();
      AiReviewPanel.current.render();
      return;
    }
    AiReviewPanel.current = new AiReviewPanel(core, sessionId);
  }

  private constructor(
    private readonly core: MoonlightApi,
    private sessionId: string
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'moonlight.aiReview',
      'AI review',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((m: Inbound | { type: 'editing'; open: boolean }) => {
        if (m.type === 'editing') {
          this.editing = m.open;
          return;
        }
        void this.onMessage(m);
      }),
      core.onDidChange(() => {
        if (!this.editing) {
          this.render();
        }
      })
    );
    this.render();
  }

  private dispose(): void {
    AiReviewPanel.current = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private async onMessage(m: Inbound): Promise<void> {
    if (m.type === 'open') {
      const root = this.core.sessions().find((s) => s.session_id === this.sessionId)?.root;
      const file = path.isAbsolute(m.file) || !root ? m.file : path.join(root, m.file);
      const line = Math.max(m.line - 1, 0);
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        selection: new vscode.Range(line, 0, line, 0),
        preview: true,
      });
      return;
    }
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const said = await source.sendAiReview(this.sessionId, this.entryFor(m));
      if (m.type === 'submit' || m.type === 'accept' || m.type === 'run') {
        void vscode.window.showInformationMessage(`MoonlightCode: ${said}`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`MoonlightCode: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
      this.editing = false;
      this.render();
    }
  }

  private entryFor(m: Exclude<Inbound, { type: 'open' }>) {
    switch (m.type) {
      case 'run':
        return { kind: 'review-run' as const, skill: m.skill };
      case 'cancel':
        return { kind: 'review-cancel' as const };
      case 'scope':
        return { kind: 'review-scope' as const, scope: m.scope };
      case 'decide':
        return { kind: 'finding' as const, id: m.id, decision: m.decision };
      // A note keeps the finding: it is what the agent is asked to act on.
      case 'note':
        return { kind: 'finding' as const, id: m.id, decision: 'keep' as const, note: m.text };
      case 'submit':
        return { kind: 'review-submit' as const };
      case 'accept':
        return { kind: 'review-accept' as const };
    }
  }

  private render(): void {
    const session = this.core.sessions().find((s) => s.session_id === this.sessionId);
    const title = session?.title ?? this.sessionId.slice(0, 8);
    this.panel.title = `AI review — ${title}`;
    const review = source.isModSession(this.sessionId) ? this.core.modReview?.(this.sessionId) : undefined;
    this.panel.webview.html = html(title, review, source.isModSession(this.sessionId));
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SEVERITY_LABEL: Record<ModFinding['severity'], string> = { high: 'High', medium: 'Medium', low: 'Low' };

function findingHtml(f: ModFinding): string {
  const dismissed = f.decision === 'dismiss';
  const place = `${f.file}:${f.line}`;
  return `
    <article class="finding ${f.severity}${dismissed ? ' dismissed' : ''}">
      <header>
        <span class="severity">${SEVERITY_LABEL[f.severity]}</span>
        <button class="link" data-open="${esc(f.file)}" data-line="${f.line}" title="Open ${esc(place)}">${esc(place)}</button>
        <span class="route">${esc(f.route)}</span>
      </header>
      <p class="summary">${esc(f.summary)}</p>
      ${f.detail ? `<p class="detail">${esc(f.detail)}</p>` : ''}
      ${f.fix ? `<pre class="fix">${esc(f.fix)}</pre>` : ''}
      ${f.note ? `<p class="note"><b>Your note:</b> ${esc(f.note)}</p>` : ''}
      <div class="actions">
        ${
          dismissed
            ? `<button data-decide="keep" data-id="${esc(f.id)}">Keep</button>`
            : `<button data-decide="dismiss" data-id="${esc(f.id)}">Dismiss</button>`
        }
        <button data-note="${esc(f.id)}">${f.note ? 'Edit note' : 'Add note'}</button>
      </div>
      <div class="note-editor" data-for="${esc(f.id)}" hidden>
        <textarea rows="3" placeholder="What the agent should do about it">${esc(f.note ?? '')}</textarea>
        <button class="primary" data-save="${esc(f.id)}">Save note</button>
      </div>
    </article>`;
}

export function html(title: string, review: ModReview | undefined, isMod: boolean): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  let body: string;
  if (!isMod) {
    body = `<p class="empty">“${esc(title)}” is governed by the MoonlightCode daemon. AI review runs in the
      MoonlightCode plugin for Claude Code: type <code>/ml-review</code> in a session it governs.</p>`;
  } else if (!review) {
    body = '<p class="empty">This session’s Claude Code plugin publishes no review yet: update the plugin.</p>';
  } else {
    const counts = pendingCounts(review);
    const findings = sortedFindings(review.findings);
    const run = review.run
      ? `<p class="status running">Running <b>${esc(review.run.skill)}</b>… its findings land here.
           <button data-action="cancel">Cancel</button></p>`
      : review.skills.length === 0
        ? '<p class="status">No review skill is installed in this session.</p>'
        : `<div class="run">
             <select id="skill">${review.skills.map((s) => `<option>${esc(s)}</option>`).join('')}</select>
             <button class="primary" data-action="run">Run AI review</button>
           </div>`;
    // What the run reviews: an empty scope gives the skill nothing to read.
    const scope = `<label class="scope">Reviewing
         <select id="scope"${review.run ? ' disabled' : ''}>
           <option value="session"${review.scope === 'session' ? ' selected' : ''}>this session's changes</option>
           <option value="head"${review.scope === 'head' ? ' selected' : ''}>everything since the last commit</option>
         </select>
         · ${review.files.length} file${review.files.length === 1 ? '' : 's'}</label>`;
    const status = review.findingsStatus && !review.run ? `<p class="status">${esc(review.findingsStatus)}</p>` : '';
    const list =
      findings.length === 0
        ? '<p class="empty">No findings yet. Run a review skill, or comment lines in the diff.</p>'
        : findings.map(findingHtml).join('');
    const toSend = counts.comments + counts.kept;
    body = `
      ${scope}
      ${run}
      ${status}
      <section class="findings">${list}</section>
      <footer>
        <span>${counts.kept} kept · ${counts.dismissed} dismissed · ${counts.comments} line comment${counts.comments === 1 ? '' : 's'}</span>
        <button class="primary" data-action="submit"${toSend === 0 ? ' disabled' : ''}>Send review (${toSend})</button>
        <button data-action="accept"${toSend > 0 ? ' disabled title="Send or dismiss what is pending first"' : ''}>Accept, all good</button>
      </footer>`;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px 72px; max-width: 72ch; }
  h1 { font-size: 1.1em; margin: 16px 0 8px; }
  .status { color: var(--vscode-descriptionForeground); }
  .running { color: var(--vscode-charts-blue); }
  .run { display: flex; gap: 8px; margin: 8px 0 16px; flex-wrap: wrap; }
  .scope { display: block; margin: 8px 0; color: var(--vscode-descriptionForeground); }
  select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  textarea { width: 100%; font-family: inherit; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; }
  .finding { border-left: 3px solid var(--vscode-panel-border); padding: 4px 0 8px 12px; margin: 12px 0; }
  .finding.high { border-left-color: var(--vscode-charts-red); }
  .finding.medium { border-left-color: var(--vscode-charts-yellow); }
  .finding.low { border-left-color: var(--vscode-charts-blue); }
  .finding.dismissed { opacity: .55; }
  .finding header { display: flex; gap: 10px; align-items: baseline; }
  .severity { font-weight: 600; }
  .route { color: var(--vscode-descriptionForeground); }
  .summary { font-weight: 600; margin: 6px 0; }
  .detail { margin: 6px 0; white-space: pre-wrap; }
  .fix { background: var(--vscode-textCodeBlock-background); padding: 6px; white-space: pre-wrap; }
  .actions, .note-editor { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; gap: 8px; align-items: center; padding: 10px 16px;
           background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
  footer span { flex: 1; color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<h1>AI review — ${esc(title)}</h1>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('scope')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'scope', scope: e.target.value });
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.action === 'run') vscode.postMessage({ type: 'run', skill: document.getElementById('skill').value });
    else if (b.dataset.action) vscode.postMessage({ type: b.dataset.action });
    else if (b.dataset.decide) vscode.postMessage({ type: 'decide', id: b.dataset.id, decision: b.dataset.decide });
    else if (b.dataset.open) vscode.postMessage({ type: 'open', file: b.dataset.open, line: Number(b.dataset.line) });
    else if (b.dataset.note) {
      const editor = document.querySelector('.note-editor[data-for="' + CSS.escape(b.dataset.note) + '"]');
      editor.hidden = false;
      editor.querySelector('textarea').focus();
      vscode.postMessage({ type: 'editing', open: true });
    } else if (b.dataset.save) {
      const editor = document.querySelector('.note-editor[data-for="' + CSS.escape(b.dataset.save) + '"]');
      vscode.postMessage({ type: 'note', id: b.dataset.save, text: editor.querySelector('textarea').value });
    }
  });
</script>
</body>
</html>`;
}
