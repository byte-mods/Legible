import { db, getSetting } from './db.js';
import { completeJson } from './providers.js';
import { systemPrompt, shortsPrompt, translateShortsPrompt, LANGUAGES } from './prompts.js';
import { fitToBudget } from './extract.js';

/** researchId -> { status, error } while a feed is being written. */
const jobs = new Map();
/** `researchId:lang` -> { status, error } while a translation is being written. */
const translationJobs = new Map();

const KINDS = ['hook', 'problem', 'idea', 'number', 'analogy', 'catch', 'payoff'];

/** Default English pill labels, mirrored on the client. */
const KIND_TAG = {
  hook: 'the hook',
  problem: 'the problem',
  idea: 'the idea',
  number: 'by the numbers',
  analogy: 'think of it like',
  catch: 'the catch',
  payoff: 'so what',
};

function parseScene(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' && s.type ? s : null;
  } catch {
    return null;
  }
}

/**
 * Every human-readable string in a scene, in a fixed order. The translator gets
 * this list and returns it translated; translateScene() puts them back in the
 * same order, so the two functions must stay in step.
 */
export function sceneLabels(scene) {
  if (!scene) return [];
  const out = [];
  if (scene.label) out.push(scene.label);
  if (Array.isArray(scene.items)) scene.items.forEach((it) => { if (it.label) out.push(it.label); });
  if (scene.left?.label) out.push(scene.left.label);
  if (scene.right?.label) out.push(scene.right.label);
  if (scene.link) out.push(scene.link);
  if (scene.from) out.push(scene.from);
  if (scene.to) out.push(scene.to);
  if (scene.top) out.push(scene.top);
  if (scene.bottom) out.push(scene.bottom);
  return out;
}

/** Swap scene labels for their translated versions when we have them. */
function translateScene(scene, row) {
  if (!scene) return null;
  let labels = null;
  try {
    labels = row?.scene_labels ? JSON.parse(row.scene_labels) : null;
  } catch {
    labels = null;
  }
  if (!Array.isArray(labels) || !labels.length) return scene;

  let n = 0;
  const next = (fallback) => (n < labels.length ? labels[n++] || fallback : fallback);
  const out = structuredClone(scene);
  if (out.label) out.label = next(out.label);
  if (Array.isArray(out.items)) out.items.forEach((it) => { if (it.label) it.label = next(it.label); });
  if (out.left?.label) out.left.label = next(out.left.label);
  if (out.right?.label) out.right.label = next(out.right.label);
  if (out.link) out.link = next(out.link);
  if (out.from) out.from = next(out.from);
  if (out.to) out.to = next(out.to);
  if (out.top) out.top = next(out.top);
  if (out.bottom) out.bottom = next(out.bottom);
  return out;
}

export function shortsState(researchId, lang = 'en') {
  const id = Number(researchId);
  const cards = db.prepare('SELECT * FROM shorts WHERE research_id = ? ORDER BY ord').all(id);
  const job = jobs.get(id);

  const base = {
    status: job?.status ?? (cards.length ? 'done' : 'idle'),
    error: job?.error ?? '',
    lang: 'en',
    translation: null,
    cards: cards.map((c) => ({ ...c, tag: KIND_TAG[c.kind] ?? c.kind, scene: parseScene(c.scene) })),
  };

  if (lang === 'en' || !cards.length) return base;

  const tjob = translationJobs.get(`${id}:${lang}`);
  const rows = db
    .prepare('SELECT * FROM short_translations WHERE research_id = ? AND lang = ? ORDER BY ord')
    .all(id, lang);

  const translated = rows.length === cards.length;
  return {
    ...base,
    lang,
    translation: {
      status: tjob?.status ?? (translated ? 'done' : 'idle'),
      error: tjob?.error ?? '',
    },
    cards: translated
      ? cards.map((c, i) => ({
          ...c,
          scene: translateScene(parseScene(c.scene), rows[i]),
          headline: rows[i].headline || c.headline,
          body: rows[i].body || c.body,
          punch: rows[i].punch ?? c.punch,
          tag: rows[i].tag || KIND_TAG[c.kind] || c.kind,
        }))
      : base.cards,
  };
}

/**
 * Translate an existing feed. One call for the whole deck so the cards stay
 * consistent with each other, then cached in SQLite — a language is paid for once.
 */
export function translateShorts(researchId, langCode) {
  const id = Number(researchId);
  const language = LANGUAGES.find((l) => l.code === langCode);
  if (!language) throw new Error(`Unsupported language "${langCode}".`);
  if (language.code === 'en') return shortsState(id, 'en');

  const key = `${id}:${language.code}`;
  if (translationJobs.get(key)?.status === 'running') return shortsState(id, language.code);

  const cards = db.prepare('SELECT * FROM shorts WHERE research_id = ? ORDER BY ord').all(id);
  if (!cards.length) throw new Error('Generate the shorts feed first.');

  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM short_translations WHERE research_id = ? AND lang = ?')
    .get(id, language.code).n;
  if (existing === cards.length) return shortsState(id, language.code);

  const research = db.prepare('SELECT * FROM researches WHERE id = ?').get(id);
  translationJobs.set(key, { status: 'running', error: '' });

  (async () => {
    try {
      const { data } = await completeJson({
        system: `You are a professional translator working into ${language.label}. You translate meaning, not words, and you never alter numbers or invent content.`,
        prompt: translateShortsPrompt({
          language,
          title: research?.source_title || research?.name || '',
          cards: cards.map((c) => ({
            ...c,
            tag: KIND_TAG[c.kind] ?? c.kind,
            sceneLabels: sceneLabels(parseScene(c.scene)),
          })),
        }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });

      const out = Array.isArray(data.cards) ? data.cards : [];
      if (out.length !== cards.length) {
        throw new Error(`The model returned ${out.length} cards for ${cards.length} originals.`);
      }

      const tx = db.transaction(() => {
        db.prepare('DELETE FROM short_translations WHERE research_id = ? AND lang = ?').run(id, language.code);
        const ins = db.prepare(
          `INSERT INTO short_translations (research_id, lang, ord, headline, body, punch, tag, scene_labels)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        cards.forEach((c, i) => {
          const t = out.find((x) => Number(x.i) === i) ?? out[i] ?? {};
          ins.run(
            id,
            language.code,
            i,
            String(t.headline || c.headline).trim(),
            String(t.body ?? c.body).trim(),
            String(t.punch ?? c.punch).trim(),
            String(t.tag || KIND_TAG[c.kind] || c.kind).trim(),
            Array.isArray(t.sceneLabels) ? JSON.stringify(t.sceneLabels.map((x) => String(x))) : ''
          );
        });
      });
      tx();

      translationJobs.set(key, { status: 'done', error: '' });
    } catch (err) {
      translationJobs.set(key, { status: 'error', error: err?.message ?? String(err) });
    }
  })();

  return shortsState(id, language.code);
}

export function generateShorts(researchId) {
  const id = Number(researchId);
  if (jobs.get(id)?.status === 'running') return shortsState(id);

  const research = db.prepare('SELECT * FROM researches WHERE id = ?').get(id);
  if (!research) throw new Error('Research not found.');

  const source = db.prepare('SELECT text FROM source_texts WHERE research_id = ?').get(id);
  if (!source?.text) {
    throw new Error('The source text has not been extracted yet — let the explanation finish first.');
  }

  jobs.set(id, { status: 'running', error: '' });

  (async () => {
    try {
      const template = research.template_id
        ? db.prepare('SELECT * FROM templates WHERE id = ?').get(research.template_id)
        : null;

      const budget = Math.max(20000, Number(getSetting('max_source_chars', '180000')) || 180000);
      const { text: docText } = fitToBudget(source.text, budget);

      const headlines = db
        .prepare('SELECT heading FROM sections WHERE research_id = ? ORDER BY ord')
        .all(id)
        .map((s) => s.heading);

      // Recon is cheap to reconstruct from what the report already knows.
      const recon = {
        title: research.source_title || research.name,
        docType: '',
        oneLiner: '',
        systemShape: '',
        keyClaims: [],
        numbers: [],
      };

      const { data } = await completeJson({
        system: systemPrompt(template?.audience ?? 'basic-tech'),
        prompt: shortsPrompt({
          recon,
          docText,
          sourceLabel: research.source_label || research.source_ref || research.name,
          headlines,
        }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });

      const cards = (Array.isArray(data.cards) ? data.cards : [])
        .filter((c) => c && String(c.headline || '').trim())
        .slice(0, 20);

      if (!cards.length) throw new Error('The model returned no cards.');

      const tx = db.transaction((rows) => {
        db.prepare('DELETE FROM shorts WHERE research_id = ?').run(id);
        const ins = db.prepare(
          'INSERT INTO shorts (research_id, ord, kind, emoji, headline, body, punch, scene) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        rows.forEach((c, i) =>
          ins.run(
            id,
            i,
            KINDS.includes(c.kind) ? c.kind : 'idea',
            String(c.emoji || '').slice(0, 8),
            String(c.headline).trim().slice(0, 200),
            String(c.body || '').trim(),
            String(c.punch || '').trim().slice(0, 60),
            c.scene && typeof c.scene === 'object' ? JSON.stringify(c.scene) : ''
          )
        );
      });
      tx(cards);

      jobs.set(id, { status: 'done', error: '' });
    } catch (err) {
      jobs.set(id, { status: 'error', error: err?.message ?? String(err) });
    }
  })();

  return shortsState(id);
}
