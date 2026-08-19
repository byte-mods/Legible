import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  db,
  getSetting,
  setSetting,
  ALL_SECTIONS,
  UPLOAD_DIR,
  DATA_DIR,
  ensureDefaultProject,
  nextTabOrder,
  touchProject,
} from './db.js';
import { bus, start, cancel, isRunning } from './pipeline.js';
import { askConsole } from './console.js';
import { shortsState, generateShorts, translateShorts } from './shorts.js';
import { narrationState, generateNarration, narrationFile, narrationSupport } from './narrate.js';
import { simulationsFor, scenes3dFor } from './simulations.js';
import { complete, providerLabel, activeProvider, activeModel } from './providers.js';
import { AUDIENCES, LANGUAGES } from './prompts.js';
import { authMiddleware, mountAuthRoutes, ensurePassword, hasPassword } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 4317);

const app = express();
app.use(express.json({ limit: '10mb' }));

/* --------------------------------------------------------------- security */

// Auth is on unless the app is pinned to loopback only. Anything reachable from
// another machine — the LAN, a tunnel — must ask for the password.
const HOST = process.env.HOST ?? '0.0.0.0';
const LOOPBACK_ONLY = HOST === '127.0.0.1' || HOST === 'localhost';
const REQUIRE_AUTH = process.env.DR_AUTH === 'off' ? false : !LOOPBACK_ONLY;
const SECURE_COOKIES = process.env.DR_PUBLIC === '1';

// Cloudflare terminates TLS, so trust its forwarding headers for req.ip/protocol
app.set('trust proxy', true);

app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('x-frame-options', 'DENY');
  next();
});

mountAuthRoutes(app, { requireAuth: REQUIRE_AUTH, secureCookies: SECURE_COOKIES });
app.get('/login', (_req, res) => res.sendFile(path.join(ROOT, 'public/login.html')));
app.use(authMiddleware({ requireAuth: REQUIRE_AUTH }));

/* ------------------------------------------------------------ static files */

app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor/mermaid', express.static(path.join(ROOT, 'node_modules/mermaid/dist')));
app.use('/vendor/marked', express.static(path.join(ROOT, 'node_modules/marked/lib')));
app.use('/vendor/purify', express.static(path.join(ROOT, 'node_modules/dompurify/dist')));
app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules/three/build')));

/* ---------------------------------------------------------------- uploads */

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) =>
      cb(null, `${randomUUID()}${path.extname(file.originalname).slice(0, 12)}`),
  }),
  limits: { fileSize: 80 * 1024 * 1024 },
});

/* ----------------------------------------------------------------- helpers */

const ok = (res, data) => res.json(data);
const fail = (res, code, message) => res.status(code).json({ error: message });

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function getResearch(id) {
  return db.prepare('SELECT * FROM researches WHERE id = ?').get(Number(id));
}

function templateOut(row) {
  let sections = [];
  try {
    sections = JSON.parse(row.sections);
  } catch {
    sections = [];
  }
  return { ...row, sections, is_builtin: !!row.is_builtin };
}

/* --------------------------------------------------------------- bootstrap */

app.get('/api/bootstrap', asyncRoute(async (_req, res) => {
  const templates = db
    .prepare('SELECT * FROM templates ORDER BY is_builtin DESC, id ASC')
    .all()
    .map(templateOut);

  ok(res, {
    templates,
    projects: projectSummary(),
    sections: ALL_SECTIONS,
    languages: LANGUAGES,
    narration: await narrationSupport(),
    audiences: Object.entries(AUDIENCES).map(([key, v]) => ({ key, label: v.label })),
    providers: [
      { key: 'claude', label: 'Claude Code CLI', hint: 'Uses your local `claude` CLI. No API key needed.' },
      { key: 'codex', label: 'Codex CLI', hint: 'Uses your local `codex` CLI. No API key needed.' },
      { key: 'anthropic', label: 'Anthropic API', hint: 'Direct API calls. Needs an API key.' },
    ],
    settings: {
      provider: getSetting('provider', 'claude'),
      claude_model: getSetting('claude_model', ''),
      codex_model: getSetting('codex_model', ''),
      anthropic_model: getSetting('anthropic_model', 'claude-opus-5'),
      has_anthropic_key: !!(getSetting('anthropic_api_key', '') || process.env.ANTHROPIC_API_KEY),
      max_source_chars: getSetting('max_source_chars', '180000'),
    },
    dataDir: DATA_DIR,
    session: (() => {
      try {
        return JSON.parse(getSetting('ui_session', '{}'));
      } catch {
        return {};
      }
    })(),
  });
}));

/* ----------------------------------------------------------------- session */

/**
 * Where the user last was. Kept server-side rather than in localStorage so the
 * app opens in the same place on the laptop and the phone.
 */
app.get('/api/session', (_req, res) => {
  try {
    ok(res, JSON.parse(getSetting('ui_session', '{}')));
  } catch {
    ok(res, {});
  }
});

app.put('/api/session', (req, res) => {
  const b = req.body ?? {};
  const clean = {
    projectId: Number(b.projectId) || null,
    activeTab: b.activeTab === 'console' ? 'console' : Number(b.activeTab) || null,
    view: ['explanation', 'shorts', 'original'].includes(b.view) ? b.view : 'explanation',
    card: Number.isFinite(Number(b.card)) ? Math.max(0, Number(b.card)) : 0,
    lang: String(b.lang ?? 'en').slice(0, 8),
    theatre: !!b.theatre,
    savedAt: new Date().toISOString(),
  };
  setSetting('ui_session', JSON.stringify(clean));
  ok(res, clean);
});

/* ---------------------------------------------------------------- settings */

app.post('/api/settings', (req, res) => {
  const allowed = [
    'provider',
    'claude_model',
    'codex_model',
    'anthropic_model',
    'anthropic_api_key',
    'max_source_chars',
  ];
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (allowed.includes(k)) setSetting(k, v ?? '');
  }
  ok(res, { saved: true });
});

app.post(
  '/api/settings/test',
  asyncRoute(async (req, res) => {
    const provider = req.body?.provider ?? activeProvider();
    const startedAt = Date.now();
    try {
      const { text } = await complete({
        provider,
        prompt: 'Reply with exactly: OK',
        signal: AbortSignal.timeout(120_000),
      });
      ok(res, {
        ok: true,
        provider,
        label: providerLabel(provider),
        model: activeModel(provider),
        ms: Date.now() - startedAt,
        sample: text.slice(0, 120),
      });
    } catch (err) {
      ok(res, { ok: false, provider, label: providerLabel(provider), error: err.message });
    }
  })
);

/* --------------------------------------------------------------- templates */

app.get('/api/templates', (_req, res) => {
  ok(
    res,
    db.prepare('SELECT * FROM templates ORDER BY is_builtin DESC, id ASC').all().map(templateOut)
  );
});

app.post('/api/templates', (req, res) => {
  const { name, description = '', audience = 'basic-tech', sections = [], extra_instructions = '' } =
    req.body ?? {};
  if (!name?.trim()) return fail(res, 400, 'A template name is required.');
  const valid = sections.filter((s) => ALL_SECTIONS.some((x) => x.key === s));
  if (!valid.length) return fail(res, 400, 'Pick at least one section.');

  const info = db
    .prepare(
      `INSERT INTO templates (name, description, audience, sections, extra_instructions, is_builtin)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(name.trim(), description, audience, JSON.stringify(valid), extra_instructions);

  ok(res, templateOut(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid)));
});

app.put('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  if (!row) return fail(res, 404, 'Template not found.');
  const { name, description, audience, sections, extra_instructions } = req.body ?? {};
  const valid = Array.isArray(sections)
    ? sections.filter((s) => ALL_SECTIONS.some((x) => x.key === s))
    : null;

  db.prepare(
    `UPDATE templates SET name = ?, description = ?, audience = ?, sections = ?, extra_instructions = ?
     WHERE id = ?`
  ).run(
    name?.trim() || row.name,
    description ?? row.description,
    audience ?? row.audience,
    JSON.stringify(valid?.length ? valid : JSON.parse(row.sections)),
    extra_instructions ?? row.extra_instructions,
    row.id
  );
  ok(res, templateOut(db.prepare('SELECT * FROM templates WHERE id = ?').get(row.id)));
});

app.delete('/api/templates/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.params.id));
  if (!row) return fail(res, 404, 'Template not found.');
  if (row.is_builtin) return fail(res, 400, 'Built-in templates cannot be deleted.');
  db.prepare('DELETE FROM templates WHERE id = ?').run(row.id);
  ok(res, { deleted: true });
});

/* ---------------------------------------------------------------- projects */

const projectSummary = () =>
  db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM researches r WHERE r.project_id = p.id) AS tab_count,
              (SELECT COUNT(*) FROM researches r WHERE r.project_id = p.id AND r.status IN ('queued','extracting','running')) AS running_count
       FROM projects p ORDER BY p.updated_at DESC, p.id DESC`
    )
    .all();

app.get('/api/projects', (_req, res) => ok(res, projectSummary()));

app.post('/api/projects', (req, res) => {
  const name = (req.body?.name ?? '').trim();
  if (!name) return fail(res, 400, 'Give the project a name.');
  const info = db
    .prepare('INSERT INTO projects (name, description, goal) VALUES (?, ?, ?)')
    .run(name, (req.body?.description ?? '').trim(), (req.body?.goal ?? '').trim());
  ok(res, db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return fail(res, 404, 'Project not found.');
  db.prepare(
    "UPDATE projects SET name = ?, description = ?, goal = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    (req.body?.name ?? p.name).trim() || p.name,
    req.body?.description ?? p.description,
    req.body?.goal ?? p.goal,
    p.id
  );
  ok(res, db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id));
});

app.delete('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return fail(res, 404, 'Project not found.');
  for (const r of db.prepare('SELECT id FROM researches WHERE project_id = ?').all(p.id)) cancel(r.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  ok(res, { deleted: true });
});

/** Everything the workspace needs for one project: tabs + console history. */
app.get('/api/projects/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
  if (!p) return fail(res, 404, 'Project not found.');

  const tabs = db
    .prepare(
      `SELECT r.id, r.name, r.status, r.progress, r.stage, r.source_type, r.source_label,
              r.source_title, r.tab_order, r.updated_at, t.name AS template_name
       FROM researches r LEFT JOIN templates t ON t.id = r.template_id
       WHERE r.project_id = ? ORDER BY r.tab_order, r.id`
    )
    .all(p.id)
    .map((t) => ({ ...t, running: isRunning(t.id) }));

  const messages = db
    .prepare('SELECT * FROM console_messages WHERE project_id = ? ORDER BY id')
    .all(p.id);
  const suggestions = db
    .prepare('SELECT * FROM suggestions WHERE project_id = ? ORDER BY id')
    .all(p.id);

  ok(res, { project: p, tabs, messages, suggestions });
});

/* ---------------------------------------------------------------- console */

app.post(
  '/api/projects/:id/console',
  asyncRoute(async (req, res) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
    if (!p) return fail(res, 404, 'Project not found.');
    const request = (req.body?.message ?? '').trim();
    if (!request) return fail(res, 400, 'Type what you are trying to understand.');

    const result = await askConsole({
      projectId: p.id,
      request,
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    touchProject(p.id);
    ok(res, result);
  })
);

/** Turn a suggested source into a new tab in this project. */
app.post('/api/suggestions/:id/add', (req, res) => {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(req.params.id));
  if (!s) return fail(res, 404, 'Suggestion not found.');
  if (!s.url) return fail(res, 400, 'This suggestion has no usable link — add it manually with its URL or PDF.');
  if (s.added_research_id && db.prepare('SELECT 1 FROM researches WHERE id = ?').get(s.added_research_id)) {
    return fail(res, 409, 'That source is already a tab in this project.');
  }

  const templateId =
    Number(req.body?.template_id) ||
    db.prepare("SELECT id FROM templates WHERE name = 'AI Paper Deep Dive (Junior Dev)'").get()?.id ||
    db.prepare('SELECT id FROM templates ORDER BY id LIMIT 1').get()?.id ||
    null;

  const info = db
    .prepare(
      `INSERT INTO researches (project_id, tab_order, name, template_id, source_type, source_ref, source_label, status, stage)
       VALUES (?, ?, ?, ?, 'url', ?, ?, 'queued', 'Queued')`
    )
    .run(s.project_id, nextTabOrder(s.project_id), s.title.slice(0, 200), templateId, s.url, s.url);

  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE suggestions SET added_research_id = ? WHERE id = ?').run(id, s.id);
  touchProject(s.project_id);
  start(id);
  ok(res, { id, ...getResearch(id) });
});

/* -------------------------------------------------------------- researches */

app.get('/api/researches', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.status, r.progress, r.stage, r.source_type, r.source_label,
              r.source_title, r.created_at, r.updated_at, r.chars, t.name AS template_name
       FROM researches r
       LEFT JOIN templates t ON t.id = r.template_id
       ORDER BY r.id DESC`
    )
    .all();
  ok(res, rows.map((r) => ({ ...r, running: isRunning(r.id) })));
});

app.post(
  '/api/researches',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const name = (req.body?.name ?? '').trim();
    const sourceType = req.body?.source_type ?? 'url';
    const templateId = Number(req.body?.template_id) || null;
    let projectId = Number(req.body?.project_id) || null;

    if (!name) return fail(res, 400, 'Give this research a name.');
    if (projectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
      return fail(res, 400, 'That project no longer exists.');
    }
    if (!projectId) projectId = ensureDefaultProject();
    if (templateId && !db.prepare('SELECT 1 FROM templates WHERE id = ?').get(templateId)) {
      return fail(res, 400, 'That template no longer exists.');
    }

    let sourceRef = '';
    let sourceLabel = '';
    let pastedText = '';

    if (sourceType === 'url') {
      const url = (req.body?.url ?? '').trim();
      if (!url) return fail(res, 400, 'Enter a URL.');
      if (!/^(https?:\/\/)?[\w.-]+\.[a-z]{2,}/i.test(url)) return fail(res, 400, 'That does not look like a URL.');
      sourceRef = url;
      sourceLabel = url;
    } else if (sourceType === 'text') {
      pastedText = (req.body?.text ?? '').trim();
      if (pastedText.length < 300) return fail(res, 400, 'Paste at least a few paragraphs of text.');
      sourceLabel = 'Pasted text';
    } else {
      if (!req.file) return fail(res, 400, 'Choose a file to upload.');
      sourceRef = req.file.filename;
      sourceLabel = req.file.originalname;
    }

    const info = db
      .prepare(
        `INSERT INTO researches (project_id, tab_order, name, template_id, source_type, source_ref, source_label, status, stage)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'Queued')`
      )
      .run(projectId, nextTabOrder(projectId), name, templateId, sourceType, sourceRef, sourceLabel);

    const id = Number(info.lastInsertRowid);
    if (pastedText) {
      db.prepare('INSERT INTO source_texts (research_id, text) VALUES (?, ?)').run(id, pastedText);
    }

    touchProject(projectId);
    start(id);
    ok(res, { id, ...getResearch(id) });
  })
);

app.get('/api/researches/:id', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  const id = r.id;

  ok(res, {
    research: {
      ...r,
      running: isRunning(id),
      template_name:
        db.prepare('SELECT name FROM templates WHERE id = ?').get(r.template_id)?.name ?? null,
    },
    sections: db.prepare('SELECT * FROM sections WHERE research_id = ? ORDER BY ord').all(id),
    diagrams: db.prepare('SELECT * FROM diagrams WHERE research_id = ? ORDER BY ord').all(id),
    glossary: db.prepare('SELECT * FROM glossary WHERE research_id = ? ORDER BY ord').all(id),
    simulations: simulationsFor(id),
    scenes3d: scenes3dFor(id),
    events: db.prepare('SELECT * FROM events WHERE research_id = ? ORDER BY id').all(id),
  });
});

/* ------------------------------------------------------------ shorts feed */

app.get('/api/researches/:id/shorts', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  ok(res, shortsState(r.id, String(req.query.lang || 'en')));
});

/** Translate an existing feed; cached per language once generated. */
app.post('/api/researches/:id/shorts/translate', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  try {
    ok(res, translateShorts(r.id, String(req.body?.lang || 'en')));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

app.post('/api/researches/:id/shorts', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  try {
    ok(res, generateShorts(r.id));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ─────────────────────────────── narration ─────────────────────────────── */

app.get('/api/researches/:id/narration', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  ok(res, narrationState(r.id, String(req.query.lang || 'en')));
});

app.post('/api/researches/:id/narration', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  try {
    ok(res, generateNarration(r.id, String(req.body?.lang || 'en')));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

app.get('/api/researches/:id/narration/:lang/:ord.wav', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  const lang = String(req.params.lang).replace(/[^a-z]/gi, '');
  const ord = Number(req.params.ord);
  if (!Number.isInteger(ord) || ord < 0) return fail(res, 400, 'Bad clip index.');

  const file = narrationFile(r.id, lang, ord);
  if (!fs.existsSync(file)) return fail(res, 404, 'That narration clip has not been generated.');
  res.setHeader('content-type', 'audio/wav');
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

/** The extracted text of the original document, for the "Original" tab view. */
app.get('/api/researches/:id/source', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  const row = db.prepare('SELECT text FROM source_texts WHERE research_id = ?').get(r.id);
  if (!row) return fail(res, 404, 'The source text has not been extracted yet.');
  ok(res, {
    title: r.source_title || r.name,
    source: r.source_type === 'url' ? r.source_ref : r.source_label,
    source_type: r.source_type,
    chars: row.text.length,
    text: row.text,
  });
});

app.post('/api/researches/:id/rerun', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  if (isRunning(r.id)) return fail(res, 409, 'This research is already running.');
  db.prepare('DELETE FROM events WHERE research_id = ?').run(r.id);
  start(r.id);
  ok(res, { started: true });
});

app.post('/api/researches/:id/cancel', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  ok(res, { cancelled: cancel(r.id) });
});

app.delete('/api/researches/:id', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  cancel(r.id);
  if (r.source_type !== 'url' && r.source_type !== 'text' && r.source_ref) {
    fs.promises.unlink(path.join(UPLOAD_DIR, r.source_ref)).catch(() => {});
  }
  db.prepare('DELETE FROM researches WHERE id = ?').run(r.id);
  ok(res, { deleted: true });
});

/* --------------------------------------------------------------- markdown */

app.get('/api/researches/:id/export', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  const id = r.id;

  const sections = db.prepare('SELECT * FROM sections WHERE research_id = ? ORDER BY ord').all(id);
  const diagrams = db.prepare('SELECT * FROM diagrams WHERE research_id = ? ORDER BY ord').all(id);
  const glossary = db.prepare('SELECT * FROM glossary WHERE research_id = ? ORDER BY ord').all(id);

  const parts = [
    `# ${r.name}`,
    '',
    r.source_title ? `**Source document:** ${r.source_title}` : '',
    `**From:** ${r.source_label || r.source_ref}`,
    `**Generated:** ${r.updated_at} via ${providerLabel(r.provider)}${r.model ? ` (${r.model})` : ''}`,
    '',
    '---',
    '',
  ];

  for (const s of sections) {
    parts.push(`## ${s.icon ? s.icon + ' ' : ''}${s.heading}`, '');
    if (s.key === 'architecture') {
      parts.push(s.content, '');
      for (const d of diagrams) {
        parts.push(`### ${d.title}`, '', '```mermaid', d.code, '```', '', d.caption ? `_${d.caption}_` : '', '');
      }
    } else if (s.key === 'glossary') {
      if (s.content) parts.push(s.content, '');
      for (const g of glossary) parts.push(`**${g.term}** — ${g.plain}`, '');
    } else {
      parts.push(s.content, '');
    }
  }

  const md = parts.filter((p) => p !== undefined).join('\n');
  const safe = (r.name || 'research').replace(/[^\w.-]+/g, '-').slice(0, 80);
  res.setHeader('content-type', 'text/markdown; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${safe}.md"`);
  res.send(md);
});

/* -------------------------------------------------------------------- SSE */

app.get('/api/researches/:id/stream', (req, res) => {
  const r = getResearch(req.params.id);
  if (!r) return fail(res, 404, 'Research not found.');
  const id = r.id;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ type: 'status', status: r.status, progress: r.progress, stage: r.stage });

  const onEvent = (payload) => send(payload);
  bus.on(`research:${id}`, onEvent);

  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(ping);
    bus.off(`research:${id}`, onEvent);
  });
});

/* ------------------------------------------------------------------ misc */

app.use((err, _req, res, _next) => {
  const status = err.status ?? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message =
    err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the 80 MB limit.' : err.message;
  console.error('[error]', message);
  res.status(status).json({ error: message });
});

app.listen(PORT, HOST, () => {
  db.prepare(
    `UPDATE researches SET status = 'error', error = 'Interrupted by a server restart.'
     WHERE status IN ('queued', 'running', 'extracting')`
  ).run();
  console.log(`\n  Legible  →  http://127.0.0.1:${PORT}`);
  console.log(`  provider: ${providerLabel(activeProvider())}  ·  data: ${DATA_DIR}`);

  if (REQUIRE_AUTH) {
    const created = ensurePassword();
    if (created) {
      console.log(`\n  ⚠  A password was generated for you:\n\n      ${created.pass}\n`);
      console.log(`  Saved to ${created.file} — store it somewhere safe, then delete that file.`);
    } else {
      console.log(`  auth: on (password set)`);
    }
  } else {
    console.log(`  auth: OFF — loopback only, not reachable from other machines`);
  }
  console.log('');
});
