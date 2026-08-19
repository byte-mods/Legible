import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'research.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  audience           TEXT NOT NULL DEFAULT 'basic-tech',
  sections           TEXT NOT NULL,           -- JSON array of section keys
  extra_instructions TEXT NOT NULL DEFAULT '',
  is_builtin         INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal        TEXT NOT NULL DEFAULT '',   -- what the user is trying to understand
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS researches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  tab_order     INTEGER NOT NULL DEFAULT 0,
  name          TEXT NOT NULL,
  template_id   INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  source_type   TEXT NOT NULL,                -- url | pdf | doc | text
  source_ref    TEXT NOT NULL DEFAULT '',     -- url or stored filename
  source_label  TEXT NOT NULL DEFAULT '',     -- human readable origin
  source_title  TEXT NOT NULL DEFAULT '',     -- title detected in the document
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|extracting|running|done|error|cancelled
  progress      INTEGER NOT NULL DEFAULT 0,
  stage         TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  chars         INTEGER NOT NULL DEFAULT 0,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_texts (
  research_id INTEGER PRIMARY KEY REFERENCES researches(id) ON DELETE CASCADE,
  text        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  heading     TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  ord         INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(research_id, key)
);

CREATE TABLE IF NOT EXISTS diagrams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  caption     TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS glossary (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  plain       TEXT NOT NULL DEFAULT '',
  ord         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shorts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'idea',
  emoji       TEXT NOT NULL DEFAULT '',
  headline    TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  punch       TEXT NOT NULL DEFAULT '',
  scene       TEXT NOT NULL DEFAULT '',   -- JSON animated-scene spec
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS short_translations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  headline    TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  punch       TEXT NOT NULL DEFAULT '',
  tag         TEXT NOT NULL DEFAULT '',
  scene_labels TEXT NOT NULL DEFAULT '',  -- JSON array, same order as sceneLabels()
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(research_id, lang, ord)
);

CREATE TABLE IF NOT EXISTS narrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  lang        TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  voice       TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(research_id, lang, ord)
);

CREATE TABLE IF NOT EXISTS simulations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id  INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  blurb        TEXT NOT NULL DEFAULT '',
  expression   TEXT NOT NULL,
  output_label TEXT NOT NULL DEFAULT 'Result',
  output_unit  TEXT NOT NULL DEFAULT '',
  vars         TEXT NOT NULL DEFAULT '[]',   -- JSON [{key,label,unit,min,max,step,value}]
  insight      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenes3d (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id  INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  blurb        TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL,
  spec         TEXT NOT NULL DEFAULT '{}',   -- JSON, shape depends on kind
  vars         TEXT NOT NULL DEFAULT '[]',   -- JSON [{key,label,unit,min,max,step,value}]
  insight      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  research_id INTEGER NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS console_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,               -- user | assistant | system
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suggestions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message_id         INTEGER REFERENCES console_messages(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  authors            TEXT NOT NULL DEFAULT '',
  year               TEXT NOT NULL DEFAULT '',
  kind               TEXT NOT NULL DEFAULT 'paper',  -- paper | rfc | spec | article
  url                TEXT NOT NULL DEFAULT '',
  why                TEXT NOT NULL DEFAULT '',
  reads_before       TEXT NOT NULL DEFAULT '',
  verified           INTEGER NOT NULL DEFAULT 0,
  added_research_id  INTEGER REFERENCES researches(id) ON DELETE SET NULL,
  ord                INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_research ON events(research_id, id);
CREATE INDEX IF NOT EXISTS idx_sections_research ON sections(research_id, ord);
CREATE INDEX IF NOT EXISTS idx_researches_created ON researches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_console_project ON console_messages(project_id, id);
CREATE INDEX IF NOT EXISTS idx_suggestions_project ON suggestions(project_id, id);
`);

/* ---------------------------------------------- migrations for older files */

// Databases created before projects existed have a `researches` table that
// CREATE TABLE IF NOT EXISTS leaves untouched, so add the columns by hand
// before anything else references them.
const researchCols = new Set(db.prepare('PRAGMA table_info(researches)').all().map((c) => c.name));
if (!researchCols.has('project_id')) {
  db.exec('ALTER TABLE researches ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE');
}
if (!researchCols.has('tab_order')) {
  db.exec('ALTER TABLE researches ADD COLUMN tab_order INTEGER NOT NULL DEFAULT 0');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_researches_project ON researches(project_id, tab_order)');

// `scene` arrived after the first shorts shipped
if (!new Set(db.prepare('PRAGMA table_info(shorts)').all().map((c) => c.name)).has('scene')) {
  db.exec("ALTER TABLE shorts ADD COLUMN scene TEXT NOT NULL DEFAULT ''");
}
if (!new Set(db.prepare('PRAGMA table_info(short_translations)').all().map((c) => c.name)).has('scene_labels')) {
  db.exec("ALTER TABLE short_translations ADD COLUMN scene_labels TEXT NOT NULL DEFAULT ''");
}

/* ---------------------------------------------------------------- settings */

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

const DEFAULT_SETTINGS = {
  provider: 'claude',       // claude | codex | anthropic
  claude_model: '',         // '' = whatever the CLI defaults to
  codex_model: '',
  anthropic_model: 'claude-opus-5',
  max_source_chars: '180000',
};

for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

/* --------------------------------------------------------- seed templates */

export const ALL_SECTIONS = [
  { key: 'tldr',         heading: 'The 60-Second Version',      icon: '⚡' },
  { key: 'problem',      heading: 'What Problem Does It Solve?', icon: '🎯' },
  { key: 'analogy',      heading: 'Explain It Like a Story',    icon: '📖' },
  { key: 'how',          heading: 'How It Actually Works',      icon: '⚙️' },
  { key: 'architecture', heading: 'Architecture & Diagrams',    icon: '🏗' },
  { key: 'math',         heading: 'The Maths, Slowly',          icon: '∑' },
  { key: 'walkthrough',  heading: 'A Worked Example',           icon: '🔬' },
  { key: 'deep',         heading: 'Deep Dive',                  icon: '🧠' },
  { key: 'context',      heading: 'How It Fits The Bigger Picture', icon: '🌍' },
  { key: 'limits',       heading: 'Limits, Risks & Criticisms', icon: '⚠️' },
  { key: 'glossary',     heading: 'Jargon Decoder',             icon: '🔤' },
  { key: 'faq',          heading: 'Questions You Might Have',   icon: '❓' },
  { key: 'takeaways',    heading: 'What To Remember',           icon: '✅' },
];

export const SECTION_MAP = Object.fromEntries(ALL_SECTIONS.map((s) => [s.key, s]));

const BUILTIN_TEMPLATES = [
  {
    name: 'Research Paper → Plain English',
    description: 'Full breakdown of an academic paper for a reader with basic tech knowledge.',
    audience: 'basic-tech',
    sections: ['tldr', 'problem', 'analogy', 'how', 'architecture', 'walkthrough', 'deep', 'context', 'limits', 'glossary', 'faq', 'takeaways'],
    extra_instructions: 'Pay attention to the method, the experiments and what the results actually prove versus what they only suggest.',
  },
  {
    name: 'RFC / Spec Explainer',
    description: 'For RFCs, protocol specs and standards documents. Heavy on message flows.',
    audience: 'basic-tech',
    sections: ['tldr', 'problem', 'analogy', 'how', 'architecture', 'walkthrough', 'context', 'limits', 'glossary', 'faq', 'takeaways'],
    extra_instructions: 'Include a sequence diagram of the protocol handshake or message exchange. Explain each field/header in plain words. Note which parts are MUST vs SHOULD vs MAY.',
  },
  {
    name: 'Quick Brief (5 min read)',
    description: 'Short version — the gist, one diagram, and the takeaways.',
    audience: 'non-technical',
    sections: ['tldr', 'problem', 'analogy', 'architecture', 'takeaways'],
    extra_instructions: 'Keep the whole thing under roughly 900 words. Favour clarity over completeness.',
  },
  {
    name: 'AI Paper Deep Dive (Junior Dev)',
    description: 'Everything, slowly — including the maths — for a junior engineer new to AI research.',
    audience: 'junior-dev',
    sections: ['tldr', 'problem', 'analogy', 'how', 'architecture', 'math', 'walkthrough', 'deep', 'context', 'limits', 'glossary', 'faq', 'takeaways'],
    extra_instructions:
      'Assume the reader has never read a machine-learning paper. Every equation, symbol and Greek letter must be explained in words before it is used. ' +
      'Work through at least one numeric example with small, made-up numbers so the reader can follow the arithmetic by hand. ' +
      'Whenever the paper uses a standard ML building block (softmax, gradient descent, embeddings, layer norm, cross-entropy), explain what it does in one plain sentence rather than assuming it is known.',
  },
  {
    name: 'Engineer Onboarding',
    description: 'For a developer who has to actually build on top of this.',
    audience: 'developer',
    sections: ['tldr', 'problem', 'how', 'architecture', 'walkthrough', 'deep', 'limits', 'glossary', 'takeaways'],
    extra_instructions: 'Be concrete about data structures, interfaces and failure modes. Include pseudo-code where it clarifies things.',
  },
];

// Seed by name so new built-ins reach databases created by an earlier version.
{
  const ins = db.prepare(
    `INSERT INTO templates (name, description, audience, sections, extra_instructions, is_builtin)
     VALUES (@name, @description, @audience, @sections, @extra_instructions, 1)`
  );
  const exists = db.prepare('SELECT 1 FROM templates WHERE name = ?');
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      if (!exists.get(r.name)) ins.run({ ...r, sections: JSON.stringify(r.sections) });
    }
  });
  tx(BUILTIN_TEMPLATES);
}

/* ---------------------------------------------------------------- projects */

export function ensureDefaultProject() {
  const existing = db.prepare("SELECT id FROM projects ORDER BY id LIMIT 1").get();
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO projects (name, description) VALUES (?, ?)')
    .run('My Research', 'Default project');
  return Number(info.lastInsertRowid);
}

// Any research from before projects existed gets adopted into the first project.
{
  const orphans = db.prepare('SELECT COUNT(*) AS n FROM researches WHERE project_id IS NULL').get().n;
  if (orphans > 0) {
    const pid = ensureDefaultProject();
    db.prepare('UPDATE researches SET project_id = ? WHERE project_id IS NULL').run(pid);
  }
}

export function nextTabOrder(projectId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(tab_order), -1) AS m FROM researches WHERE project_id = ?')
    .get(projectId);
  return row.m + 1;
}

export function touchProject(id) {
  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
}

/* ------------------------------------------------------------ event log */

export function logEvent(researchId, message, level = 'info') {
  db.prepare('INSERT INTO events (research_id, level, message) VALUES (?, ?, ?)').run(
    researchId,
    level,
    message
  );
}

export function touchResearch(id, patch = {}) {
  const fields = Object.keys(patch);
  const sql =
    `UPDATE researches SET updated_at = datetime('now')` +
    fields.map((f) => `, ${f} = @${f}`).join('') +
    ' WHERE id = @id';
  db.prepare(sql).run({ ...patch, id });
}
