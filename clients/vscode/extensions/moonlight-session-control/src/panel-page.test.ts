/**
 * The sidebar page (`media/panel.js`) drawn from a real `panelModel`, in a small fake DOM:
 * the page reads the model untyped, so this is what catches a field renamed on one side.
 * No jsdom — the page only sets `innerHTML` on three containers and listens on document.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vm from 'node:vm';

import type { DiscoverableSession } from 'moonlight-control-client';
import type { HeldApproval, ReviewPanelData } from 'moonlight-core';

import { panelModel, type PanelInput, type PanelModel } from './panel-model';

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');

type Handler = (e: unknown) => void;

class FakeButton {
  disabled = false;
  constructor(public dataset: Record<string, string>) {}
  closest(): FakeButton {
    return this;
  }
}

/** Load the page; returns what it drew, what it posted, and how to talk to it. */
function page() {
  const containers: Record<string, { innerHTML: string }> = {
    '#vtabs': { innerHTML: '' },
    '#holds': { innerHTML: '' },
    '#view': { innerHTML: '' },
  };
  const posted: unknown[] = [];
  const onDocument: Record<string, Handler> = {};
  const onWindow: Record<string, Handler> = {};
  const body = { classList: { toggle: () => undefined } };
  // The note's textarea, once the page has drawn one: focusing it makes it the active element.
  const note: { id: string; value: string; focus: () => void } = {
    id: 'note-text',
    value: '',
    focus: () => (document.activeElement = note),
  };
  const document = {
    body,
    activeElement: body as unknown,
    querySelector: (sel: string) =>
      containers[sel] ?? (sel === '#note-text' && containers['#view'].innerHTML.includes('id="note-text"') ? note : null),
    addEventListener: (type: string, fn: Handler) => (onDocument[type] = fn),
  };
  const sandbox = {
    document,
    window: { addEventListener: (type: string, fn: Handler) => (onWindow[type] = fn) },
    // Through JSON, as a real webview message is: plain objects of this realm, not the page's.
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) }),
    CSS: { escape: (s: string) => s },
    HTMLButtonElement: FakeButton,
    setTimeout,
  };
  vm.runInNewContext(PAGE, sandbox);
  return {
    posted,
    view: () => containers['#view'].innerHTML,
    holds: () => containers['#holds'].innerHTML,
    show: (model: PanelModel) => onWindow.message({ data: { type: 'model', model } }),
    click: (dataset: Record<string, string>) =>
      onDocument.click({ target: new FakeButton(dataset), stopPropagation: () => undefined }),
    type: (value: string) => {
      note.value = value;
      onDocument.input({ target: note });
    },
    change: (id: string, value: string, dataset: Record<string, string> = {}) =>
      onDocument.change({ target: { id, value, dataset } }),
    /** Focus leaves the note for somewhere outside its editor (no pointer pressed). */
    blurNote: () => {
      document.activeElement = body;
      onDocument.focusout({ relatedTarget: null });
    },
    noteFocused: () => document.activeElement === note,
  };
}

function session(id: string, over: Partial<DiscoverableSession> = {}): DiscoverableSession {
  return { session_id: id, title: id, root: '/p', adopted: true, status: 'Idle', phase: 'Review', unreviewed_files: 0, ...over };
}

const input = (over: Partial<PanelInput> = {}): PanelInput => ({
  sessions: [],
  holds: [],
  backendError: undefined,
  claudeMod: 'unknown',
  following: undefined,
  groupBy: 'none',
  groups: [],
  tab: 'sessions',
  selected: undefined,
  review: undefined,
  reviewInstalled: true,
  colorBlind: false,
  ...over,
});

const planHold = (sessionId: string): HeldApproval => ({
  sessionId,
  what: 'ExitPlanMode',
  plan: '# Ship it',
  mcpTool: undefined,
  sinceMs: 0,
});

test('the selected session lights its current phase, and the rail moves it', () => {
  const p = page();
  p.show(panelModel(input({ sessions: [session('a', { phase: 'Test' })], selected: 'a' })));
  assert.match(p.view(), /data-phase="Test"[^>]*aria-current="step"/);
  assert.doesNotMatch(p.view(), /data-phase="Review"[^>]*aria-current/);
  assert.match(p.view(), /data-next="a"/);
  p.click({ phase: 'Commit', id: 'a' });
  assert.deepEqual(p.posted.at(-1), { type: 'phase', id: 'a', phase: 'Commit' });
});

test('a held session shows its hold, and its rail is not a control until answered', () => {
  const p = page();
  p.show(panelModel(input({ sessions: [session('a')], holds: [planHold('a')], selected: 'a' })));
  assert.match(p.view(), /Ship it/);
  assert.match(p.view(), /data-open-hold="a" data-plan="1"/);
  assert.doesNotMatch(p.view(), /data-next=/);
  assert.equal((p.view().match(/class="ph"[^>]*disabled/g) ?? []).length, 5);
  p.click({ openHold: 'a', plan: '1' });
  assert.deepEqual(p.posted.slice(-2), [
    { type: 'select', id: 'a' },
    { type: 'command', command: 'reviewPlan', id: 'a' },
  ]);
});

test('an empty governed list says why', () => {
  const p = page();
  p.show(panelModel(input()));
  assert.match(p.view(), /No Claude Code sessions detected/);
  p.show(panelModel(input({ sessions: [session('f', { adopted: false })] })));
  assert.match(p.view(), /No session is governed yet/);
  p.show(panelModel(input({ backendError: 'refused' })));
  assert.match(p.view(), /No MoonlightCode backend is answering/);
});

const aiReview = (findings: Array<Record<string, unknown>>, skills = ['code-review']): ReviewPanelData => ({
  files: [],
  ignored: 0,
  comments: { pending: 0, resolved: 0 },
  ai: {
    kind: 'mod', scope: 'session', run: null, skills, status: null,
    findings: findings.map((f) => ({ id: 'f1', key: 'H1', severity: 'high', route: 'patch', owner: [], file: 'a.ts', line: 3, summary: 'Broken', detail: '', decision: 'keep', ...f })) as never,
    kept: findings.length, dismissed: 0, comments: 0,
  },
});

test('the Review tab draws each file and posts its actions', async () => {
  const review: ReviewPanelData = {
    files: [
      { path: '/p/src/a.ts', display: 'src/a.ts', status: 'M', added: 4, removed: 1, comments: 2, fromHead: true },
      { path: '/p/new.ts', display: 'new.ts', status: 'A', comments: 0, fromHead: false },
    ],
    ignored: 3,
    comments: { pending: 2, resolved: 0 },
    ai: { kind: 'stale' },
  };
  const p = page();
  p.show(panelModel(input({ sessions: [session('a')], tab: 'review', review })));
  const view = p.view();
  assert.match(view, /<span class="dir">src\/<\/span>a\.ts/);
  assert.match(view, /data-file="\/p\/src\/a\.ts"[^>]*aria-label="Open the diff of src\/a\.ts, modified"/);
  assert.match(view, /\+4<\/span> <span class="m">−1/);
  assert.match(view, /2 comments/);
  assert.match(view, /Baseline from git/);
  assert.match(view, /3 git-ignored files written too/);
  assert.match(view, /data-cmd="submitReview" data-id="a" >Send 2 comments/);
  p.click({ commentFile: '/p/src/a.ts', id: 'a' });
  p.click({ acceptFile: '/p/new.ts', id: 'a' });
  p.click({ file: '/p/src/a.ts', id: 'a' });
  assert.deepEqual(p.posted.slice(-3), [
    { type: 'commentFile', id: 'a', path: '/p/src/a.ts' },
    { type: 'acceptFile', id: 'a', path: '/p/new.ts' },
    { type: 'openFile', id: 'a', path: '/p/src/a.ts' },
  ]);
});

test('a review that could not be read says why on both tabs', () => {
  const review: ReviewPanelData = { files: [], ignored: 0, comments: { pending: 0, resolved: 0 }, ai: { kind: 'stale' }, error: 'AI Review did not answer' };
  const p = page();
  p.show(panelModel(input({ sessions: [session('a')], tab: 'review', review })));
  assert.match(p.view(), /could not be read: AI Review did not answer/);
  p.show(panelModel(input({ sessions: [session('a')], tab: 'ai', review })));
  assert.match(p.view(), /could not be read: AI Review did not answer/);
});

test('the reviewer picked survives a refresh, and Run sends it', () => {
  const model = () => panelModel(input({ sessions: [session('a')], tab: 'ai', review: aiReview([], ['code-review', 'security-review']) }));
  const p = page();
  p.show(model());
  p.change('skill', 'security-review');
  p.show(model());
  assert.match(p.view(), /<option selected>security-review<\/option>/);
  p.click({ ai: 'run', id: 'a' });
  assert.deepEqual(p.posted.at(-1), { type: 'ai', id: 'a', action: { type: 'run', skill: 'security-review' } });
});

test('reviewer output cannot inject markup through a finding', () => {
  const p = page();
  p.show(panelModel(input({
    sessions: [session('a')],
    tab: 'ai',
    review: aiReview([{ severity: 'low"><button data-ai="submit">', line: '3"><b>x</b>' }]),
  })));
  assert.doesNotMatch(p.view(), /<button data-ai="submit">/);
  assert.doesNotMatch(p.view(), /<b>x<\/b>/);
  assert.match(p.view(), /class="fd low"/);
  assert.match(p.view(), /a\.ts:0/);
});

test('no redraw under a note being typed; the catch-up comes when focus leaves it', () => {
  const model = (summary: string) => panelModel(input({ sessions: [session('a')], tab: 'ai', review: aiReview([{ summary }]) }));
  const p = page();
  p.show(model('First'));
  p.click({ note: 'f1' });
  assert.ok(p.noteFocused(), 'opening a note focuses it');
  p.type('Fix it');
  p.show(model('Second'));
  assert.match(p.view(), /First/, 'not redrawn while typing');
  p.blurNote();
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      assert.match(p.view(), /Second/);
      assert.match(p.view(), />Fix it<\/textarea>/, 'the draft is kept');
      assert.ok(!p.noteFocused(), 'focus is not pulled back into the note');
      p.click({ saveNote: 'f1', id: 'a' });
      assert.deepEqual(p.posted.at(-1), { type: 'ai', id: 'a', action: { type: 'note', id: 'f1', text: 'Fix it' } });
      assert.doesNotMatch(p.view(), /note-text/);
      resolve();
    }, 5)
  );
});

test('a note does not follow to another tab', () => {
  const model = (tab: 'ai' | 'sessions') => panelModel(input({ sessions: [session('a')], tab, review: aiReview([{}]) }));
  const p = page();
  p.show(model('ai'));
  p.click({ note: 'f1' });
  p.click({ tab: 'sessions' });
  p.show(model('ai'));
  assert.doesNotMatch(p.view(), /note-text/);
});

test('a session list is one Tab stop, on the selected row', () => {
  const p = page();
  p.show(panelModel(input({ sessions: [session('a'), session('b'), session('c')], selected: 'b' })));
  const stops = [...p.view().matchAll(/tabindex="0" data-select="(\w)"/g)].map((m) => m[1]);
  assert.deepEqual(stops, ['b']);
});
