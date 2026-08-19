import { spawn } from 'node:child_process';
import { db } from './db.js';
import { completeJson } from './providers.js';
import { CONSOLE_SYSTEM, consolePrompt } from './prompts.js';

const UA = 'Legible/1.0 (local research tool)';

/* ─────────────────────────── source verification ────────────────────────── */

/**
 * Models are good at remembering paper titles and bad at remembering URLs.
 * So we throw away the URL and look the title up for real, falling back to the
 * model's URL only if the lookup finds nothing.
 */
async function lookupArxiv(title) {
  if (!title) return null;
  const query = title.replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const url =
    'https://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent(`ti:"${query}"`) +
    '&max_results=3';

  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const xml = await res.text();

    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(title);

    for (const entry of entries) {
      const gotTitle = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim();
      const id = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ?? '';
      const published = entry.match(/<published>(\d{4})/)?.[1] ?? '';
      const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
      if (!id) continue;

      const got = norm(gotTitle);
      // Accept an exact-ish match, or one title clearly containing the other.
      if (got === want || got.includes(want) || want.includes(got)) {
        const absUrl = id.replace('http://', 'https://').replace(/v\d+$/, '');
        return {
          url: absUrl,
          title: gotTitle,
          year: published,
          authors: authors.length ? `${authors[0]}${authors.length > 1 ? ' et al.' : ''}` : '',
        };
      }
    }
  } catch {
    /* offline or arXiv down — fall through to the model's URL */
  }
  return null;
}

/** curl succeeds against hosts that reset Node's TLS handshake (arxiv.org, mainly). */
function curlStatus(url) {
  return new Promise((resolve) => {
    const child = spawn(
      'curl',
      ['-sIL', '--max-time', '20', '-A', UA, '-o', '/dev/null', '-w', '%{http_code}', url],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number(out.trim()) || 0));
  });
}

async function urlIsReachable(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;

  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
      if (res.status === 405 || res.status === 501) continue; // HEAD not allowed, retry as GET
      return false;
    } catch {
      /* network hiccup or a host that rejects undici — fall through to curl */
    }
  }

  const status = await curlStatus(url);
  return status >= 200 && status < 400;
}

/** Normalise an RFC reference into the canonical rfc-editor plain-text URL. */
function rfcUrl(suggestion) {
  const num =
    suggestion.url?.match(/rfc(\d{3,5})/i)?.[1] ??
    suggestion.title?.match(/\bRFC\s*(\d{3,5})\b/i)?.[1];
  return num ? `https://www.rfc-editor.org/rfc/rfc${num}.txt` : null;
}

async function resolveSuggestion(s) {
  const out = { ...s, verified: 0 };

  if (s.kind === 'rfc') {
    const canonical = rfcUrl(s);
    if (canonical && (await urlIsReachable(canonical))) {
      out.url = canonical;
      out.verified = 1;
      return out;
    }
  }

  if (s.kind === 'paper' || s.kind === 'article') {
    const found = await lookupArxiv(s.title);
    if (found) {
      out.url = found.url;
      out.title = found.title || out.title;
      out.year = out.year || found.year;
      out.authors = out.authors || found.authors;
      out.verified = 1;
      return out;
    }
  }

  if (s.url && (await urlIsReachable(s.url))) out.verified = 1;
  return out;
}

/* ──────────────────────────────── the console ───────────────────────────── */

export async function askConsole({ projectId, request, signal }) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('Project not found.');

  const history = db
    .prepare('SELECT role, content FROM console_messages WHERE project_id = ? ORDER BY id DESC LIMIT 6')
    .all(projectId)
    .reverse();

  const existing = db
    .prepare('SELECT name, source_title FROM researches WHERE project_id = ?')
    .all(projectId)
    .map((r) => r.source_title || r.name);

  const userMsg = db
    .prepare('INSERT INTO console_messages (project_id, role, content) VALUES (?, ?, ?)')
    .run(projectId, 'user', request);

  const { data } = await completeJson({
    system: CONSOLE_SYSTEM,
    prompt: consolePrompt({
      request: project.goal ? `${request}\n\n(Project context: ${project.goal})` : request,
      history,
      existing,
    }),
    signal,
  });

  const reply = String(data.reply || 'Here are some sources worth reading.');
  const raw = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 8) : [];

  const assistantMsg = db
    .prepare('INSERT INTO console_messages (project_id, role, content) VALUES (?, ?, ?)')
    .run(projectId, 'assistant', reply);
  const messageId = Number(assistantMsg.lastInsertRowid);

  const resolved = await Promise.all(
    raw.map((s) =>
      resolveSuggestion({
        title: String(s.title || '').trim(),
        authors: String(s.authors || '').trim(),
        year: String(s.year || '').trim(),
        kind: ['paper', 'rfc', 'spec', 'article'].includes(s.kind) ? s.kind : 'paper',
        url: String(s.url || '').trim(),
        why: String(s.why || '').trim(),
        readsBefore: String(s.readsBefore || '').trim(),
      }).catch(() => ({ ...s, verified: 0 }))
    )
  );

  const ins = db.prepare(
    `INSERT INTO suggestions (project_id, message_id, title, authors, year, kind, url, why, reads_before, verified, ord)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const ids = [];
  resolved.forEach((s, i) => {
    if (!s.title) return;
    const info = ins.run(
      projectId,
      messageId,
      s.title,
      s.authors ?? '',
      s.year ?? '',
      s.kind ?? 'paper',
      s.url ?? '',
      s.why ?? '',
      s.readsBefore ?? '',
      s.verified ?? 0,
      i
    );
    ids.push(Number(info.lastInsertRowid));
  });

  return {
    userMessageId: Number(userMsg.lastInsertRowid),
    messageId,
    reply,
    suggestions: ids.length
      ? db
          .prepare(`SELECT * FROM suggestions WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY ord`)
          .all(...ids)
      : [],
  };
}
