import { marked } from '/vendor/marked/marked.esm.js';
import mermaid from '/vendor/mermaid/mermaid.esm.min.mjs';
import { drawScene, SCENE_FONT } from '/scenes.js';
import { compile } from '/formula.js';

/* ═══════════════════════════════ setup ═══════════════════════════════ */

marked.setOptions({ gfm: true, breaks: false });

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  fontFamily: '-apple-system, BlinkMacSystemFont, Inter, Segoe UI, sans-serif',
  themeVariables: {
    darkMode: true,
    background: '#0a0b0d',
    primaryColor: '#181a20',
    primaryTextColor: '#e9eaee',
    primaryBorderColor: '#7c5cff',
    secondaryColor: '#12141a',
    tertiaryColor: '#0f1013',
    lineColor: '#6b707c',
    textColor: '#d3d6dd',
    mainBkg: '#181a20',
    nodeBorder: '#7c5cff',
    clusterBkg: '#0f1013',
    clusterBorder: 'rgba(255,255,255,.12)',
    edgeLabelBackground: '#0a0b0d',
    actorBkg: '#181a20',
    actorBorder: '#7c5cff',
    actorTextColor: '#e9eaee',
    actorLineColor: '#4a4e58',
    signalColor: '#a4a8b3',
    signalTextColor: '#d3d6dd',
    labelBoxBkgColor: '#181a20',
    labelBoxBorderColor: '#7c5cff',
    labelTextColor: '#e9eaee',
    loopTextColor: '#d3d6dd',
    noteBkgColor: '#1a1725',
    noteBorderColor: '#7c5cff',
    noteTextColor: '#d3d6dd',
  },
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  boot: null,
  projects: [],
  projectId: null,
  project: null,        // { project, tabs, messages, suggestions }
  activeTab: 'console',  // 'console' | research id
  view: 'explanation',   // 'explanation' | 'original'
  stream: null,
  filter: '',
  wizard: { step: 1, source: 'url', file: null, templateId: null },
  editingTemplateId: null,
  editingProjectId: null,
  consoleBusy: false,
};

/* ═══════════════════════════════ utils ═══════════════════════════════ */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const body = isJson ? await res.json() : await res.text();

  // the session expired or was signed out elsewhere — go back to the gate
  if (res.status === 401 && body?.login) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new Error('Signed out.');
  }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

/* ─────────────────────── remember where the user was ─────────────────── */

let saveSessionTimer = null;
function rememberSession() {
  clearTimeout(saveSessionTimer);
  saveSessionTimer = setTimeout(() => {
    api('/api/session', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: state.projectId,
        activeTab: state.activeTab,
        view: state.view,
        card: state.shortsCard ?? 0,
        lang: state.shortsLang ?? 'en',
        theatre: document.body.classList.contains('reel-theatre'),
      }),
    }).catch(() => {});
  }, 600);
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 260);
  }, 4600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(String(text || '')), { ADD_ATTR: ['target'] });
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const secs = Math.round((Date.now() - then.getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const SOURCE_ICON = { url: '🔗', pdf: '📄', doc: '📃', text: '📝', file: '📄' };
const KIND_LABEL = { paper: 'paper', rfc: 'RFC', spec: 'spec', article: 'article' };
const LIVE = ['queued', 'extracting', 'running'];
const isLive = (s) => LIVE.includes(s);

/* ══════════════════════════ projects (sidebar) ═══════════════════════ */

async function loadProjects() {
  try {
    state.projects = await api('/api/projects');
    renderProjectList();
  } catch (err) {
    console.error(err);
  }
}

function renderProjectList() {
  const list = $('#projectList');
  const q = state.filter.toLowerCase();
  const rows = state.projects.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || (p.goal || '').toLowerCase().includes(q)
  );

  if (!rows.length) {
    list.innerHTML = `<div class="list-empty">${
      state.filter ? 'Nothing matches that search.' : 'No projects yet.<br />Hit <b>New Project</b> to start.'
    }</div>`;
    return;
  }

  list.innerHTML = rows
    .map(
      (p) => `
      <button class="r-item ${p.id === state.projectId ? 'is-active' : ''}" data-id="${p.id}">
        <div class="r-title">
          <span class="dot ${p.running_count ? 'running' : 'done'}"></span>${esc(p.name)}
        </div>
        <div class="r-meta">
          <span>${p.tab_count} tab${p.tab_count === 1 ? '' : 's'}</span>
          ${p.running_count ? `<span>·</span><span class="live-txt">${p.running_count} running</span>` : ''}
          <span>·</span><span>${esc(relTime(p.updated_at))}</span>
        </div>
      </button>`
    )
    .join('');

  $$('.r-item', list).forEach((el) =>
    el.addEventListener('click', () => openProject(Number(el.dataset.id)))
  );
}

/* ═════════════════════════════ workspace ═════════════════════════════ */

async function openProject(id, keepTab = false) {
  const changing = state.projectId !== id;
  state.projectId = id;
  rememberSession();
  if (changing) {
    state.activeTab = 'console';
    state.view = 'explanation';
    closeStream();
  }
  renderProjectList();
  await refreshProject({ keepTab: keepTab || !changing });
}

async function refreshProject({ keepTab = true } = {}) {
  if (!state.projectId) return;
  try {
    state.project = await api(`/api/projects/${state.projectId}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const tabs = state.project.tabs;
  if (!keepTab || (state.activeTab !== 'console' && !tabs.some((t) => t.id === state.activeTab))) {
    state.activeTab = 'console';
  }

  $('#emptyState').hidden = true;
  $('#workspace').hidden = false;
  $('#wsName').textContent = state.project.project.name;
  const goal = state.project.project.goal || state.project.project.description;
  $('#wsGoal').textContent = goal || '';
  $('#wsGoal').hidden = !goal;

  renderTabbar();
  renderActiveTab();
}

function renderTabbar() {
  const { tabs } = state.project;
  $('#tabbar').innerHTML =
    `<button class="tab-btn ${state.activeTab === 'console' ? 'is-active' : ''}" data-tab="console">
       <span class="tab-ico">◈</span> AI Console
     </button>` +
    tabs
      .map(
        (t) => `
      <button class="tab-btn ${state.activeTab === t.id ? 'is-active' : ''}" data-tab="${t.id}" title="${esc(
          t.source_title || t.name
        )}">
        <span class="tab-ico">${isLive(t.status) ? '<span class="tab-spin"></span>' : SOURCE_ICON[t.source_type] ?? '📄'}</span>
        <span class="tab-label">${esc(t.name)}</span>
        <span class="tab-close" data-close-tab="${t.id}" title="Remove this tab">✕</span>
      </button>`
      )
      .join('') +
    `<button class="tab-btn tab-add" id="addTabBtn" title="Add a source as a new tab">+</button>`;

  $$('#tabbar .tab-btn[data-tab]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.dataset.closeTab) return;
      const raw = el.dataset.tab;
      selectTab(raw === 'console' ? 'console' : Number(raw));
    })
  );

  $$('#tabbar [data-close-tab]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(el.dataset.closeTab);
      const tab = state.project.tabs.find((t) => t.id === id);
      if (!confirm(`Remove the tab “${tab?.name}”? Its report will be deleted.`)) return;
      try {
        await api(`/api/researches/${id}`, { method: 'DELETE' });
        if (state.activeTab === id) state.activeTab = 'console';
        closeStream();
        await refreshProject();
        await loadProjects();
        toast('Tab removed.');
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $('#addTabBtn').addEventListener('click', openSourceWizard);
}

function selectTab(tab) {
  state.activeTab = tab;
  state.view = 'explanation';
  state.shortsCard = 0;
  rememberSession();
  if (state.shortsStop) {
    state.shortsStop();
    state.shortsStop = null;
  }
  closeStream();
  renderTabbar();
  renderActiveTab();
}

function renderActiveTab() {
  if (state.activeTab === 'console') return renderConsole();
  return renderTabReport(state.activeTab);
}

/* ══════════════════════════════ console ══════════════════════════════ */

function renderConsole() {
  const { messages, suggestions } = state.project;
  const byMessage = new Map();
  for (const s of suggestions) {
    if (!byMessage.has(s.message_id)) byMessage.set(s.message_id, []);
    byMessage.get(s.message_id).push(s);
  }

  const thread = messages.length
    ? messages
        .map((m) => {
          if (m.role === 'user') {
            return `<div class="msg msg-user"><div class="msg-bubble">${esc(m.content)}</div></div>`;
          }
          const cards = (byMessage.get(m.id) ?? []).map(suggestionCard).join('');
          return `<div class="msg msg-ai">
              <div class="msg-avatar">◈</div>
              <div class="msg-content">
                <div class="prose">${md(m.content)}</div>
                ${cards ? `<div class="sugg-list">${cards}</div>` : ''}
              </div>
            </div>`;
        })
        .join('')
    : `<div class="console-hello">
         <div class="hello-mark">◈</div>
         <h3>Tell me what you're trying to understand</h3>
         <p>I'll find the papers, RFCs and specs that actually teach it — then each one opens in its own tab with the original document alongside a full plain-English breakdown.</p>
         <div class="hello-examples">
           ${[
             'I want to understand how transformers and attention work, from the original papers',
             'Explain how HTTPS actually secures a connection — the real specs',
             "I'm a junior dev. Teach me diffusion models with the maths explained",
             'What should I read to understand retrieval-augmented generation?',
           ]
             .map((x) => `<button class="ex-chip" data-example="${esc(x)}">${esc(x)}</button>`)
             .join('')}
         </div>
       </div>`;

  $('#wsBody').innerHTML = `
    <div class="console">
      <div class="console-thread" id="consoleThread">${thread}</div>
      <div class="console-input-wrap">
        <textarea id="consoleInput" class="console-input" rows="1"
          placeholder="Describe what you want to understand…  (Enter to send, Shift+Enter for a new line)"></textarea>
        <button class="btn btn-primary console-send" id="consoleSend">Ask</button>
      </div>
      <div class="console-foot-hint">Sources are looked up for real — arXiv and the RFC editor are checked before a link is offered.</div>
    </div>`;

  const input = $('#consoleInput');
  const send = $('#consoleSend');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  };
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitConsole();
    }
  });
  send.addEventListener('click', submitConsole);

  $$('[data-example]').forEach((b) =>
    b.addEventListener('click', () => {
      input.value = b.dataset.example;
      autoGrow();
      input.focus();
    })
  );

  $$('[data-add-sugg]').forEach((b) =>
    b.addEventListener('click', () => addSuggestion(Number(b.dataset.addSugg), b))
  );

  const thr = $('#consoleThread');
  thr.scrollTop = thr.scrollHeight;
  if (state.consoleBusy) setConsoleBusy(true);
  else input.focus();
}

function suggestionCard(s) {
  const already = s.added_research_id && state.project.tabs.some((t) => t.id === s.added_research_id);
  const meta = [KIND_LABEL[s.kind] ?? s.kind, s.authors, s.year].filter(Boolean).join(' · ');
  return `
    <div class="sugg">
      <div class="sugg-main">
        <div class="sugg-title">
          ${esc(s.title)}
          ${s.verified ? '<span class="verify ok" title="Link checked and reachable">✓ verified</span>'
                       : '<span class="verify warn" title="Could not confirm this link automatically — open it before trusting it">? unverified</span>'}
        </div>
        <div class="sugg-meta">${esc(meta)}</div>
        <div class="sugg-why">${esc(s.why)}</div>
        ${s.reads_before ? `<div class="sugg-pre">Read first: ${esc(s.reads_before)}</div>` : ''}
        ${s.url ? `<a class="sugg-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.url)}</a>` : '<div class="sugg-pre">No link found — add it manually with “+”.</div>'}
      </div>
      <div class="sugg-actions">
        ${already
          ? `<button class="btn btn-ghost btn-sm" data-goto-tab="${s.added_research_id}">Open tab</button>`
          : s.url
            ? `<button class="btn btn-primary btn-sm" data-add-sugg="${s.id}">+ Add as tab</button>`
            : ''}
      </div>
    </div>`;
}

function setConsoleBusy(busy) {
  state.consoleBusy = busy;
  const send = $('#consoleSend');
  const input = $('#consoleInput');
  if (!send) return;
  send.disabled = busy;
  input.disabled = busy;
  send.textContent = busy ? 'Searching…' : 'Ask';
  let think = $('#consoleThinking');
  if (busy && !think) {
    think = document.createElement('div');
    think.id = 'consoleThinking';
    think.className = 'msg msg-ai';
    think.innerHTML = `<div class="msg-avatar">◈</div><div class="msg-content">
        <div class="thinking"><span class="spinner"></span> Working out which papers and RFCs actually answer this, then checking the links are real…</div>
      </div>`;
    $('#consoleThread')?.append(think);
    $('#consoleThread').scrollTop = $('#consoleThread').scrollHeight;
  }
  if (!busy) think?.remove();
}

async function submitConsole() {
  const input = $('#consoleInput');
  const message = input.value.trim();
  if (!message || state.consoleBusy) return;

  // optimistic echo so the thread feels alive while the model works
  const thread = $('#consoleThread');
  $('.console-hello')?.remove();
  const echo = document.createElement('div');
  echo.className = 'msg msg-user';
  echo.innerHTML = `<div class="msg-bubble">${esc(message)}</div>`;
  thread.append(echo);
  input.value = '';
  input.style.height = 'auto';
  setConsoleBusy(true);

  try {
    await api(`/api/projects/${state.projectId}/console`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    state.consoleBusy = false;
    await refreshProject();
    await loadProjects();
  } catch (err) {
    setConsoleBusy(false);
    toast(err.message, 'error');
    input.value = message;
  }
}

async function addSuggestion(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const created = await api(`/api/suggestions/${id}/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    await refreshProject();
    await loadProjects();
    selectTab(created.id);
    toast('Added as a tab — generating the explanation now.', 'ok');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '+ Add as tab';
    toast(err.message, 'error');
  }
}

/* ═══════════════════════════ report (a tab) ══════════════════════════ */

function closeStream() {
  state.stream?.close();
  state.stream = null;
}

async function renderTabReport(id) {
  const live = await refreshReport(id);
  if (live && !state.stream) openStream(id);
}

async function refreshReport(id) {
  try {
    const data = await api(`/api/researches/${id}`);
    if (state.activeTab !== id) return false;
    renderReport(data);
    return isLive(data.research.status);
  } catch (err) {
    toast(err.message, 'error');
    return false;
  }
}

function openStream(id) {
  const es = new EventSource(`/api/researches/${id}/stream`);
  state.stream = es;

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (state.activeTab !== id) return;

    if (msg.type === 'stage' || msg.type === 'status') {
      if (msg.stage !== undefined && $('#stageText')) $('#stageText').textContent = msg.stage;
      if (msg.progress !== undefined) {
        if ($('#bar')) $('#bar').style.width = `${msg.progress}%`;
        if ($('#pct')) $('#pct').textContent = `${msg.progress}%`;
      }
    }
    if (msg.type === 'log') appendLog(msg);
    if (msg.type === 'section') refreshReport(id);
    if (msg.type === 'done') {
      closeStream();
      refreshReport(id);
      refreshProject();
      loadProjects();
    }
  };
  es.onerror = () => {};
}

function appendLog(msg) {
  const log = $('#log');
  if (!log) return;
  const line = document.createElement('div');
  line.className = `log-line ${msg.level || 'info'}`;
  const t = new Date(msg.at || Date.now()).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  line.innerHTML = `<span class="t">${t}</span><span>${esc(msg.message)}</span>`;
  log.append(line);
  log.scrollTop = log.scrollHeight;
}

function renderReport(data) {
  const { research: r, sections, diagrams, glossary, events, simulations, scenes3d } = data;
  const live = isLive(r.status);

  // never leave a reel playing behind a view the user has navigated away from
  (state.scene3dHandles ?? []).forEach((h) => h?.dispose?.());
  state.scene3dHandles = [];

  if (state.view !== 'shorts' && state.shortsStop) {
    state.shortsStop();
    state.shortsStop = null;
  }

  const sourceHtml =
    r.source_type === 'url'
      ? `<a href="${esc(r.source_ref)}" target="_blank" rel="noopener noreferrer">${esc(r.source_ref)}</a>`
      : esc(r.source_label);

  const chips = [
    r.status === 'done' ? '<span class="chip ok">✓ complete</span>' : '',
    live ? '<span class="chip live">● generating</span>' : '',
    r.status === 'error' ? '<span class="chip err">✕ failed</span>' : '',
    r.status === 'cancelled' ? '<span class="chip">cancelled</span>' : '',
    r.template_name ? `<span class="chip">${esc(r.template_name)}</span>` : '',
    r.provider ? `<span class="chip">${esc(r.provider)}${r.model ? ' · ' + esc(r.model) : ''}</span>` : '',
    r.chars ? `<span class="chip">${Number(r.chars).toLocaleString()} chars read</span>` : '',
  ]
    .filter(Boolean)
    .join('');

  $('#wsBody').innerHTML = `
    <div class="report ${state.view === 'shorts' ? 'is-shorts' : ''}">
      <header class="report-head">
        <h1>${esc(r.source_title || r.name)}</h1>
        <p class="report-source">${sourceHtml}</p>
        <div class="chips">${chips}</div>
        <div class="report-actions">
          <div class="segmented" id="viewToggle">
            <button class="seg ${state.view === 'explanation' ? 'is-active' : ''}" data-view="explanation">Explanation</button>
            <button class="seg ${state.view === 'shorts' ? 'is-active' : ''}" data-view="shorts">⚡ Shorts</button>
            <button class="seg ${state.view === 'original' ? 'is-active' : ''}" data-view="original">Original document</button>
          </div>
          <span class="spacer"></span>
          ${live
            ? '<button class="btn btn-ghost btn-sm" id="cancelBtn">Stop</button>'
            : '<button class="btn btn-ghost btn-sm" id="rerunBtn">↻ Regenerate</button>'}
          <a class="btn btn-ghost btn-sm" href="/api/researches/${r.id}/export" download>↓ Markdown</a>
        </div>
      </header>

      ${live || r.status === 'error' || r.status === 'cancelled' ? progressCard(r) : ''}
      ${r.status === 'error' && r.error ? `<div class="error-card"><b>Generation failed</b>${esc(r.error)}</div>` : ''}

      <div id="viewRoot">${
        state.view === 'explanation'
          ? sections.map((s) => sectionHtml(s, diagrams, glossary)).join('') +
            (simulations ?? []).map(simulationHtml).join('') +
            (scenes3d ?? []).map(scene3dHtml).join('') ||
            '<div class="hint" style="margin-top:30px">Nothing written yet — the first sections will appear here as they finish.</div>'
          : '<div class="original-loading"><span class="spinner"></span> Loading…</div>'
      }</div>
    </div>`;

  $('#main').scrollTop = 0;
  $('#workspace').classList.toggle('is-shorts-mode', state.view === 'shorts');

  $$('#viewToggle .seg').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      state.shortsCard = 0;
      rememberSession();
      $$('#viewToggle .seg').forEach((x) => x.classList.toggle('is-active', x === b));
      // the shorts view uses compact chrome, so re-render rather than swap in place
      if (state.view === 'shorts' || b.closest('.report').classList.contains('is-shorts')) {
        refreshReport(r.id);
      } else if (state.view === 'original') {
        loadOriginal(r.id);
      } else {
        refreshReport(r.id);
      }
    })
  );

  $('#rerunBtn')?.addEventListener('click', async () => {
    try {
      await api(`/api/researches/${r.id}/rerun`, { method: 'POST' });
      toast('Regenerating…');
      closeStream();
      renderTabReport(r.id);
      refreshProject();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#cancelBtn')?.addEventListener('click', async () => {
    await api(`/api/researches/${r.id}/cancel`, { method: 'POST' }).catch(() => {});
    toast('Stopping…');
  });

  if (state.view === 'explanation') {
    (events || []).forEach(appendLog);
    renderDiagrams();
    wrapTables();
    wireSimulations(simulations ?? []);
    wireScenes3d(scenes3d ?? []);
  } else if (state.view === 'shorts') {
    loadShorts(r.id);
  } else {
    loadOriginal(r.id);
  }
}

/* ═══════════════════════════════ shorts ══════════════════════════════ */

const KIND_TAG = {
  hook: 'the hook',
  problem: 'the problem',
  idea: 'the idea',
  number: 'by the numbers',
  analogy: 'think of it like',
  catch: 'the catch',
  payoff: 'so what',
};

async function loadShorts(id, { poll = false } = {}) {
  const root = $('#viewRoot');
  if (!root) return;

  let data;
  try {
    const lang = state.shortsLang || 'en';
    data = await api(`/api/researches/${id}/shorts?lang=${encodeURIComponent(lang)}`);
    if (data.cards?.length) {
      data.narration = await api(
        `/api/researches/${id}/narration?lang=${encodeURIComponent(lang)}`
      ).catch(() => null);
    }
  } catch (err) {
    root.innerHTML = `<div class="error-card"><b>Shorts unavailable</b>${esc(err.message)}</div>`;
    return;
  }
  if (state.activeTab !== id || state.view !== 'shorts') return;

  if (data.status === 'running') {
    root.innerHTML = `
      <div class="shorts-empty">
        <div class="shorts-spark">⚡</div>
        <h3>Cutting the paper into cards…</h3>
        <p>One pass over the whole document to find the ten or so ideas worth remembering. About a minute.</p>
        <div class="original-loading" style="justify-content:center"><span class="spinner"></span> Working</div>
      </div>`;
    setTimeout(() => loadShorts(id, { poll: true }), 4000);
    return;
  }

  if (data.status === 'error') {
    root.innerHTML = `<div class="error-card"><b>Could not build the shorts</b>${esc(data.error)}</div>
      <button class="btn btn-primary" id="genShorts" style="margin-top:14px">Try again</button>`;
    $('#genShorts').addEventListener('click', () => startShorts(id));
    return;
  }

  if (!data.cards.length) {
    root.innerHTML = `
      <div class="shorts-empty">
        <div class="shorts-spark">⚡</div>
        <h3>Turn this paper into a swipe feed</h3>
        <p>Ten to fourteen cards, one idea each, in the order that builds understanding — the hook, the problem, the ideas, the catch, the payoff. Made to be flicked through in three minutes and actually remembered.</p>
        <button class="btn btn-primary btn-lg" id="genShorts">⚡ Generate shorts</button>
      </div>`;
    $('#genShorts').addEventListener('click', () => startShorts(id));
    return;
  }

  renderShortsFeed(id, data.cards, data);
}

/* ---------------------------------------------------------- narration */

/** Record real narration audio for this language, then reopen the reel with it. */
async function ensureNarration(id, lang, { keepIndex = 0, wasPlaying = false } = {}) {
  const badge = $('#shortsLangState');
  const langName = currentLang().native;
  try {
    let n = await api(`/api/researches/${id}/narration?lang=${encodeURIComponent(lang)}`);
    if (n.status !== 'done') {
      if (badge) badge.textContent = `Recording ${langName} narration…`;
      await api(`/api/researches/${id}/narration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang }),
      });
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (state.activeTab !== id || state.view !== 'shorts') return;
        n = await api(`/api/researches/${id}/narration?lang=${encodeURIComponent(lang)}`);
        if (badge && n.status === 'running') {
          badge.textContent = `Recording ${langName} narration… ${n.done}/${n.total}`;
        }
        if (n.status === 'error') {
          toast(n.error, 'error');
          if (badge) badge.textContent = '';
          return;
        }
        if (n.status === 'done') break;
      }
    }
    if (n.status !== 'done') return toast('Narration is taking unusually long.', 'error');

    state.shortsVoice = true;
    state.shortsResume = { index: keepIndex, playing: wasPlaying };
    const data = await api(`/api/researches/${id}/shorts?lang=${encodeURIComponent(lang)}`);
    data.narration = n;
    renderShortsFeed(id, data.cards, data);
    toast(`Narration ready — ${n.voice} reading in ${langName}.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
    if (badge) badge.textContent = '';
  }
}

/* ------------------------------------------------------- live translation */

function currentLang() {
  return (state.boot.languages ?? []).find((l) => l.code === (state.shortsLang || 'en')) ??
    { code: 'en', label: 'English', native: 'English', voice: 'en-US' };
}

/**
 * Swap the reel into another language. Cached translations come back instantly;
 * a new one is written in the background and the cards are replaced in place,
 * without losing where the viewer is in the reel.
 */
async function switchShortsLanguage(id, code, { keepIndex = 0, wasPlaying = false } = {}) {
  state.shortsLang = code;
  const lang = currentLang();
  const badge = $('#shortsLangState');

  const applyIfReady = (data) => {
    if (state.activeTab !== id || state.view !== 'shorts') return false;
    const ready = code === 'en' || data.translation?.status === 'done';
    if (!ready) return false;
    state.shortsResume = { index: keepIndex, playing: wasPlaying };
    renderShortsFeed(id, data.cards, data);
    return true;
  };

  try {
    const withNarration = async (d) => {
      d.narration = await api(`/api/researches/${id}/narration?lang=${encodeURIComponent(code)}`).catch(() => null);
      return d;
    };
    let data = await withNarration(await api(`/api/researches/${id}/shorts?lang=${encodeURIComponent(code)}`));
    if (applyIfReady(data)) return;

    if (badge) badge.textContent = `Translating into ${lang.native}…`;
    await api(`/api/researches/${id}/shorts/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: code }),
    });

    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (state.activeTab !== id || state.view !== 'shorts' || state.shortsLang !== code) return;
      data = await withNarration(await api(`/api/researches/${id}/shorts?lang=${encodeURIComponent(code)}`));
      if (data.translation?.status === 'error') {
        toast(`Translation failed: ${data.translation.error}`, 'error');
        if (badge) badge.textContent = '';
        return;
      }
      if (applyIfReady(data)) {
        toast(`Now playing in ${lang.native}.`, 'ok');
        return;
      }
    }
    toast('Translation is taking unusually long — try again.', 'error');
  } catch (err) {
    toast(err.message, 'error');
    if (badge) badge.textContent = '';
  }
}

async function startShorts(id) {
  try {
    await api(`/api/researches/${id}/shorts`, { method: 'POST' });
    loadShorts(id);
  } catch (err) {
    toast(err.message, 'error');
  }
}
/* ─────────────────────────── the shorts player ────────────────────────── */

/** How long a card stays on screen, from how much there is to read. */
function cardDuration(card, clip) {
  const words = `${card.headline} ${card.body}`.trim().split(/\s+/).length;
  const reading = Math.min(11000, Math.max(4200, 1400 + words * 300));
  // when there is recorded narration, the card must outlast the voice
  return clip?.durationMs ? Math.max(reading, clip.durationMs + 900) : reading;
}

/** Split a headline into per-word spans so it can animate in. */
function kineticWords(text) {
  return String(text)
    .split(/\s+/)
    .map((w, i) => `<span class="kw" style="--i:${i}">${esc(w)}</span>`)
    .join(' ');
}

function renderShortsFeed(id, cards, meta = {}) {
  const root = $('#viewRoot');
  const clips = meta.narration?.clips ?? [];
  const durOf = (c, i) => cardDuration(c, clips[i]);
  const totalSecs = Math.round(cards.reduce((a, c, i) => a + durOf(c, i), 0) / 1000);
  const langs = state.boot.languages ?? [];
  const lang = currentLang();
  const resume = state.shortsResume;
  state.shortsResume = null;

  root.innerHTML = `
    <div class="shorts" id="shorts" tabindex="0">
      <div class="shorts-progress" id="shortsProgress">
        ${cards.map((_, i) => `<i data-bar="${i}"><b></b></i>`).join('')}
      </div>

      <div class="shorts-stage" id="shortsStage">
        ${cards
          .map(
            (c, i) => `
          <article class="short kind-${esc(c.kind)}" data-card="${i}" ${lang.rtl ? 'dir="rtl"' : ''}>
            <div class="short-inner">
              <div class="short-top">
                <span class="short-emoji">${esc(c.emoji || '✦')}</span>
                <span class="short-tag">${esc(c.tag || KIND_TAG[c.kind] || c.kind)}</span>
                <span class="short-count">${i + 1} / ${cards.length}</span>
              </div>
              <h2 class="short-headline">${kineticWords(c.headline)}</h2>
              ${c.scene ? `<canvas class="short-scene" data-scene="${i}"></canvas>` : ''}
              ${c.punch ? `<div class="short-punch" data-punch="${esc(c.punch)}">${esc(c.punch)}</div>` : ''}
              <p class="short-body">${esc(c.body)}</p>
            </div>
            <div class="short-zones">
              <button class="zone zone-prev" title="Previous"></button>
              <button class="zone zone-pause" title="Pause / play"></button>
              <button class="zone zone-next" title="Next"></button>
            </div>
            <div class="short-paused" hidden>❚❚ paused</div>
          </article>`
          )
          .join('')}
      </div>

      <div class="shorts-controls">
        <button class="shorts-nav" id="shortsPrev" title="Previous (↑)">↑</button>
        <button class="shorts-play" id="shortsPlay" title="Play / pause (space)">▶</button>
        <button class="shorts-nav" id="shortsNext" title="Next (↓)">↓</button>
        <span class="shorts-gap"></span>
        <select class="shorts-lang" id="shortsLang" title="Play in another language">
          ${langs
            .map(
              (l) =>
                `<option value="${l.code}" ${l.code === lang.code ? 'selected' : ''}>🌐 ${esc(l.native)}</option>`
            )
            .join('')}
        </select>
        <button class="btn btn-ghost btn-sm ${state.shortsVoice ? 'is-on' : ''}" id="shortsVoice" title="Read the cards aloud">${state.shortsVoice ? '🔊' : '🔇'}</button>
        <button class="btn btn-ghost btn-sm" id="shortsFull" title="Full screen (f)">⛶</button>
        <button class="btn btn-ghost btn-sm shorts-exit" id="shortsExit" title="Leave full screen (Esc)">✕</button>
        <button class="btn btn-ghost btn-sm" id="shortsSave" title="Record the reel as a video file">⬇ Video</button>
        <button class="btn btn-ghost btn-sm" id="shortsRegen" title="Rebuild the feed">↻</button>
      </div>
      <div class="shorts-hint" id="shortsHint">
        <span id="shortsLangState"></span>
        ${cards.length} cards · ${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s · tap the middle to pause, the sides to skip
      </div>
    </div>`;

  const stage = $('#shortsStage');
  const bars = $$('#shortsProgress i');
  const cardEls = $$('.short', stage);
  let current = 0;
  let playing = false;
  let timer = null;
  let voice = !!state.shortsVoice;

  /* ---------------------------------------------------------- sizing */

  const fitStage = () => {
    // getBoundingClientRect().top is already viewport-relative; adding scrollTop
    // mixed coordinate systems and shrank the stage whenever the page happened
    // to be scrolled
    const top = stage.getBoundingClientRect().top;
    // measure what sits below the stage rather than assuming — the control row
    // wraps to two lines on narrow windows and in some languages
    const controls = $('.shorts-controls');
    const hint = $('#shortsHint');
    const reserve = (controls?.offsetHeight ?? 46) + (hint?.offsetHeight ?? 20) + 46;
    stage.style.height = `${Math.max(300, window.innerHeight - top - reserve)}px`;
    stage.scrollTop = current * stage.clientHeight;
  };
  fitStage();

  /* ------------------------------------------------------- animation */

  const countUp = (el) => {
    const raw = el.dataset.punch || '';
    const m = raw.match(/^([^\d-]*)(-?[\d][\d,.]*)(.*)$/s);
    if (!m) return;
    const [, pre, numRaw, post] = m;
    const target = Number(numRaw.replace(/,/g, ''));
    if (!Number.isFinite(target) || Math.abs(target) > 1e12) return;
    const decimals = (numRaw.split('.')[1] || '').length;
    const grouped = numRaw.includes(',');
    const started = performance.now();
    const dur = 900;
    // a timer, not requestAnimationFrame: rAF stops entirely in a tab that is not
    // being painted, which would leave the figure frozen at zero
    const tick = () => {
      const now = performance.now();
      if (!el.isConnected || el.dataset.punch !== raw) return;
      if (now - started >= dur) {
        el.textContent = raw; // always land exactly on the real figure
        return;
      }
      const t = Math.min(1, (now - started) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = (target * eased).toFixed(decimals);
      // only group thousands if the source did — otherwise years become "2,017"
      const shown = grouped
        ? Number(value).toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : value;
      el.textContent = `${pre}${shown}${post}`;
      setTimeout(tick, 33);
    };
    el.textContent = `${pre}0${post}`;
    setTimeout(tick, 33);
  };

  /**
   * Shrink a card's type until it genuinely fits its box. Card height is driven
   * by the window, body length by the model — so no fixed size can be right for
   * every card on every screen. Better to scale down a little than to clip a
   * sentence in half.
   */
  const fitText = (el) => {
    const inner = el?.querySelector('.short-inner');
    if (!inner) return;
    inner.style.setProperty('--fit', '1');
    inner.style.setProperty('--sfit', '1');
    if (!inner.clientHeight) return;

    // The entrance keyframes translate elements by 10px, and a transformed child
    // enlarges the scrollable overflow area even though layout is unchanged. A
    // card measured mid-animation therefore looks ~10px too tall and gets shrunk
    // for nothing. Leave it at full size and measure once it has settled.
    if (el.classList.contains('is-entering')) return;

    const overflows = () => inner.scrollHeight > inner.clientHeight + 1;

    // Both the picture and the words matter, so neither gets sacrificed. Trim
    // each a little, alternately, rather than gutting one to save the other.
    let sfit = 1;
    let fit = 1;
    while (overflows() && (sfit > 0.7 || fit > 0.72)) {
      if (sfit > 0.7) {
        sfit -= 0.05;
        inner.style.setProperty('--sfit', sfit.toFixed(2));
      }
      if (overflows() && fit > 0.72) {
        fit -= 0.04;
        inner.style.setProperty('--fit', fit.toFixed(2));
      }
    }

    // Stepping both down together overshoots, so hand back whatever was not
    // actually needed — type first, since readability outranks picture size.
    const relax = (name, value, step, cap) => {
      let v = value;
      while (v < cap) {
        const next = Math.min(cap, +(v + step).toFixed(2));
        inner.style.setProperty(name, String(next));
        if (overflows()) {
          inner.style.setProperty(name, String(v));
          break;
        }
        v = next;
      }
      return v;
    };
    fit = relax('--fit', fit, 0.02, 1);
    sfit = relax('--sfit', sfit, 0.05, 1);

    // If it still does not fit, the card scrolls — `justify-content: safe center`
    // means that clips neither end, which is what used to cut the tag off.
  };

  const fitAll = () => cardEls.forEach(fitText);

  let enterTimer = null;
  const animateCard = (i) => {
    cardEls.forEach((el, n) => {
      el.classList.toggle('is-live', n === i);
      if (n !== i) el.classList.remove('is-entering');
    });
    const el = cardEls[i];
    if (!el) return;

    // replay the entrance, then hand back to the plain visible state. The
    // timeout is what guarantees the card cannot stay stuck mid-animation.
    clearTimeout(enterTimer);
    el.classList.remove('is-entering');
    void el.offsetWidth; // restart the animations
    el.classList.add('is-entering');
    enterTimer = setTimeout(() => {
      el.classList.remove('is-entering');
      fitText(el); // now that the transforms are gone, the measurement is honest
    }, 1250);

    fitText(el);
    setTimeout(() => fitText(el), 1400); // belt and braces once it has settled
    const punch = el.querySelector('.short-punch');
    if (punch) setTimeout(() => countUp(punch), 420);
    startScene(i);
  };

  /* ------------------------------------------------------- scene animation */

  let sceneTimer = null;
  let sceneRun = 0; // only the newest loop is allowed to paint
  const startScene = (i) => {
    clearTimeout(sceneTimer);
    const run = ++sceneRun;
    const canvas = cardEls[i]?.querySelector('.short-scene');
    const scene = cards[i]?.scene;
    if (!canvas || !scene) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = canvas.getContext('2d');
    const started = performance.now();

    const tick = () => {
      if (run !== sceneRun || !canvas.isConnected) return;
      if (!cardEls[i].classList.contains('is-live')) return;

      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) {
        // the pane is hidden or mid-layout — keep waiting instead of giving up,
        // otherwise the canvas is stranded on its first frame, which is blank by
        // design because every element still has zero opacity at t=0
        sceneTimer = setTimeout(tick, 150);
        return;
      }

      const w = Math.round(r.width * dpr);
      const h = Math.round(r.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const t = (performance.now() - started) / 1000;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      drawScene(ctx, scene, r.width, r.height, t);
      sceneTimer = setTimeout(tick, 40); // a timer, not rAF — survives throttling
    };
    tick();
  };

  /* ------------------------------------------------------- layout watch */

  // A one-shot measurement is not enough: a backgrounded or not-yet-laid-out
  // pane reports a zero viewport, which pins the stage at its minimum height and
  // starves the scene canvas. Watching the container recovers as soon as real
  // dimensions exist, and re-paints the scene at the new size.
  if (state.shortsRO) state.shortsRO.disconnect();
  const refit = () => {
    if (!window.innerHeight) return;
    const before = stage.style.height;
    fitStage();
    // Only re-fit the type when the box really moved. Keying this off
    // window.innerHeight missed layout changes that keep the window the same
    // size — hiding the app chrome, for one.
    if (stage.style.height !== before) fitAll();
  };
  state.shortsRO = new ResizeObserver(refit);
  state.shortsRO.observe(document.getElementById('main'));

  // The observer alone is not enough: the viewport can change without #main's
  // own box changing, which left the stage pinned at its minimum height.
  if (state.shortsWinResize) window.removeEventListener('resize', state.shortsWinResize);
  state.shortsWinResize = refit;
  window.addEventListener('resize', state.shortsWinResize);

  if (state.shortsVis) document.removeEventListener('visibilitychange', state.shortsVis);
  state.shortsVis = () => {
    if (document.visibilityState !== 'visible') return;
    refit();
    // the animation timeline was frozen while hidden — settle the card visibly
    cardEls[current]?.classList.remove('is-entering');
    if (!sceneTimer) startScene(current); // only if the loop actually died
  };
  document.addEventListener('visibilitychange', state.shortsVis);

  /* --------------------------------------------------------- narration */

  let audioEl = null;
  const speak = (i, onEnd) => {
    if (!voice) return onEnd?.();

    // recorded narration if we have it, browser speech otherwise
    const clip = clips[i];
    if (clip?.url) {
      stopSpeech();
      audioEl = new Audio(clip.url);
      audioEl.onended = () => onEnd?.();
      audioEl.onerror = () => onEnd?.();
      audioEl.play().catch(() => onEnd?.());
      return;
    }
    if (!window.speechSynthesis) return onEnd?.();
    const c = cards[i];
    const u = new SpeechSynthesisUtterance(`${c.headline}. ${c.body}`);
    u.lang = lang.voice || 'en-US';
    // use a voice that actually speaks this language when the system has one
    const match = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang === u.lang) ??
      window.speechSynthesis.getVoices().find((v) => v.lang?.startsWith(lang.code));
    if (match) u.voice = match;
    u.rate = 1.04;
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  const stopSpeech = () => {
    window.speechSynthesis?.cancel();
    if (audioEl) {
      audioEl.pause();
      audioEl.onended = null;
      audioEl = null;
    }
  };

  /* ------------------------------------------------------ progress bars */

  const paintBars = (i, animate) => {
    bars.forEach((bar, n) => {
      const fill = bar.querySelector('b');
      bar.classList.toggle('is-past', n < i);
      fill.style.transition = 'none';
      fill.style.width = n < i ? '100%' : '0%';
    });
    if (!animate) {
      bars[i].querySelector('b').style.width = '100%';
      return;
    }
    const fill = bars[i].querySelector('b');
    // force a reflow so the transition actually runs from 0
    void fill.offsetWidth;
    fill.style.transition = `width ${durOf(cards[i], i)}ms linear`;
    fill.style.width = '100%';
  };

  /* --------------------------------------------------------- navigation */

  const show = (i, { autoplay = playing } = {}) => {
    current = Math.max(0, Math.min(cards.length - 1, i));
    state.shortsCard = current;
    rememberSession();
    const top = current * stage.clientHeight;
    stage.scrollTo({ top, behavior: 'smooth' });
    // smooth scrolling is dropped under reduced-motion and in background tabs
    setTimeout(() => {
      if (Math.abs(stage.scrollTop - top) > 4) stage.scrollTop = top;
    }, 400);

    animateCard(current);
    paintBars(current, autoplay);
    if (autoplay) schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    const advance = () => {
      if (!playing) return;
      if (current >= cards.length - 1) return pause(true);
      show(current + 1);
    };
    if (voice) {
      speak(current, advance);
      // a safety net in case the speech engine never fires onend
      timer = setTimeout(advance, durOf(cards[current], current) + 9000);
    } else {
      timer = setTimeout(advance, durOf(cards[current], current));
    }
  };

  const play = () => {
    playing = true;
    $('#shortsPlay').textContent = '❚❚';
    cardEls[current]?.querySelector('.short-paused')?.setAttribute('hidden', '');
    paintBars(current, true);
    schedule();
  };

  const pause = (finished = false) => {
    playing = false;
    clearTimeout(timer);
    stopSpeech();
    $('#shortsPlay').textContent = finished && current >= cards.length - 1 ? '↺' : '▶';
    const fill = bars[current].querySelector('b');
    const w = getComputedStyle(fill).width;
    fill.style.transition = 'none';
    fill.style.width = w;
    if (!finished) cardEls[current]?.querySelector('.short-paused')?.removeAttribute('hidden');
  };

  const toggle = () => {
    if (playing) return pause();
    if (current >= cards.length - 1 && $('#shortsPlay').textContent === '↺') {
      show(0, { autoplay: false });
    }
    play();
  };

  /* ------------------------------------------------------------ wiring */

  stage.addEventListener('scroll', () => {
    const i = Math.round(stage.scrollTop / stage.clientHeight);
    if (i !== current && !playing) {
      current = i;
      animateCard(i);
      paintBars(i, false);
    }
  });

  $$('.zone-prev').forEach((z) => z.addEventListener('click', () => { pause(); show(current - 1, { autoplay: false }); }));
  $$('.zone-next').forEach((z) => z.addEventListener('click', () => { pause(); show(current + 1, { autoplay: false }); }));
  $$('.zone-pause').forEach((z) => z.addEventListener('click', toggle));

  $('#shortsPrev').addEventListener('click', () => { const wasPlaying = playing; pause(); show(current - 1, { autoplay: false }); if (wasPlaying) play(); });
  $('#shortsNext').addEventListener('click', () => { const wasPlaying = playing; pause(); show(current + 1, { autoplay: false }); if (wasPlaying) play(); });
  $('#shortsPlay').addEventListener('click', toggle);

  $('#shortsVoice').addEventListener('click', async () => {
    if (!voice && state.boot.narration?.available && !clips.length) {
      // no recorded narration for this language yet — make it
      const wasPlaying = playing;
      pause();
      await ensureNarration(id, state.shortsLang || 'en', { keepIndex: current, wasPlaying });
      return;
    }
    if (!voice && !window.speechSynthesis && !clips.length) {
      return toast('No voice available in this browser.', 'error');
    }
    voice = !voice;
    state.shortsVoice = voice;
    $('#shortsVoice').textContent = voice ? '🔊 Voice on' : '🔊 Voice off';
    $('#shortsVoice').classList.toggle('is-on', voice);
    stopSpeech();
    if (playing) schedule();
  });

  // switching language keeps your place in the reel and keeps it playing
  $('#shortsLang').addEventListener('change', (e) => {
    const wasPlaying = playing;
    pause();
    switchShortsLanguage(id, e.target.value, { keepIndex: current, wasPlaying });
  });

  $('#shortsRegen').addEventListener('click', () => {
    if (confirm('Rebuild the shorts feed from the paper?')) {
      pause();
      startShorts(id);
    }
  });

  $('#shortsSave').addEventListener('click', () => {
    pause();
    recordShortsVideo(cards, id, clips);
  });

  const inTheatre = () => document.body.classList.contains('reel-theatre');
  const setTheatre = (on) => {
    document.body.classList.toggle('reel-theatre', on);
    $('#shortsFull').hidden = on;
    // Let the new layout land before measuring against it — a timer, not
    // requestAnimationFrame, which never fires while the tab is hidden. Measured
    // twice: once the class has applied, again once fonts and reflow settle.
    setTimeout(() => {
      fitStage();
      fitAll();
    }, 50);
    setTimeout(() => {
      fitStage();
      fitAll();
    }, 700);
  };
  $('#shortsFull').addEventListener('click', () => setTheatre(true));
  $('#shortsExit').addEventListener('click', () => setTheatre(false));

  if (state.shortsKeyHandler) document.removeEventListener('keydown', state.shortsKeyHandler);
  state.shortsKeyHandler = (e) => {
    if (state.view !== 'shorts' || state.activeTab !== id || !document.getElementById('shortsStage')) return;
    if (e.target?.matches?.('input, textarea')) return; // target is not always an element
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      setTheatre(!inTheatre());
    } else if (e.key === 'Escape' && inTheatre()) {
      e.preventDefault();
      setTheatre(false);
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (['ArrowDown', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      pause();
      show(current + 1, { autoplay: false });
    } else if (['ArrowUp', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      pause();
      show(current - 1, { autoplay: false });
    }
  };
  document.addEventListener('keydown', state.shortsKeyHandler);

  // stop the reel when the user navigates away from this view
  if (state.shortsStop) state.shortsStop();
  state.shortsStop = () => {
    document.body.classList.remove('reel-theatre');
    clearTimeout(timer);
    stopSpeech();
    playing = false;
  };

  if (meta.translation?.status === 'running') {
    $('#shortsLangState').textContent = `Translating into ${lang.native}… `;
  }

  // resume where the viewer was when the language changed under them
  const startAt = Math.min(cards.length - 1, resume?.index ?? 0);
  fitAll();
  show(startAt, { autoplay: false });
  $('#shorts').focus({ preventScroll: true });
  if (!resume || resume.playing) play(); // it is a reel — it plays
}

/* ────────────────────────── video file export ─────────────────────────── */

const VFONT = '-apple-system, "Helvetica Neue", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Arabic", "Hiragino Sans", "PingFang SC", "Apple SD Gothic Neo", sans-serif';

const CARD_BG = {
  hook: ['#2a1230', '#0b0c11'],
  problem: ['#2b1520', '#0b0c11'],
  idea: ['#1a1830', '#0b0c11'],
  number: ['#0e2430', '#0b0c11'],
  analogy: ['#10281f', '#0b0c11'],
  catch: ['#2c2410', '#0b0c11'],
  payoff: ['#151a35', '#0b0c11'],
};

function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Paints the reel onto a canvas frame by frame and captures it with
 * MediaRecorder, producing a real vertical video file (1080x1920).
 */
async function recordShortsVideo(cards, id, clips = []) {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    return toast('This browser cannot record video. Chrome or Edge can.', 'error');
  }

  const W = 1080;
  const H = 1920;
  const FPS = 30;
  const durations = cards.map((c, i) => cardDuration(c, clips[i]));
  const total = durations.reduce((a, b) => a + b, 0);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // MP4 first — it is what phones, WhatsApp and the social apps actually accept
  const mime = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) return toast('No supported video encoder in this browser.', 'error');
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

  const stream = canvas.captureStream(FPS);

  // Mix the recorded narration into the file. Each clip is decoded and scheduled
  // at the moment its card appears, on a stream the recorder can capture.
  let audioCtx = null;
  const withAudio = clips.length === cards.length && clips.every((c) => c?.url);
  if (withAudio) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      const buffers = await Promise.all(
        clips.map((c) => fetch(c.url).then((r) => r.arrayBuffer()).then((b) => audioCtx.decodeAudioData(b)))
      );
      const startAt = audioCtx.currentTime + 0.25;
      let offset = 0;
      buffers.forEach((buf, i) => {
        const src = audioCtx.createBufferSource();
        src.buffer = buf;
        const gain = audioCtx.createGain();
        gain.gain.value = 1;
        src.connect(gain).connect(dest);
        src.start(startAt + offset / 1000);
        offset += durations[i];
      });
      dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    } catch (err) {
      audioCtx?.close?.();
      audioCtx = null;
      toast(`Recording without audio: ${err.message}`, 'error');
    }
  }

  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const btn = $('#shortsSave');
  const hint = $('#shortsHint');
  const originalHint = hint.textContent;
  btn.disabled = true;

  const done = new Promise((resolve) => (rec.onstop = resolve));
  rec.start();

  const startedAt = performance.now();

  const drawFrame = (elapsed) => {
    // which card are we on
    let i = 0;
    let acc = 0;
    while (i < cards.length - 1 && elapsed >= acc + durations[i]) {
      acc += durations[i];
      i++;
    }
    const c = cards[i];
    const local = elapsed - acc;
    const inT = Math.min(1, local / 420);
    const ease = 1 - Math.pow(1 - inT, 3);

    // background
    const [c1, c2] = CARD_BG[c.kind] ?? CARD_BG.idea;
    const g = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.95);
    g.addColorStop(0, c1);
    g.addColorStop(0.62, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W / 2, H * 0.92, 0, W / 2, H * 0.92, W * 0.75);
    glow.addColorStop(0, 'rgba(124,92,255,0.18)');
    glow.addColorStop(1, 'rgba(124,92,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // progress bars
    const barW = (W - 120 - (cards.length - 1) * 8) / cards.length;
    cards.forEach((_, n) => {
      const x = 60 + n * (barW + 8);
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(x, 70, barW, 6);
      const frac = n < i ? 1 : n === i ? Math.min(1, local / durations[i]) : 0;
      if (frac > 0) {
        ctx.fillStyle = '#7c5cff';
        ctx.fillRect(x, 70, barW * frac, 6);
      }
    });

    ctx.save();
    ctx.globalAlpha = ease;
    ctx.translate(0, (1 - ease) * 26);
    ctx.textAlign = 'center';

    let y = 470;

    // emoji
    ctx.font = '96px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.fillText(c.emoji || '✦', W / 2, y);
    y += 78;

    // tag pill
    const tag = (KIND_TAG[c.kind] ?? c.kind).toUpperCase();
    ctx.font = `600 30px ${VFONT}`;
    const tw = ctx.measureText(tag).width;
    ctx.fillStyle = 'rgba(34,211,238,.12)';
    const pillW = tw + 56;
    ctx.beginPath();
    ctx.roundRect(W / 2 - pillW / 2, y - 34, pillW, 52, 26);
    ctx.fill();
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(tag, W / 2, y + 2);
    y += 110;

    // the animated scene, between the tag and the headline
    if (c.scene) {
      const sceneH = H * 0.26;
      ctx.save();
      ctx.translate(60, y - 20);
      drawScene(ctx, c.scene, W - 120, sceneH, local / 1000);
      ctx.restore();
      y += sceneH + 40;
    }

    // headline
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 76px ${VFONT}`;
    const hl = wrapText(ctx, c.headline, W - 200);
    for (const line of hl) {
      ctx.fillText(line, W / 2, y);
      y += 92;
    }
    y += 24;

    // punch
    if (c.punch) {
      ctx.font = `800 96px ${VFONT}`;
      const pg = ctx.createLinearGradient(W * 0.2, 0, W * 0.8, 0);
      pg.addColorStop(0, '#8f74ff');
      pg.addColorStop(1, '#22d3ee');
      ctx.fillStyle = pg;
      ctx.fillText(c.punch, W / 2, y + 40);
      y += 150;
    }

    // body
    ctx.fillStyle = '#c3c7d1';
    ctx.font = `400 42px ${VFONT}`;
    const bodyLines = wrapText(ctx, c.body, W - 220);
    for (const line of bodyLines) {
      ctx.fillText(line, W / 2, y);
      y += 60;
    }

    ctx.restore();

    // footer counter
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.32)';
    ctx.font = '400 30px ui-monospace, monospace';
    ctx.fillText(`${i + 1} / ${cards.length}`, W / 2, H - 90);

    return i;
  };

  // A timer drives the loop rather than requestAnimationFrame, which stalls
  // completely when the tab is not being painted — that would hang the recording.
  await new Promise((resolve) => {
    const loop = () => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= total) {
        drawFrame(total - 1);
        return resolve();
      }
      const i = drawFrame(elapsed);
      const left = Math.ceil((total - elapsed) / 1000);
      hint.textContent = `● Recording… ${Math.round((elapsed / total) * 100)}% · card ${i + 1}/${cards.length} · ${left}s left · keep this tab in front`;
      setTimeout(loop, 1000 / FPS);
    };
    loop();
  });

  rec.stop();
  await done;
  audioCtx?.close?.();

  const blob = new Blob(chunks, { type: mime });
  const base = ($('.report-head h1')?.textContent ?? 'shorts').replace(/[^\w.-]+/g, '-').slice(0, 60);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}-shorts-${state.shortsLang || 'en'}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  hint.textContent = originalHint;
  btn.disabled = false;
  toast(`Video saved — ${(blob.size / 1024 / 1024).toFixed(1)} MB, ${Math.round(total / 1000)}s.`, 'ok');
}

async function loadOriginal(id) {
  const root = $('#viewRoot');
  if (!root) return;
  try {
    const data = await api(`/api/researches/${id}/source`);
    if (state.activeTab !== id) return;
    root.innerHTML = `
      <div class="original">
        <div class="original-head">
          <div>
            <div class="original-title">${esc(data.title)}</div>
            <div class="original-meta">${Number(data.chars).toLocaleString()} characters of extracted text · exactly what the model was given</div>
          </div>
          <input class="search original-find" id="origFind" type="search" placeholder="Find in document…" />
        </div>
        <pre class="original-text" id="origText">${esc(data.text)}</pre>
      </div>`;

    // simple in-document find that scrolls to the first hit
    $('#origFind').addEventListener('input', (e) => {
      const q = e.target.value;
      const pre = $('#origText');
      if (!q || q.length < 2) {
        pre.innerHTML = esc(data.text);
        return;
      }
      const rx = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      pre.innerHTML = esc(data.text).replace(rx, '<mark>$1</mark>');
      pre.querySelector('mark')?.scrollIntoView({ block: 'center' });
    });
  } catch (err) {
    root.innerHTML = `<div class="error-card"><b>No original available</b>${esc(err.message)}</div>`;
  }
}

function progressCard(r) {
  const live = isLive(r.status);
  return `
    <div class="progress-card">
      <div class="progress-top">
        <div class="progress-stage">
          ${live ? '<span class="spinner"></span>' : ''}
          <span id="stageText">${esc(r.stage || r.status)}</span>
        </div>
        <div class="progress-pct" id="pct">${r.progress}%</div>
      </div>
      <div class="bar"><i id="bar" style="width:${r.progress}%"></i></div>
      <div class="log" id="log"></div>
    </div>`;
}

function sectionHtml(s, diagrams, glossary) {
  const head = `
    <div class="section-head">
      <div class="section-icon">${esc(s.icon)}</div>
      <h2>${esc(s.heading)}</h2>
    </div>`;

  if (s.key === 'architecture') {
    const dia = diagrams
      .map(
        (d, i) => `
        <figure class="diagram">
          <div class="diagram-head">
            <div class="diagram-title">${esc(d.title)}</div>
            <button class="btn btn-tiny" data-toggle-src="${i}">source</button>
          </div>
          <div class="diagram-body" id="mm-${d.id}" data-code="${esc(d.code)}">
            <div class="skeleton" style="width:100%"><i></i><i></i><i></i></div>
          </div>
          <div class="diagram-src"><pre>${esc(d.code)}</pre></div>
          ${d.caption ? `<figcaption class="diagram-cap">${esc(d.caption)}</figcaption>` : ''}
        </figure>`
      )
      .join('');
    return `<section class="section" id="sec-${s.key}">${head}<div class="prose">${md(s.content)}</div>${dia}</section>`;
  }

  if (s.key === 'glossary') {
    const cards = glossary
      .map((g) => `<div class="gloss"><dt>${esc(g.term)}</dt><dd>${esc(g.plain)}</dd></div>`)
      .join('');
    return `<section class="section" id="sec-${s.key}">${head}${
      s.content ? `<div class="prose">${md(s.content)}</div>` : ''
    }<div class="glossary-grid">${cards || '<p class="hint">No terms produced.</p>'}</div></section>`;
  }

  const body = s.content
    ? `<div class="prose">${md(s.content)}</div>`
    : '<div class="skeleton"><i></i><i></i><i></i></div>';
  return `<section class="section" id="sec-${s.key}">${head}${body}</section>`;
}

async function renderDiagrams() {
  for (const node of $$('.diagram-body[data-code]')) {
    const code = node.dataset.code;
    try {
      const { svg } = await mermaid.render(`m${node.id}-${Math.random().toString(36).slice(2, 8)}`, code);
      node.innerHTML = svg;
    } catch (err) {
      node.innerHTML = `<div class="diagram-fallback">This diagram could not be drawn (${esc(
        (err?.message || 'parse error').split('\n')[0]
      )}). The source is below.</div>`;
      node.closest('.diagram')?.classList.add('show-src');
    }
    node.removeAttribute('data-code');
  }
  $$('[data-toggle-src]').forEach((btn) =>
    btn.addEventListener('click', () => btn.closest('.diagram').classList.toggle('show-src'))
  );
}

/* ═════════════════════════════ simulators ════════════════════════════ */

const fmtNum = (n) => {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return Math.round(n).toLocaleString();
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(2);
  if (a === 0) return '0';
  if (a < 0.001) return n.toExponential(2);
  return n.toFixed(3);
};

function simulationHtml(sim) {
  return `
    <section class="sim" data-sim="${sim.id}">
      <div class="sim-head">
        <span class="sim-badge">Try it</span>
        <h3>${esc(sim.title)}</h3>
      </div>
      ${sim.blurb ? `<p class="sim-blurb">${esc(sim.blurb)}</p>` : ''}
      <div class="sim-body">
        <div class="sim-controls">
          ${sim.vars
            .map(
              (v) => `
            <label class="sim-var" data-key="${esc(v.key)}">
              <span class="sim-var-top">
                <span class="sim-var-label">${esc(v.label ?? v.key)}</span>
                <output class="sim-var-value">${fmtNum(Number(v.value))}${
                  v.unit ? ` <i>${esc(v.unit)}</i>` : ''
                }</output>
              </span>
              <input type="range" min="${Number(v.min)}" max="${Number(v.max)}"
                     step="${Number(v.step) > 0 ? Number(v.step) : 'any'}"
                     value="${Number(v.value)}" data-key="${esc(v.key)}" />
            </label>`
            )
            .join('')}
        </div>
        <div class="sim-out">
          <div class="sim-out-label">${esc(sim.output_label)}</div>
          <div class="sim-out-value" data-out>—</div>
          ${sim.output_unit ? `<div class="sim-out-unit">${esc(sim.output_unit)}</div>` : ''}
          <canvas class="sim-curve" data-curve></canvas>
          <div class="sim-curve-x" data-curve-x></div>
        </div>
      </div>
      ${sim.insight ? `<p class="sim-insight">💡 ${esc(sim.insight)}</p>` : ''}
      <p class="sim-formula"><code>${esc(sim.output_label)} = ${esc(sim.expression)}</code></p>
    </section>`;
}

/** Wire every simulator on the page: live value, live curve, reset-free. */
function wireSimulations(sims) {
  for (const sim of sims) {
    const root = $(`.sim[data-sim="${sim.id}"]`);
    if (!root) continue;

    const compiled = compile(sim.expression);
    if (!compiled.ok) {
      root.querySelector('[data-out]').textContent = 'unavailable';
      root.classList.add('is-broken');
      continue;
    }

    const values = Object.fromEntries(sim.vars.map((v) => [v.key, Number(v.value)]));
    const out = root.querySelector('[data-out]');
    const canvas = root.querySelector('[data-curve]');
    const xLabel = root.querySelector('[data-curve-x]');
    // sweep the widest-range variable — that is the one worth plotting against
    const sweep = [...sim.vars].sort(
      (a, b) => Number(b.max) - Number(b.min) - (Number(a.max) - Number(a.min))
    )[0];
    xLabel.textContent = `${sweep.label ?? sweep.key} →`;

    const draw = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);

      const N = 80;
      const lo = Number(sweep.min);
      const hi = Number(sweep.max);
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const x = lo + ((hi - lo) * i) / N;
        let y;
        try {
          y = compiled.eval({ ...values, [sweep.key]: x });
        } catch {
          y = NaN;
        }
        pts.push([x, y]);
      }
      const ys = pts.map((p) => p[1]).filter(Number.isFinite);
      if (!ys.length) return;
      const yMin = Math.min(0, ...ys);
      const yMax = Math.max(...ys);
      const span = yMax - yMin || 1;

      const px = (x) => ((x - lo) / (hi - lo || 1)) * r.width;
      const py = (y) => r.height - 6 - ((y - yMin) / span) * (r.height - 14);

      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        if (!Number.isFinite(y)) return;
        const X = px(x);
        const Y = py(y);
        i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
      });
      const g = ctx.createLinearGradient(0, 0, r.width, 0);
      g.addColorStop(0, '#7c5cff');
      g.addColorStop(1, '#22d3ee');
      ctx.strokeStyle = g;
      ctx.lineWidth = 2;
      ctx.stroke();

      // where the reader currently is
      const cx = px(values[sweep.key]);
      let cy;
      try {
        cy = py(compiled.eval(values));
      } catch {
        cy = null;
      }
      if (cy != null && Number.isFinite(cy)) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#22d3ee';
        ctx.fill();
        ctx.strokeStyle = 'rgba(34,211,238,.3)';
        ctx.lineWidth = 6;
        ctx.stroke();
      }
    };

    const recompute = () => {
      let v;
      try {
        v = compiled.eval(values);
      } catch {
        v = NaN;
      }
      out.textContent = fmtNum(v);
      draw();
    };

    root.querySelectorAll('input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        values[key] = Number(input.value);
        const spec = sim.vars.find((x) => x.key === key);
        const box = root.querySelector(`.sim-var[data-key="${CSS.escape(key)}"] .sim-var-value`);
        box.innerHTML = `${fmtNum(values[key])}${spec?.unit ? ` <i>${esc(spec.unit)}</i>` : ''}`;
        recompute();
      });
    });

    recompute();
    // the curve needs a real width, which it may not have on first paint
    setTimeout(draw, 120);
  }
}

/* ═════════════════════════════ 3D scenes ═════════════════════════════ */

function scene3dHtml(sc) {
  return `
    <section class="scene3d" data-scene3d="${sc.id}">
      <div class="sim-head">
        <span class="sim-badge scene3d-badge">3D · drag to rotate</span>
        <h3>${esc(sc.title)}</h3>
      </div>
      ${sc.blurb ? `<p class="sim-blurb">${esc(sc.blurb)}</p>` : ''}
      <div class="scene3d-stage" data-stage></div>
      ${
        sc.vars.length
          ? `<div class="sim-controls scene3d-controls">
              ${sc.vars
                .map(
                  (v) => `
                <label class="sim-var" data-key="${esc(v.key)}">
                  <span class="sim-var-top">
                    <span class="sim-var-label">${esc(v.label ?? v.key)}</span>
                    <output class="sim-var-value">${fmtNum(Number(v.value))}${
                      v.unit ? ` <i>${esc(v.unit)}</i>` : ''
                    }</output>
                  </span>
                  <input type="range" min="${Number(v.min)}" max="${Number(v.max)}"
                         step="${Number(v.step) > 0 ? Number(v.step) : 'any'}"
                         value="${Number(v.value)}" data-key="${esc(v.key)}" />
                </label>`
                )
                .join('')}
            </div>`
          : ''
      }
      ${sc.insight ? `<p class="sim-insight">💡 ${esc(sc.insight)}</p>` : ''}
    </section>`;
}

/** Three.js is ~600KB, so it is only fetched when a report actually has a 3D scene. */
async function wireScenes3d(scenes) {
  if (!scenes?.length) return;

  let mount3D;
  try {
    ({ mount3D } = await import('/three-scenes.js'));
  } catch (err) {
    scenes.forEach((sc) => {
      const el = $(`.scene3d[data-scene3d="${sc.id}"] [data-stage]`);
      if (el) el.innerHTML = `<div class="scene3d-fail">3D could not load: ${esc(err.message)}</div>`;
    });
    return;
  }

  // tear down any scenes left running from a previous render
  (state.scene3dHandles ?? []).forEach((h) => h?.dispose?.());
  state.scene3dHandles = [];

  for (const sc of scenes) {
    const root = $(`.scene3d[data-scene3d="${sc.id}"]`);
    const stage = root?.querySelector('[data-stage]');
    if (!stage) continue;

    const values = Object.fromEntries(sc.vars.map((v) => [v.key, Number(v.value)]));
    let handle = null;
    try {
      handle = mount3D(stage, { ...sc.spec, kind: sc.kind }, values);
    } catch (err) {
      stage.innerHTML = `<div class="scene3d-fail">This scene could not be built: ${esc(err.message)}</div>`;
      continue;
    }
    if (!handle) {
      stage.innerHTML = `<div class="scene3d-fail">Unsupported scene type.</div>`;
      continue;
    }
    state.scene3dHandles.push(handle);

    root.querySelectorAll('input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.key;
        values[key] = Number(input.value);
        const spec = sc.vars.find((x) => x.key === key);
        root.querySelector(`.sim-var[data-key="${CSS.escape(key)}"] .sim-var-value`).innerHTML =
          `${fmtNum(values[key])}${spec?.unit ? ` <i>${esc(spec.unit)}</i>` : ''}`;
        handle.update({ ...values });
      });
    });
  }
}

function wrapTables() {
  $$('.prose table').forEach((t) => {
    if (t.parentElement.classList.contains('table-scroll')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    t.replaceWith(wrap);
    wrap.append(t);
  });
}

/* ═══════════════════════════ source wizard ═══════════════════════════ */

const openModal = (id) => ($(id).hidden = false);
const closeModal = (id) => ($(id).hidden = true);

function openSourceWizard() {
  state.wizard = {
    step: 1,
    source: 'url',
    file: null,
    templateId: state.boot?.templates?.[0]?.id ?? null,
  };
  $('#nameInput').value = '';
  $('#urlInput').value = '';
  $('#textInput').value = '';
  $('#fileInput').value = '';
  $('#dzFile').hidden = true;
  $('#newModalError').textContent = '';
  syncWizard();
  renderTemplatePicker();
  openModal('#newModal');
}

function syncWizard() {
  const { step } = state.wizard;
  $$('.wizard-step').forEach((el) => el.classList.toggle('is-active', Number(el.dataset.step) === step));
  $$('.rail-step').forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('is-active', n === step);
    el.classList.toggle('is-done', n < step);
  });
  $('#backBtn').hidden = step === 1;
  $('#nextBtn').textContent = step === 3 ? 'Generate report' : 'Continue';
  $('#newModalError').textContent = '';
  if (step === 1) setTimeout(() => $('#nameInput').focus(), 60);
  if (step === 2 && state.wizard.source === 'url') setTimeout(() => $('#urlInput').focus(), 60);
}

function renderTemplatePicker() {
  const grid = $('#templatePicker');
  grid.innerHTML = (state.boot?.templates ?? [])
    .map(
      (t) => `
      <button class="tpl-card ${t.id === state.wizard.templateId ? 'is-selected' : ''}" data-tpl="${t.id}">
        <div class="tpl-name">${esc(t.name)} ${t.is_builtin ? '<span class="badge">built-in</span>' : ''}</div>
        <div class="tpl-desc">${esc(t.description)}</div>
        <div class="tpl-meta">${t.sections.length} sections · for ${esc(
          state.boot.audiences.find((a) => a.key === t.audience)?.label ?? t.audience
        )}</div>
      </button>`
    )
    .join('');
  $$('.tpl-card', grid).forEach((el) =>
    el.addEventListener('click', () => {
      state.wizard.templateId = Number(el.dataset.tpl);
      renderTemplatePicker();
    })
  );
}

function validateStep() {
  const w = state.wizard;
  if (w.step === 1) return $('#nameInput').value.trim() ? null : 'Give this tab a name first.';
  if (w.step === 2) {
    if (w.source === 'url' && !$('#urlInput').value.trim()) return 'Paste a URL, or switch to a file.';
    if (w.source === 'file' && !w.file) return 'Choose a file to upload.';
    if (w.source === 'text' && $('#textInput').value.trim().length < 300)
      return 'Paste at least a few paragraphs (300+ characters).';
    return null;
  }
  if (w.step === 3 && !w.templateId) return 'Pick a template.';
  return null;
}

async function submitWizard() {
  const w = state.wizard;
  const fd = new FormData();
  fd.append('name', $('#nameInput').value.trim());
  fd.append('template_id', String(w.templateId ?? ''));
  fd.append('project_id', String(state.projectId ?? ''));

  if (w.source === 'url') {
    fd.append('source_type', 'url');
    fd.append('url', $('#urlInput').value.trim());
  } else if (w.source === 'text') {
    fd.append('source_type', 'text');
    fd.append('text', $('#textInput').value.trim());
  } else {
    const ext = (w.file.name.split('.').pop() || '').toLowerCase();
    fd.append('source_type', ext === 'pdf' ? 'pdf' : ['doc', 'docx'].includes(ext) ? 'doc' : 'file');
    fd.append('file', w.file);
  }

  $('#nextBtn').disabled = true;
  $('#nextBtn').textContent = 'Starting…';
  try {
    const created = await api('/api/researches', { method: 'POST', body: fd });
    closeModal('#newModal');
    await refreshProject();
    await loadProjects();
    selectTab(created.id);
    toast('Added as a tab — this usually takes a few minutes.', 'ok');
  } catch (err) {
    $('#newModalError').textContent = err.message;
  } finally {
    $('#nextBtn').disabled = false;
    $('#nextBtn').textContent = 'Generate report';
  }
}

/* ════════════════════════════ templates UI ═══════════════════════════ */

function renderTemplateList() {
  const list = $('#templateList');
  list.innerHTML = state.boot.templates
    .map(
      (t) => `
      <button class="tpl-row ${t.id === state.editingTemplateId ? 'is-active' : ''}" data-id="${t.id}">
        ${esc(t.name)}
        <small>${t.sections.length} sections${t.is_builtin ? ' · built-in' : ''}</small>
      </button>`
    )
    .join('');
  $$('.tpl-row', list).forEach((el) =>
    el.addEventListener('click', () => loadTemplateIntoForm(Number(el.dataset.id)))
  );
}

function renderSectionChecks(selected = []) {
  $('#sectionChecks').innerHTML = state.boot.sections
    .map(
      (s) => `
      <label class="check">
        <input type="checkbox" value="${s.key}" ${selected.includes(s.key) ? 'checked' : ''} />
        <span>${s.icon} ${esc(s.heading)}</span>
      </label>`
    )
    .join('');
}

function loadTemplateIntoForm(id) {
  const t = state.boot.templates.find((x) => x.id === id);
  state.editingTemplateId = id;
  const form = $('#templateForm');
  form.name.value = t?.name ?? '';
  form.description.value = t?.description ?? '';
  form.audience.value = t?.audience ?? 'basic-tech';
  form.extra_instructions.value = t?.extra_instructions ?? '';
  renderSectionChecks(t?.sections ?? []);
  $('#deleteTemplateBtn').hidden = !t || t.is_builtin;
  $('#saveTemplateBtn').textContent = t?.is_builtin ? 'Save as a copy' : 'Save template';
  renderTemplateList();
}

function newTemplateForm() {
  state.editingTemplateId = null;
  const form = $('#templateForm');
  form.reset();
  form.audience.value = 'junior-dev';
  renderSectionChecks(['tldr', 'problem', 'analogy', 'how', 'architecture', 'math', 'glossary', 'takeaways']);
  $('#deleteTemplateBtn').hidden = true;
  $('#saveTemplateBtn').textContent = 'Create template';
  renderTemplateList();
}

/* ════════════════════════════ settings UI ════════════════════════════ */

function renderProviderCards() {
  const current = $('#providerCards').dataset.value || state.boot.settings.provider;
  $('#providerCards').dataset.value = current;
  $('#providerCards').innerHTML = state.boot.providers
    .map(
      (p) => `
      <button type="button" class="pcard ${p.key === current ? 'is-selected' : ''}" data-provider="${p.key}">
        <b>${esc(p.label)}</b><span>${esc(p.hint)}</span>
      </button>`
    )
    .join('');
  $$('.pcard').forEach((el) =>
    el.addEventListener('click', () => {
      $('#providerCards').dataset.value = el.dataset.provider;
      renderProviderCards();
      syncProviderFields();
    })
  );
}

function syncProviderFields() {
  const current = $('#providerCards').dataset.value;
  $$('[data-provider-field]').forEach((el) => (el.hidden = el.dataset.providerField !== current));
}

function settingsPayload() {
  const p = {
    provider: $('#providerCards').dataset.value,
    claude_model: $('#claudeModel').value.trim(),
    codex_model: $('#codexModel').value.trim(),
    anthropic_model: $('#anthropicModel').value.trim(),
    max_source_chars: $('#maxChars').value,
  };
  const key = $('#anthropicKey').value.trim();
  if (key) p.anthropic_api_key = key;
  return p;
}

function openSettings() {
  const s = state.boot.settings;
  $('#providerCards').dataset.value = s.provider;
  renderProviderCards();
  syncProviderFields();
  $('#claudeModel').value = s.claude_model;
  $('#codexModel').value = s.codex_model;
  $('#anthropicModel').value = s.anthropic_model;
  $('#anthropicKey').value = '';
  $('#anthropicKey').placeholder = s.has_anthropic_key ? '•••••••• (saved)' : 'sk-ant-…';
  $('#maxChars').value = s.max_source_chars;
  $('#dataDirHint').textContent = `Everything is stored in ${state.boot.dataDir}/research.db`;
  $('#testResult').textContent = '';
  $('#testResult').className = 'test-result';
  openModal('#settingsModal');
}

/* ═══════════════════════════════ wiring ══════════════════════════════ */

function wire() {
  $$('.modal-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => {
      if (e.target === bd) bd.hidden = true;
    });
    $$('[data-close]', bd).forEach((b) => b.addEventListener('click', () => (bd.hidden = true)));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop').forEach((bd) => (bd.hidden = true));
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      $('#searchInput').focus();
    }
  });

  /* projects */
  const openNewProject = () => {
    state.editingProjectId = null;
    $('#projectModalTitle').textContent = 'New project';
    $('#saveProjectBtn').textContent = 'Create project';
    $('#projectName').value = '';
    $('#projectGoal').value = '';
    $('#projectModalError').textContent = '';
    openModal('#projectModal');
    setTimeout(() => $('#projectName').focus(), 60);
  };
  $('#newProjectBtn').addEventListener('click', openNewProject);
  $('#emptyNewBtn').addEventListener('click', openNewProject);

  $('#editProjectBtn').addEventListener('click', () => {
    const p = state.project.project;
    state.editingProjectId = p.id;
    $('#projectModalTitle').textContent = 'Edit project';
    $('#saveProjectBtn').textContent = 'Save changes';
    $('#projectName').value = p.name;
    $('#projectGoal').value = p.goal || '';
    $('#projectModalError').textContent = '';
    openModal('#projectModal');
  });

  $('#saveProjectBtn').addEventListener('click', async () => {
    const name = $('#projectName').value.trim();
    const goal = $('#projectGoal').value.trim();
    if (!name) {
      $('#projectModalError').textContent = 'Give the project a name.';
      return;
    }
    try {
      if (state.editingProjectId) {
        await api(`/api/projects/${state.editingProjectId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, goal }),
        });
        closeModal('#projectModal');
        await loadProjects();
        await refreshProject();
        toast('Project updated.', 'ok');
      } else {
        const p = await api('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, goal }),
        });
        closeModal('#projectModal');
        await loadProjects();
        await openProject(p.id);
        toast('Project created — ask the console what to read.', 'ok');
      }
    } catch (err) {
      $('#projectModalError').textContent = err.message;
    }
  });

  $('#deleteProjectBtn').addEventListener('click', async () => {
    const p = state.project.project;
    if (!confirm(`Delete the project “${p.name}” and all ${state.project.tabs.length} of its tabs?`)) return;
    try {
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      closeStream();
      state.projectId = null;
      state.project = null;
      $('#workspace').hidden = true;
      $('#emptyState').hidden = false;
      await loadProjects();
      toast('Project deleted.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* delegated: jump to an existing tab from a console suggestion card */
  $('#wsBody').addEventListener('click', (e) => {
    const target = e.target.closest('[data-goto-tab]');
    if (target) selectTab(Number(target.dataset.gotoTab));
  });

  /* source wizard */
  $('#nextBtn').addEventListener('click', () => {
    const err = validateStep();
    if (err) {
      $('#newModalError').textContent = err;
      return;
    }
    if (state.wizard.step === 3) return submitWizard();
    state.wizard.step++;
    syncWizard();
  });
  $('#backBtn').addEventListener('click', () => {
    state.wizard.step = Math.max(1, state.wizard.step - 1);
    syncWizard();
  });
  $('#newModal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      $('#nextBtn').click();
    }
  });

  $$('#sourceTabs .tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      state.wizard.source = tab.dataset.source;
      $$('#sourceTabs .tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      $$('.source-pane').forEach((p) =>
        p.classList.toggle('is-active', p.dataset.source === tab.dataset.source)
      );
    })
  );

  const dz = $('#dropzone');
  const setFile = (file) => {
    state.wizard.file = file;
    $('#dzFile').hidden = !file;
    $('#dzFile').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '';
    if (file && !$('#nameInput').value.trim()) {
      $('#nameInput').value = file.name.replace(/\.[^.]+$/, '');
    }
  };
  dz.addEventListener('click', () => $('#fileInput').click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') $('#fileInput').click();
  });
  $('#fileInput').addEventListener('change', (e) => setFile(e.target.files[0] ?? null));
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('is-over');
    })
  );
  dz.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0] ?? null));

  /* search */
  $('#searchInput').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderProjectList();
  });

  /* templates */
  $('#templatesBtn').addEventListener('click', () => {
    $('#audienceSelect').innerHTML = state.boot.audiences
      .map((a) => `<option value="${a.key}">${esc(a.label)}</option>`)
      .join('');
    loadTemplateIntoForm(state.boot.templates[0]?.id);
    openModal('#templatesModal');
  });
  $('#newTemplateBtn').addEventListener('click', newTemplateForm);

  $('#templateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const sections = $$('#sectionChecks input:checked').map((i) => i.value);
    const existing = state.boot.templates.find((t) => t.id === state.editingTemplateId);
    const payload = {
      name: form.name.value.trim(),
      description: form.description.value.trim(),
      audience: form.audience.value,
      sections,
      extra_instructions: form.extra_instructions.value.trim(),
    };
    if (!payload.name) return toast('Give the template a name.', 'error');
    if (!sections.length) return toast('Pick at least one section.', 'error');

    try {
      // built-ins are never mutated — saving one forks it into your own copy
      if (existing && !existing.is_builtin) {
        await api(`/api/templates/${existing.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        if (existing?.is_builtin && payload.name === existing.name) payload.name += ' (copy)';
        const created = await api('/api/templates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        state.editingTemplateId = created.id;
      }
      state.boot.templates = await api('/api/templates');
      loadTemplateIntoForm(state.editingTemplateId);
      toast('Template saved.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#deleteTemplateBtn').addEventListener('click', async () => {
    const t = state.boot.templates.find((x) => x.id === state.editingTemplateId);
    if (!t || !confirm(`Delete the template “${t.name}”?`)) return;
    try {
      await api(`/api/templates/${t.id}`, { method: 'DELETE' });
      state.boot.templates = await api('/api/templates');
      newTemplateForm();
      toast('Template deleted.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* settings */
  $('#settingsBtn').addEventListener('click', openSettings);

  $('#saveSettingsBtn').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settingsPayload()),
      });
      state.boot = await api('/api/bootstrap');
      renderProviderBadge();
      closeModal('#settingsModal');
      toast('Settings saved.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#testProviderBtn').addEventListener('click', async () => {
    const btn = $('#testProviderBtn');
    const out = $('#testResult');
    btn.disabled = true;
    out.className = 'test-result';
    out.textContent = 'testing… (a cold CLI start can take 30s)';
    try {
      await api('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settingsPayload()),
      });
      const res = await api('/api/settings/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: $('#providerCards').dataset.value }),
      });
      out.className = `test-result ${res.ok ? 'ok' : 'err'}`;
      out.textContent = res.ok ? `✓ ${res.label} responded in ${(res.ms / 1000).toFixed(1)}s` : `✕ ${res.error}`;
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = `✕ ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

function renderProviderBadge() {
  const p = state.boot.providers.find((x) => x.key === state.boot.settings.provider);
  $('#providerBadge').textContent = p ? p.label.toLowerCase() : state.boot.settings.provider;
}

/* ═══════════════════════════════ start ══════════════════════════════ */

(async function init() {
  try {
    state.boot = await api('/api/bootstrap');
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:monospace;color:#f87171">Could not reach the server: ${esc(
      err.message
    )}</div>`;
    return;
  }
  renderProviderBadge();
  wire();
  state.projects = state.boot.projects ?? [];
  renderProjectList();

  // Reopen exactly where the user left off. Everything generated already lives
  // in SQLite; this restores the view on top of it.
  const last = state.boot.session ?? {};
  const known = state.projects.some((p) => p.id === last.projectId);
  const target = known ? last.projectId : state.projects[0]?.id;

  if (target) {
    if (last.lang) state.shortsLang = last.lang;
    await openProject(target);

    if (known && last.activeTab && last.activeTab !== 'console') {
      const hasTab = state.project?.tabs?.some((t) => t.id === last.activeTab);
      if (hasTab) {
        state.activeTab = last.activeTab;
        state.view = last.view ?? 'explanation';
        state.shortsCard = last.card ?? 0;
        state.shortsResume = { index: state.shortsCard, playing: false };
        renderTabbar();
        renderActiveTab();
      }
    }
  }

  // keep tab status dots and the project list fresh while work runs
  setInterval(async () => {
    await loadProjects();
    if (state.project && state.project.tabs.some((t) => isLive(t.status))) {
      const keepView = state.activeTab;
      state.project = await api(`/api/projects/${state.projectId}`).catch(() => state.project);
      if (state.activeTab === keepView) renderTabbar();
    }
  }, 7000);
})();
