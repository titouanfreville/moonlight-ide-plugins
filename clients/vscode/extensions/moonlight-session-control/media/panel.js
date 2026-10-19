// The MoonlightCode sidebar's page: draws the model the extension posts
// (`panel-model.ts`) and posts back what was clicked. No rule lives here.
// @ts-check
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  let model;
  /** A finding whose note is being written: the page is not redrawn under it. */
  let noteOpen = null;
  /** What has been typed in that note, kept across redraws so a refresh never loses it. */
  let noteDraft;
  /** Move focus into the note once it is drawn: only right after the operator opened it. */
  let focusNote = false;
  let deferred = false;
  /** The reviewer picked in the Reviewer list: the list is rebuilt on every refresh. */
  let skillChoice;
  /** The session the review tabs were last drawn for: a note does not follow to another. */
  let targetId;
  /** The holds drawn last: the live region is only rewritten when they change. */
  let holdsHtml;
  /** A pointer is down: a redraw now would replace what it is clicking. */
  let pointerDown = false;
  let catchUpAfterClick = false;

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (m) => vscode.postMessage(m);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const LOCK =
    '<svg class="lock" width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h1v7H4V7h1Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"/></svg>';
  const ICON = {
    edit: '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9"/></svg>',
    comment: '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" d="M2.5 3h11v7.5H7l-3 2.5v-2.5H2.5z"/></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>',
  };

  function track(index, frozen) {
    if (index === undefined || index === null) return '';
    return `<span class="track" aria-hidden="true">${model.phases
      .map((_, k) => `<i class="${k < index ? 'done' : ''} ${k === index ? 'now' : ''} ${k === index && frozen ? 'frozen' : ''}"></i>`)
      .join('')}</span>`;
  }

  /**
   * One session row. A list is one Tab stop (roving tabindex): the selected row, else the
   * first, takes Tab; the arrow keys move between rows, as a listbox does.
   */
  function row(r, adopted, selected, tabStop) {
    const cls = ['s', adopted ? '' : 'ungated', r.held ? 'held' : '', r.following ? 'following' : ''].join(' ');
    return `<li class="${cls}" role="option" tabindex="${tabStop ? 0 : -1}" data-select="${esc(r.id)}" aria-selected="${r.id === selected}" title="${esc(r.tooltip)}">
      <span class="glyph" aria-hidden="true">${esc(r.glyph)}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="badge ${r.badge.tone}">${esc(r.badge.text)}</span>
      <span class="desc">${adopted ? track(r.phaseIndex, r.frozen) : ''}<span class="words">${esc(r.description)}</span></span>
    </li>`;
  }

  function renderTabs() {
    const tab = (id, label, n, tone) =>
      `<button class="vtab" role="tab" data-tab="${id}" aria-selected="${model.tab === id}" tabindex="${model.tab === id ? 0 : -1}">${label}${
        n ? `<span class="n ${tone || ''}" aria-hidden="true">${n}</span><span class="vh">, ${n} waiting</span>` : ''
      }</button>`;
    $('#vtabs').innerHTML =
      tab('sessions', 'Sessions', model.counts.held, 'held') +
      tab('review', 'Review', model.counts.review) +
      tab('ai', 'AI review', model.counts.ai);
  }

  function renderHolds() {
    // The selected session's hold is already in its detail below: not twice.
    const shown = model.holds.filter((h) => !(model.tab === 'sessions' && model.detail && h.sessionId === model.detail.id));
    // #holds is the live region (aria-live on the container, never on fresh children):
    // rewritten only when the holds change, so a refresh is not announced again.
    const html = shown
      .map(
        (h) => `<div class="attention">
          <p><strong>${h.plan ? 'A plan is waiting on you' : 'An action is waiting on you'}</strong> in ${esc(h.name)}</p>
          <div><button class="btn held" data-open-hold="${esc(h.sessionId)}" data-plan="${h.plan ? 1 : 0}">${h.plan ? 'Review the plan' : 'Answer'}</button></div>
        </div>`
      )
      .join('');
    if (html !== holdsHtml) {
      holdsHtml = html;
      $('#holds').innerHTML = html;
    }
  }

  /** The rows of one list, with its single Tab stop. */
  function rows(list, adopted, selected) {
    const stop = list.some((r) => r.id === selected) ? selected : list[0] && list[0].id;
    return list.map((r) => row(r, adopted, selected, r.id === stop)).join('');
  }

  function rail(d) {
    // A hold is answered first: moving the phase under it would only confuse the agent.
    const held = !!d.hold;
    const note = held
      ? 'Waiting on you: answer it above.'
      : d.frozen
        ? 'Project files are read-only. Notes stay writable.'
        : 'Project files are writable.';
    return `<div class="rail" role="group" aria-label="Phase">${model.phases
      .map((p, k) => {
        const lit = k === d.phaseIndex ? 'full' : k < d.phaseIndex ? 'half' : 'none';
        const title = held ? 'Answer what the session is waiting on first' : `${p.label}: project files ${p.frozen ? 'read-only' : 'writable'}`;
        return `<button class="ph" data-phase="${p.phase}" data-id="${esc(d.id)}" ${k === d.phaseIndex ? 'aria-current="step"' : ''}
          ${held ? 'disabled' : ''} title="${esc(title)}">
          <span class="disc ${lit}"></span>${p.frozen ? LOCK : ''}<span>${esc(p.label)}</span></button>`;
      })
      .join('')}</div>
      <div class="phase-note"><span>${note}</span>${held ? '' : `
        <button class="link" data-next="${esc(d.id)}">Next phase</button>`}</div>`;
  }

  function sessionsView() {
    const sel = model.detail ? model.detail.id : undefined;
    const gate = `<div class="gate"><span class="dot ${model.gate.tone}"></span>${esc(model.gate.text)}</div>`;
    let governed;
    if (model.governedEmpty === 'backend-down') {
      governed = `<div class="empty"><p>No MoonlightCode backend is answering. Without it nothing here is governed.</p>
        <p>Without a daemon, the MoonlightCode plugin for Claude Code gates each session itself, and its sessions show here.</p>
        <div class="actions"><button class="btn" data-cmd="refresh">Retry now</button>${
          model.offerMod ? '<button class="btn primary" data-cmd="installMod">Install the Claude Code plugin</button>' : ''
        }</div></div>`;
    } else if (model.governedEmpty === 'no-sessions') {
      governed = `<div class="empty"><p>No Claude Code sessions detected. A session appears once it writes its first transcript line.</p>
        <div class="actions"><button class="btn primary" data-cmd="startSession">Start a governed session</button></div></div>`;
    } else if (model.governedEmpty === 'none-governed') {
      governed = `<div class="empty"><p>No session is governed yet. The sessions below run with nothing gating them. Adopt one to put it under a workflow phase.</p></div>`;
    } else {
      governed = model.governed
        .map(
          (g) =>
            (g.label
              ? `<div class="group">${esc(g.label)}${
                  g.customId
                    ? `<span class="tools"><button class="ibtn" data-cmd="renameGroup" data-group="${esc(g.customId)}" title="Rename group" aria-label="Rename ${esc(g.label)}">${ICON.edit}</button>
                       <button class="ibtn" data-cmd="deleteGroup" data-group="${esc(g.customId)}" title="Delete group" aria-label="Delete ${esc(g.label)}">${ICON.trash}</button></span>`
                    : ''
                }</div>`
              : '') +
            `<ul class="sessions" role="listbox" aria-label="${esc(g.label || 'Governed sessions')}">${rows(g.rows, true, sel)}</ul>`
        )
        .join('');
    }
    const unadopted = model.unadopted.length
      ? `<ul class="sessions" role="listbox" aria-label="Sessions not gated">${rows(model.unadopted, false, sel)}</ul>`
      : `<p class="empty">Every detected session is governed.</p>`;
    return `${gate}
      <div class="list-head">Governed <span class="count">${model.governedCount}</span></div>${governed}
      <div class="list-head">Not gated <span class="count">${model.unadopted.length}</span></div>${unadopted}
      ${model.detail ? `<section class="detail" aria-label="Selected session">${detail(model.detail)}</section>` : ''}`;
  }

  function detail(d) {
    const head = `<div class="detail-head"><h2>${esc(d.name)}</h2><span class="meta">${esc(d.meta)}</span></div>`;
    if (!d.adopted) {
      return `${head}<p class="empty">Nothing gates this session: it can write anywhere. Adopt it to put it under a workflow phase.</p>
        <div class="footer"><button class="btn primary" data-cmd="adopt" data-id="${esc(d.id)}">Adopt this session</button>
        <button class="btn" data-cmd="follow" data-id="${esc(d.id)}">${d.following ? 'Following' : 'Follow'}</button></div>`;
    }
    let body;
    if (d.hold) {
      body = `<div class="plan"><h3>${esc(d.hold.what)}</h3>
        <p>${d.hold.plan ? 'The agent is stopped until you answer. Approving moves the session to Auto.' : 'The agent is stopped until you allow or deny this action.'}</p>
        <div><button class="btn held" data-open-hold="${esc(d.id)}" data-plan="${d.hold.plan ? 1 : 0}">${d.hold.plan ? 'Review the plan' : 'Answer'}</button></div></div>`;
    } else {
      const unreviewed = d.unreviewed
        ? `${plural(d.unreviewed, 'file')} to review`
        : 'No files waiting for review';
      body = `<ul class="rows">
        <li><button class="go" data-goto="review"><span class="what">${unreviewed}</span><span class="arrow">Review</span></button></li>
        <li><button class="go" data-goto="ai"><span class="what">AI review of this session</span><span class="arrow">AI review</span></button></li></ul>`;
    }
    return `${head}${rail(d)}${body}
      <div class="footer">
        <button class="btn primary" data-cmd="follow" data-id="${esc(d.id)}" ${d.following ? 'disabled' : ''}>${d.following ? 'Following this session' : 'Follow this session'}</button>
        <button class="btn" data-cmd="addToGroup" data-id="${esc(d.id)}">Add to group…</button>
        ${d.groupName ? `<button class="btn" data-cmd="removeFromGroup" data-id="${esc(d.id)}">Remove from ${esc(d.groupName)}</button>` : ''}
      </div>`;
  }

  function picker() {
    const t = model.target;
    return `<div class="picker">
      <select id="pick" aria-label="Session to review">${model.picker
        .map((o) => `<option value="${esc(o.id)}" ${o.id === t.id ? 'selected' : ''}>${esc(o.name)}</option>`)
        .join('')}</select>
      <span class="ctx">${track(t.phaseIndex, t.frozen)}<span>${esc(t.meta)}</span></span></div>`;
  }

  function noTarget() {
    return `<div class="empty"><p>No session is governed, so there is nothing to review. Adopt one from Sessions.</p>
      <div class="actions"><button class="btn" data-tab="sessions">Open Sessions</button></div></div>`;
  }

  function notInstalled() {
    return `<p class="empty">MoonlightCode AI Review is not installed, so there is no review to show. Install the MoonlightCode extension pack.</p>`;
  }

  function reviewView() {
    if (!model.target) return noTarget();
    if (!model.reviewInstalled) return picker() + notInstalled();
    const r = model.review;
    if (!r) return picker() + `<p class="empty">Reading the review…</p>`;
    const id = esc(model.target.id);
    let body;
    if (r.error) {
      body = `<p class="empty">The review queue could not be read: ${esc(r.error)}</p>`;
    } else if (r.files.length === 0) {
      body = `<p class="empty">Nothing waiting for review in this session.${
        r.comments.pending + r.comments.resolved > 0 ? ' Open the diffs to see the comments already written.' : ''
      }</p>`;
    } else {
      body = `<div class="sub"><span>${plural(r.files.length, 'file')} waiting</span></div>
        <ul class="files">${r.files
          .map((f) => {
            const slash = f.display.lastIndexOf('/');
            const dir = slash >= 0 ? f.display.slice(0, slash + 1) : '';
            const base = f.display.slice(slash + 1);
            // Counts from the mod's state file: numbers only, whatever the file says.
            const delta =
              f.added !== undefined
                ? `<span class="p">+${Number(f.added) || 0}</span> <span class="m">−${Number(f.removed) || 0}</span>`
                : '';
            const notes = f.comments ? ` ${plural(f.comments, 'comment')}` : '';
            // The row is a container: opening the diff is the path's own button, beside the
            // file's two actions, never a button inside a clickable row.
            return `<li class="f" title="${esc(f.path)}${f.fromHead ? '\nBaseline from git: it may include edits made before the session' : ''}">
              <span class="st ${esc(f.status)}" aria-hidden="true">${esc(f.status)}</span>
              <button class="path" data-file="${esc(f.path)}" data-id="${id}" aria-label="Open the diff of ${esc(f.display)}, ${STATUS[f.status] || 'changed'}"><bdi><span class="dir">${esc(dir)}</span>${esc(base)}</bdi></button>
              <span class="delta">${delta}${notes}</span>
              <button class="ibtn" data-comment-file="${esc(f.path)}" data-id="${id}" title="Comment on whole file" aria-label="Comment on ${esc(base)} as a whole">${ICON.comment}</button>
              <button class="ibtn" data-accept-file="${esc(f.path)}" data-id="${id}" title="Mark reviewed" aria-label="Mark ${esc(base)} reviewed">${ICON.check}</button>
            </li>`;
          })
          .join('')}</ul>`;
    }
    const ignored = r.ignored ? `<p class="warn">${plural(r.ignored, 'git-ignored file')} written too. Not up for review.</p>` : '';
    const pending = r.comments.pending;
    return `${picker()}<div class="pane">${body}${ignored}</div>
      <div class="footer">
        <button class="btn primary" data-cmd="submitReview" data-id="${id}" ${pending ? '' : 'disabled'}>${pending ? `Send ${plural(pending, 'comment')}` : 'Send review'}</button>
        <button class="btn" data-cmd="openReview" data-id="${id}">Open the diffs</button>
        <span class="why">Open a file to see its diff. Select lines in it to comment on them.</span>
      </div>`;
  }

  const MARK = { high: '!!!', medium: '!!', low: '!' };
  const STATUS = { A: 'added', M: 'modified', D: 'deleted' };

  /**
   * A finding's severity, from an allowlist: findings come from the reviewer's output via
   * the mod's state file, and the value lands in a class name.
   */
  const severityOf = (f) => (Object.prototype.hasOwnProperty.call(MARK, f.severity) ? f.severity : 'low');

  function finding(f, id) {
    const dismissed = f.decision === 'dismiss';
    const editing = noteOpen === f.id;
    const sev = severityOf(f);
    const line = Number(f.line) || 0;
    return `<li class="fd ${sev}${dismissed ? ' dismissed' : ''}">
      <div class="top"><span class="mark" aria-hidden="true">${MARK[sev]}</span><span class="vh">${sev} severity${dismissed ? ', dismissed' : ''}: </span><span class="summary">${esc(f.summary)}</span></div>
      <div class="sub-line"><button class="link" data-finding="${esc(f.file)}" data-line="${line}" data-id="${id}" title="Open ${esc(f.file)}:${line}">${esc(f.file)}:${line}</button><span>${esc(f.route)}</span></div>
      ${f.detail && !dismissed ? `<p class="body">${esc(f.detail)}</p>` : ''}
      ${f.fix && !dismissed ? `<pre class="fix">${esc(f.fix)}</pre>` : ''}
      ${f.note ? `<p class="note">Your note: ${esc(f.note)}</p>` : ''}
      ${
        editing
          ? `<div class="note-editor"><textarea id="note-text" rows="3" aria-label="Note on ${esc(f.summary)}" placeholder="What should the agent do about it?">${esc(noteDraft ?? f.note)}</textarea>
             <button class="btn primary" data-save-note="${esc(f.id)}" data-id="${id}">Save note</button><button class="btn" data-close-note>Cancel</button></div>`
          : `<div class="acts">
             <button class="btn" data-decide="${dismissed ? 'keep' : 'dismiss'}" data-finding-id="${esc(f.id)}" data-id="${id}">${dismissed ? 'Keep' : 'Dismiss'}</button>
             <button class="btn" data-note="${esc(f.id)}">${f.note ? 'Edit note' : 'Add note'}</button></div>`
      }
    </li>`;
  }

  function aiView() {
    if (!model.target) return noTarget();
    if (!model.reviewInstalled) return picker() + notInstalled();
    const r = model.review;
    if (!r) return picker() + `<p class="empty">Reading the review…</p>`;
    if (r.error) return picker() + `<p class="empty">The review could not be read: ${esc(r.error)}</p>`;
    const ai = r.ai;
    const id = esc(model.target.id);
    if (ai.kind === 'daemon') {
      return `${picker()}<p class="empty">The MoonlightCode daemon governs this session. AI review runs in sessions the MoonlightCode plugin for Claude Code governs: type <code>/ml-review</code> in one.</p>`;
    }
    if (ai.kind === 'stale') {
      return `${picker()}<p class="empty">This session's Claude Code plugin publishes no review yet. Update the plugin.</p>`;
    }
    const counts = { high: 0, medium: 0, low: 0 };
    ai.findings.forEach((f) => f.decision !== 'dismiss' && counts[severityOf(f)]++);
    const toSend = ai.kept + ai.comments;
    const run = ai.run
      ? `<button class="btn" data-ai="cancel" data-id="${id}">Cancel</button><span class="status">Running ${esc(ai.run.skill)}. Its findings land here.</span>`
      : ai.skills.length === 0
        ? `<span class="status">No review skill is installed in this session.</span>`
        : `<button class="btn primary" data-ai="run" data-id="${id}">Run AI review</button><span class="status">${esc(ai.status || (ai.findings.length ? '' : 'Not run yet'))}</span>`;
    return `${picker()}
      <div class="form">
        <label for="scope">Scope</label>
        <select id="scope" data-id="${id}" ${ai.run ? 'disabled' : ''}>
          <option value="session" ${ai.scope === 'session' ? 'selected' : ''}>This session's changes</option>
          <option value="head" ${ai.scope === 'head' ? 'selected' : ''}>Since the last commit</option>
        </select>
        ${ai.skills.length ? `<label for="skill">Reviewer</label><select id="skill" ${ai.run ? 'disabled' : ''}>${ai.skills.map((s) => `<option ${s === skillChoice ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>` : ''}
      </div>
      <div class="run">${run}</div>
      <div class="progress" ${ai.run ? '' : 'hidden'}><i></i></div>
      <div class="pane">
        ${ai.findings.length ? `<div class="tally"><span>!!! ${counts.high} high</span><span>!! ${counts.medium} medium</span><span>! ${counts.low} low</span></div>` : ''}
        <ul class="findings">${ai.findings.length ? ai.findings.map((f) => finding(f, id)).join('') : '<li class="empty">No findings yet. Run a review skill, or comment lines in the diff.</li>'}</ul>
      </div>
      <div class="footer">
        <button class="btn primary" data-ai="submit" data-id="${id}" ${toSend ? '' : 'disabled'}>Send review${toSend ? ` (${toSend})` : ''}</button>
        <button class="btn" data-ai="accept" data-id="${id}" ${toSend ? 'disabled' : ''}>Accept, all good</button>
        <span class="why">${plural(ai.kept, 'finding')} kept, ${ai.dismissed} dismissed, ${plural(ai.comments, 'line comment')}.${
          toSend ? ' Dismiss what you do not want sent, or send it.' : ''
        }</span>
      </div>`;
  }

  function render() {
    if (!model) return;
    // Never redraw under someone typing a note: the review republishes every few seconds.
    if (noteOpen && document.activeElement && document.activeElement.id === 'note-text') {
      deferred = true;
      return;
    }
    deferred = false;
    const focusKey = focusSelector(document.activeElement);
    document.body.classList.toggle('cb', !!model.colorBlind);
    renderTabs();
    renderHolds();
    $('#view').innerHTML = model.tab === 'review' ? reviewView() : model.tab === 'ai' ? aiView() : sessionsView();
    // The note takes focus once, when opened; after that focus goes back where it was.
    const note = noteOpen && focusNote ? $('#note-text') : null;
    focusNote = false;
    if (note) note.focus();
    else if (focusKey) $(focusKey)?.focus();
  }

  /** Close the note editor, dropping its draft: it belongs to one finding of one session. */
  function closeNote() {
    noteOpen = null;
    noteDraft = undefined;
  }

  /**
   * A selector that finds the focused control again once the page is redrawn: its id, or
   * its tag and data attributes (a row, a file, a phase, a finding's action). Every redraw
   * replaces the elements, and keyboard focus would otherwise fall back to the page.
   */
  function focusSelector(el) {
    if (!el || el === document.body) return undefined;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const data = Object.entries(el.dataset || {});
    if (data.length === 0) return undefined;
    const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    return el.tagName.toLowerCase() + data.map(([k, v]) => `[data-${kebab(k)}="${CSS.escape(v)}"]`).join('');
  }

  function setTab(tab) {
    if (tab !== model.tab) closeNote();
    model.tab = tab;
    post({ type: 'tab', tab });
    render();
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'model') {
      model = e.data.model;
      const target = model.target ? model.target.id : undefined;
      if (target !== targetId) {
        targetId = target;
        closeNote();
      }
      render();
    }
  });

  document.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('button, [data-select]');
    if (!t || (t instanceof HTMLButtonElement && t.disabled)) return;
    const d = t.dataset;
    if (d.tab) return setTab(d.tab);
    if (d.goto) return setTab(d.goto);
    if (d.select) {
      model.detail = undefined;
      return post({ type: 'select', id: d.select });
    }
    if (d.phase) return post({ type: 'phase', id: d.id, phase: d.phase });
    if (d.next) return post({ type: 'next', id: d.next });
    // A hold names its session: answering it also shows that session here.
    if (d.openHold) {
      post({ type: 'select', id: d.openHold });
      return post({ type: 'command', command: d.plan === '1' ? 'reviewPlan' : 'answerHold', id: d.openHold });
    }
    if (d.cmd) return post({ type: 'command', command: d.cmd, id: d.id, groupId: d.group });
    if (d.commentFile) {
      e.stopPropagation();
      return post({ type: 'commentFile', id: d.id, path: d.commentFile });
    }
    if (d.acceptFile) {
      e.stopPropagation();
      return post({ type: 'acceptFile', id: d.id, path: d.acceptFile });
    }
    if (d.file) return post({ type: 'openFile', id: d.id, path: d.file });
    if (d.finding) return post({ type: 'openFinding', id: d.id, file: d.finding, line: Number(d.line) });
    if (d.ai === 'run') {
      const skill = /** @type {HTMLSelectElement | null} */ ($('#skill'));
      return post({ type: 'ai', id: d.id, action: { type: 'run', skill: skill ? skill.value : skillChoice || '' } });
    }
    if (d.ai) return post({ type: 'ai', id: d.id, action: { type: d.ai } });
    if (d.decide) return post({ type: 'ai', id: d.id, action: { type: 'decide', id: d.findingId, decision: d.decide } });
    if (d.note) {
      noteOpen = d.note;
      noteDraft = undefined;
      focusNote = true;
      return render();
    }
    if ('closeNote' in d) {
      closeNote();
      return render();
    }
    if (d.saveNote) {
      const text = /** @type {HTMLTextAreaElement} */ ($('#note-text')).value;
      closeNote();
      post({ type: 'ai', id: d.id, action: { type: 'note', id: d.saveNote, text } });
      return render();
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('[data-select]')) {
      e.preventDefault();
      t.click();
    }
    // A session list is a listbox: Up/Down/Home/End move between its rows.
    if (t.matches('[role="option"]') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const options = Array.from(t.parentElement ? t.parentElement.querySelectorAll('[role="option"]') : []);
      const at = options.indexOf(t);
      const to =
        e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      options.forEach((o, k) => o.setAttribute('tabindex', k === to ? '0' : '-1'));
      options[to]?.focus();
    }
    // Arrow keys move between the three views, as a tablist does.
    if (t.matches('.vtab') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const tabs = ['sessions', 'review', 'ai'];
      const next = tabs[(tabs.indexOf(model.tab) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      setTab(next);
      $(`.vtab[data-tab="${next}"]`)?.focus();
    }
    if (e.key === 'Escape' && noteOpen) {
      closeNote();
      render();
    }
  });

  document.addEventListener('change', (e) => {
    const t = /** @type {HTMLSelectElement} */ (e.target);
    if (t.id === 'pick') post({ type: 'select', id: t.value });
    if (t.id === 'skill') skillChoice = t.value;
    if (t.id === 'scope') post({ type: 'ai', id: t.dataset.id, action: { type: 'scope', scope: t.value } });
  });

  document.addEventListener('input', (e) => {
    const t = /** @type {HTMLTextAreaElement} */ (e.target);
    if (t.id === 'note-text') noteDraft = t.value;
  });

  // Catch up once the note loses focus — never between a press and its click: a redraw
  // there would replace the element being clicked, and the click would land nowhere. A
  // pointer press waits for its release (the click follows in the same task); Save and
  // Cancel redraw themselves.
  document.addEventListener('pointerdown', () => (pointerDown = true), true);
  document.addEventListener(
    'pointerup',
    () => {
      pointerDown = false;
      if (catchUpAfterClick) {
        catchUpAfterClick = false;
        setTimeout(render, 0);
      }
    },
    true
  );
  document.addEventListener('focusout', (e) => {
    const to = /** @type {HTMLElement | null} */ (e.relatedTarget);
    if (!deferred || (to && to.closest('.note-editor'))) return;
    if (pointerDown) catchUpAfterClick = true;
    else setTimeout(render, 0);
  });

  post({ type: 'ready' });
})();
