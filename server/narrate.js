import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { db, DATA_DIR } from './db.js';
import { LANGUAGES } from './prompts.js';
import { shortsState } from './shorts.js';

const execFileP = promisify(execFile);

export const NARRATION_DIR = path.join(DATA_DIR, 'narration');
fs.mkdirSync(NARRATION_DIR, { recursive: true });

/** `researchId:lang` -> { status, error, done, total } */
const jobs = new Map();

/* ─────────────────────────────── voices ─────────────────────────────── */

let voiceCache = null;

/** Parse `say -v '?'` into [{ name, locale }]. macOS only. */
async function systemVoices() {
  if (voiceCache) return voiceCache;
  if (process.platform !== 'darwin') return (voiceCache = []);
  try {
    const { stdout } = await execFileP('say', ['-v', '?'], { maxBuffer: 4 << 20 });
    voiceCache = stdout
      .split('\n')
      .map((line) => line.match(/^(.+?)\s{2,}([a-z]{2}(?:[-_][A-Za-z0-9]{2,3})?)\s*#/))
      .filter(Boolean)
      .map((m) => ({ name: m[1].trim(), locale: m[2].replace('-', '_') }));
  } catch {
    voiceCache = [];
  }
  return voiceCache;
}

/** Languages with no system voice of their own borrow a readable neighbour. */
const VOICE_FALLBACK = { mr: 'hi' };

/**
 * macOS lists its novelty voices (Albert, Bells, Zarvox…) alongside the real
 * ones, and alphabetically Albert comes first — so picking "the first en_US
 * voice" gets you a joke voice. Name the good ones explicitly.
 */
const PREFERRED = {
  en: ['Samantha', 'Alex', 'Ava', 'Allison', 'Tom', 'Evan', 'Nicky', 'Karen', 'Daniel'],
};

const NOVELTY = new Set(
  ['Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News', 'Jester',
   'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Deranged', 'Hysterical',
   'Bruce', 'Fred', 'Junior', 'Kathy', 'Princess', 'Ralph', 'Agnes', 'Grandma', 'Grandpa',
   'Eddy', 'Flo', 'Reed', 'Rocko', 'Sandy', 'Shelley'].map((n) => n.toLowerCase())
);

/** Speaking rate in words per minute — a reel should move. */
const RATE = 188;

function rank(voice, langCode) {
  const preferred = PREFERRED[langCode] ?? [];
  const idx = preferred.findIndex((n) => voice.name.toLowerCase() === n.toLowerCase());
  if (idx >= 0) return idx;
  if (NOVELTY.has(voice.name.toLowerCase())) return 900;
  return 100;
}

const bestOf = (list, langCode) =>
  list.length ? [...list].sort((a, b) => rank(a, langCode) - rank(b, langCode))[0] : null;

/**
 * Best system voice for a language: exact locale, then any voice for that
 * language, then a documented fallback, then nothing.
 */
export async function voiceFor(langCode) {
  const voices = await systemVoices();
  if (!voices.length) return null;

  const lang = LANGUAGES.find((l) => l.code === langCode);
  const wantLocale = (lang?.voice ?? 'en-US').replace('-', '_');

  const exact = bestOf(voices.filter((v) => v.locale === wantLocale), langCode);
  if (exact) return { ...exact, exact: true, forLang: langCode };

  const sameLang = bestOf(
    voices.filter((v) => v.locale.startsWith(`${langCode}_`) || v.locale === langCode),
    langCode
  );
  if (sameLang) return { ...sameLang, exact: true, forLang: langCode };

  const alt = VOICE_FALLBACK[langCode];
  if (alt) {
    const borrowed = bestOf(voices.filter((v) => v.locale.startsWith(`${alt}_`)), alt);
    if (borrowed) return { ...borrowed, exact: false, forLang: alt };
  }
  return null;
}

export async function narrationSupport() {
  const voices = await systemVoices();
  if (!voices.length) {
    return {
      available: false,
      reason:
        process.platform === 'darwin'
          ? 'The macOS `say` command did not return any voices.'
          : 'Recorded narration needs the macOS `say` command. The in-app voice still works.',
      languages: {},
    };
  }
  const languages = {};
  for (const l of LANGUAGES) {
    const v = await voiceFor(l.code);
    languages[l.code] = v ? { voice: v.name, exact: v.exact } : null;
  }
  return { available: true, reason: '', languages };
}

/* ──────────────────────────────── audio ─────────────────────────────── */

/** Duration of a RIFF/WAVE file, by walking its chunks (say pads with JUNK/FLLR). */
function wavDurationMs(file) {
  const b = fs.readFileSync(file);
  if (b.subarray(0, 4).toString() !== 'RIFF') return 0;
  let p = 12;
  let rate = 22050;
  let channels = 1;
  let bits = 16;
  while (p + 8 <= b.length) {
    const id = b.subarray(p, p + 4).toString();
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
      bits = b.readUInt16LE(p + 22);
    } else if (id === 'data') {
      const bytesPerSample = Math.max(1, (bits / 8) * Math.max(1, channels));
      return Math.round((size / (rate * bytesPerSample)) * 1000);
    }
    p += 8 + size + (size % 2);
  }
  return 0;
}

function synth(voice, text, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'say',
      ['-v', voice, '-r', String(RATE), '-o', outFile, '--data-format=LEI16@22050', '--file-format=WAVE', text],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`say failed: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`say exited ${code}: ${err.trim().slice(0, 300)}`))
    );
  });
}

/** Strip things a voice should not read out loud. */
function speakable(card) {
  const clean = (s) =>
    String(s || '')
      .replace(/[*_`#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const headline = clean(card.headline);
  const body = clean(card.body);
  return [headline, body].filter(Boolean).join('. ').replace(/\.\./g, '.');
}

/* ─────────────────────────────── the job ────────────────────────────── */

export function narrationState(researchId, lang = 'en') {
  const id = Number(researchId);
  const rows = db
    .prepare('SELECT * FROM narrations WHERE research_id = ? AND lang = ? ORDER BY ord')
    .all(id, lang);
  const job = jobs.get(`${id}:${lang}`);
  const cardCount = db.prepare('SELECT COUNT(*) AS n FROM shorts WHERE research_id = ?').get(id).n;

  return {
    status: job?.status ?? (rows.length && rows.length === cardCount ? 'done' : 'idle'),
    error: job?.error ?? '',
    done: job?.done ?? rows.length,
    total: job?.total ?? cardCount,
    voice: rows[0]?.voice ?? '',
    clips: rows.map((r) => ({
      ord: r.ord,
      durationMs: r.duration_ms,
      url: `/api/researches/${id}/narration/${lang}/${r.ord}.wav`,
    })),
  };
}

export function generateNarration(researchId, langCode) {
  const id = Number(researchId);
  const lang = LANGUAGES.find((l) => l.code === langCode);
  if (!lang) throw new Error(`Unsupported language "${langCode}".`);

  const key = `${id}:${lang.code}`;
  if (jobs.get(key)?.status === 'running') return narrationState(id, lang.code);

  const state = shortsState(id, lang.code);
  if (!state.cards.length) throw new Error('Generate the shorts feed first.');
  if (lang.code !== 'en' && state.translation?.status !== 'done') {
    throw new Error(`Translate the feed into ${lang.label} first.`);
  }

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM narrations WHERE research_id = ? AND lang = ?')
    .get(id, lang.code).n;
  if (existing === state.cards.length) return narrationState(id, lang.code);

  jobs.set(key, { status: 'running', error: '', done: 0, total: state.cards.length });

  (async () => {
    try {
      const voice = await voiceFor(lang.code);
      if (!voice) {
        throw new Error(
          `This Mac has no ${lang.label} voice installed. Add one in System Settings › Accessibility › Spoken Content › System Voice › Manage Voices.`
        );
      }

      const dir = path.join(NARRATION_DIR, String(id), lang.code);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });

      const ins = db.prepare(
        `INSERT INTO narrations (research_id, lang, ord, voice, duration_ms, bytes)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(research_id, lang, ord) DO UPDATE SET
           voice = excluded.voice, duration_ms = excluded.duration_ms, bytes = excluded.bytes`
      );
      db.prepare('DELETE FROM narrations WHERE research_id = ? AND lang = ?').run(id, lang.code);

      for (const [i, card] of state.cards.entries()) {
        const file = path.join(dir, `${i}.wav`);
        await synth(voice.name, speakable(card), file);
        const stat = await fsp.stat(file);
        ins.run(id, lang.code, i, voice.name, wavDurationMs(file), stat.size);
        jobs.set(key, { status: 'running', error: '', done: i + 1, total: state.cards.length });
      }

      jobs.set(key, { status: 'done', error: '', done: state.cards.length, total: state.cards.length });
    } catch (err) {
      jobs.set(key, {
        status: 'error',
        error: err?.message ?? String(err),
        done: 0,
        total: state.cards.length,
      });
    }
  })();

  return narrationState(id, lang.code);
}

export function narrationFile(researchId, lang, ord) {
  return path.join(NARRATION_DIR, String(Number(researchId)), lang, `${Number(ord)}.wav`);
}
