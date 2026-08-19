import { EventEmitter } from 'node:events';
import { validateSimulation, validateScene3d } from './simulations.js';
import path from 'node:path';
import {
  db,
  logEvent,
  touchResearch,
  getSetting,
  SECTION_MAP,
  UPLOAD_DIR,
} from './db.js';
import { extractFromUrl, extractFromFile, fitToBudget, guessTitle } from './extract.js';
import { complete, completeJson, activeProvider, activeModel } from './providers.js';
import {
  systemPrompt,
  RECON_PROMPT,
  sectionPrompt,
  architecturePrompt,
  glossaryPrompt,
  simulationsPrompt,
  scenes3dPrompt,
} from './prompts.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

/** researchId -> AbortController */
const running = new Map();

export function isRunning(id) {
  return running.has(Number(id));
}

export function cancel(id) {
  const ctl = running.get(Number(id));
  if (!ctl) return false;
  ctl.abort();
  return true;
}

function emit(id, type, payload = {}) {
  bus.emit(`research:${id}`, { type, ...payload });
}

function say(id, message, level = 'info') {
  logEvent(id, message, level);
  emit(id, 'log', { level, message, at: new Date().toISOString() });
}

function setStage(id, stage, progress) {
  touchResearch(id, { stage, progress });
  emit(id, 'stage', { stage, progress });
}

/* --------------------------------------------------------------- mermaid */

const RESERVED = new Set(['end', 'graph', 'subgraph', 'class', 'click', 'style', 'state', 'note']);

/**
 * Repair the mistakes models reliably make in Mermaid source.
 * Only flowcharts are rewritten — sequence, state and ER diagrams have their own
 * grammar (`||--o{`, `A->>B: msg`) that these rules would corrupt.
 */
export function sanitizeMermaid(raw) {
  let code = String(raw || '').trim();

  code = code.replace(/^```(?:mermaid)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  const firstLine = code.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) ?? '';
  if (!/^\s*(flowchart|graph)\b/.test(firstLine)) return code;

  const fixed = code.split('\n').map((line) => {
    if (/^\s*(%%|classDef|click|style|linkStyle|subgraph)/.test(line)) return line;

    // Quote node labels that aren't already quoted: A[Some (label)] -> A["Some (label)"]
    line = line.replace(
      /(\w+)(\[\[|\[\(|\(\(|\{\{|\[|\(|\{|>)([^\]\)\}>"]*?)(\]\]|\)\]|\)\)|\}\}|\]|\)|\})/g,
      (m, id, open, label, close) => {
        const trimmed = label.trim();
        if (!trimmed || trimmed.startsWith('"')) return m;
        return `${id}${open}"${trimmed.replace(/"/g, "'")}"${close}`;
      }
    );

    // Quote edge labels, but only where an arrow actually precedes them:
    //   -->|foo bar|  ->  -->|"foo bar"|
    line = line.replace(
      /(--+>|-\.-+>|==+>|--+|-\.-+|~~~)\|([^|"]+)\|/g,
      (m, arrow, label) => `${arrow}|"${label.trim().replace(/"/g, "'")}"|`
    );

    // Reserved words used as node IDs break the parser.
    line = line.replace(/(^|\s)(end|class|graph|style|click)(\s*[\[({])/gi, (m, pre, word, open) =>
      RESERVED.has(word.toLowerCase()) ? `${pre}${word.toLowerCase()}Node${open}` : m
    );

    return line;
  });

  return fixed.join('\n').trim();
}

/* ------------------------------------------------------------- extraction */

async function extract(research) {
  setStage(research.id, 'Reading the source', 5);

  let out;
  if (research.source_type === 'url') {
    say(research.id, `Fetching ${research.source_ref}`);
    out = await extractFromUrl(research.source_ref);
  } else if (research.source_type === 'text') {
    const row = db.prepare('SELECT text FROM source_texts WHERE research_id = ?').get(research.id);
    out = { text: row?.text ?? '', title: '', kind: 'text' };
  } else {
    const file = path.join(UPLOAD_DIR, research.source_ref);
    say(research.id, `Reading ${research.source_label}`);
    out = await extractFromFile(file, research.source_label);
  }

  const text = (out.text || '').trim();
  if (text.length < 300) {
    throw new Error(
      'Only ' +
        text.length +
        ' characters of readable text came out of this source. If it is a scanned PDF it has no text layer and needs OCR first; if it is a URL the page may require JavaScript or a login.'
    );
  }

  db.prepare(
    `INSERT INTO source_texts (research_id, text) VALUES (?, ?)
     ON CONFLICT(research_id) DO UPDATE SET text = excluded.text`
  ).run(research.id, text);

  const title = (out.title || guessTitle(text, research.name)).slice(0, 300);
  touchResearch(research.id, { chars: text.length, source_title: title });

  const pages = out.pages ? `, ${out.pages} pages` : '';
  say(research.id, `Extracted ${text.length.toLocaleString()} characters${pages} of text.`);
  return text;
}

/* --------------------------------------------------------------- the run */

async function runPipeline(researchId) {
  const id = Number(researchId);
  const ctl = new AbortController();
  running.set(id, ctl);
  const signal = ctl.signal;

  const usage = { in: 0, out: 0 };
  const addUsage = (u) => {
    usage.in += u?.in ?? 0;
    usage.out += u?.out ?? 0;
  };

  try {
    const research = db.prepare('SELECT * FROM researches WHERE id = ?').get(id);
    if (!research) return;

    const template = research.template_id
      ? db.prepare('SELECT * FROM templates WHERE id = ?').get(research.template_id)
      : null;

    const sectionKeys = (() => {
      try {
        const arr = JSON.parse(template?.sections ?? '[]');
        return arr.filter((k) => SECTION_MAP[k]);
      } catch {
        return [];
      }
    })();
    const keys = sectionKeys.length ? sectionKeys : ['tldr', 'problem', 'how', 'architecture', 'takeaways'];

    const audience = template?.audience ?? 'basic-tech';
    const extraInstructions = template?.extra_instructions ?? '';
    const provider = activeProvider();

    touchResearch(id, {
      status: 'extracting',
      error: '',
      provider,
      model: activeModel(provider),
    });
    emit(id, 'status', { status: 'extracting' });

    db.prepare('DELETE FROM sections WHERE research_id = ?').run(id);
    db.prepare('DELETE FROM diagrams WHERE research_id = ?').run(id);
    db.prepare('DELETE FROM glossary WHERE research_id = ?').run(id);
    db.prepare('DELETE FROM simulations WHERE research_id = ?').run(id);
    db.prepare('DELETE FROM scenes3d WHERE research_id = ?').run(id);

    /* 1 — source text */
    const fullText = await extract({ ...research });
    const budget = Math.max(20000, Number(getSetting('max_source_chars', '180000')) || 180000);
    const { text: docText, truncated } = fitToBudget(fullText, budget);
    if (truncated) {
      say(id, `Document is long — the middle was thinned out to fit ${budget.toLocaleString()} characters.`, 'warn');
    }

    const sourceLabel = research.source_label || research.source_ref || research.name;
    const system = systemPrompt(audience);

    /* 2 — recon */
    touchResearch(id, { status: 'running' });
    emit(id, 'status', { status: 'running' });
    setStage(id, 'Understanding the document', 12);
    say(id, `Analysing with ${provider} (${activeModel(provider)})…`);

    const reconRes = await completeJson({
      system: 'You are a meticulous technical analyst. You extract structure from documents accurately and never invent details.',
      prompt: RECON_PROMPT(docText, sourceLabel),
      signal,
      provider,
    });
    addUsage(reconRes.usage);
    const recon = reconRes.data ?? {};

    if (recon.title) touchResearch(id, { source_title: String(recon.title).slice(0, 300) });
    emit(id, 'recon', { recon });
    say(
      id,
      `Identified as ${recon.docType || 'a document'}${recon.title ? `: “${recon.title}”` : ''}. ` +
        `${(recon.keyClaims || []).length} key claims, ${(recon.keyTerms || []).length} jargon terms.`
    );
    if (recon.confidence === 'low') {
      say(id, 'Text extraction quality looks low — the explanation may have gaps.', 'warn');
    }

    /* 3 — sections, a few at a time */
    const CONCURRENCY = 3;
    const written = [];
    let done = 0;

    const makeSection = async (key, ord) => {
      const meta = SECTION_MAP[key];
      signal.throwIfAborted();

      if (key === 'architecture') {
        const { data, usage: u } = await completeJson({
          system,
          prompt: architecturePrompt({ recon, docText, sourceLabel, extraInstructions }),
          signal,
          provider,
        });
        addUsage(u);
        const diagrams = Array.isArray(data.diagrams) ? data.diagrams : [];
        const insDia = db.prepare(
          'INSERT INTO diagrams (research_id, title, caption, code, ord) VALUES (?, ?, ?, ?, ?)'
        );
        diagrams.forEach((d, i) => {
          const code = sanitizeMermaid(d.code);
          if (code) insDia.run(id, String(d.title || `Diagram ${i + 1}`), String(d.caption || ''), code, i);
        });
        say(id, `Built ${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}.`);
        return String(data.body || '');
      }

      if (key === 'glossary') {
        const { data, usage: u } = await completeJson({
          system,
          prompt: glossaryPrompt({ recon, docText, sourceLabel }),
          signal,
          provider,
        });
        addUsage(u);
        const terms = Array.isArray(data.terms) ? data.terms : [];
        const insTerm = db.prepare(
          'INSERT INTO glossary (research_id, term, plain, ord) VALUES (?, ?, ?, ?)'
        );
        terms.forEach((t, i) => {
          if (t?.term) insTerm.run(id, String(t.term), String(t.plain || ''), i);
        });
        say(id, `Decoded ${terms.length} terms.`);
        return '';
      }

      const { text, usage: u } = await complete({
        system,
        prompt: sectionPrompt({
          key,
          heading: meta.heading,
          recon,
          docText,
          sourceLabel,
          extraInstructions,
          written,
        }),
        signal,
        provider,
      });
      addUsage(u);
      return text;
    };

    const saveSection = db.prepare(
      `INSERT INTO sections (research_id, key, heading, icon, content, ord)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(research_id, key) DO UPDATE SET content = excluded.content`
    );

    // Each section is persisted the moment it finishes rather than at the end
    // of its batch, so one slow section never hides the ones already written.
    const runOne = async (key) => {
      const meta = SECTION_MAP[key];
      const ord = keys.indexOf(key);
      let cancelled = null;
      try {
        const content = await makeSection(key);
        saveSection.run(id, key, meta.heading, meta.icon, content, ord);
        written.push(meta.heading);
        say(id, `✓ ${meta.heading}`);
      } catch (err) {
        const msg = err?.message ?? String(err);
        if (signal.aborted || /cancel|abort/i.test(msg)) {
          cancelled = err;
        } else {
          say(id, `✗ ${meta.heading} — ${msg}`, 'error');
          saveSection.run(id, key, meta.heading, meta.icon, `_This section could not be generated: ${msg}_`, ord);
        }
      }
      done++;
      inFlight.delete(key);
      if (cancelled) throw cancelled;
      setStage(id, stageLabel(), 15 + Math.round((done / keys.length) * 80));
      emit(id, 'section', { key, heading: meta.heading, ord });
    };

    const inFlight = new Set();
    const stageLabel = () =>
      inFlight.size
        ? `Writing: ${[...inFlight].map((k) => SECTION_MAP[k].heading).join(', ')}`
        : `Written ${done} of ${keys.length} sections`;

    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      signal.throwIfAborted();
      const batch = keys.slice(i, i + CONCURRENCY);
      batch.forEach((k) => inFlight.add(k));
      setStage(id, stageLabel(), 15 + Math.round((done / keys.length) * 80));
      await Promise.all(batch.map(runOne));
    }

    setStage(id, 'Finished', 100);
    touchResearch(id, {
      status: 'done',
      tokens_in: usage.in,
      tokens_out: usage.out,
    });
    // Interactive simulators, built from relationships the document actually
    // states. Best-effort: a document with no quantitative content simply has
    // none, and that must never fail the report.
    try {
      touchResearch(id, { stage: 'Building simulators' });
      say(id, 'Looking for relationships worth playing with…');
      const { data: simData, usage: simUsage } = await completeJson({
        system: systemPrompt(audience),
        prompt: simulationsPrompt({ recon, docText, sourceLabel }),
        signal: ctl.signal,
      });
      usage.in += simUsage?.in ?? 0;
      usage.out += simUsage?.out ?? 0;

      const sims = Array.isArray(simData?.simulations) ? simData.simulations : [];
      const kept = [];
      for (const sim of sims.slice(0, 3)) {
        const vars = Array.isArray(sim.vars) ? sim.vars : [];
        const check = validateSimulation(sim.expression, vars);
        if (!check.ok) {
          say(id, `Skipped simulator "${sim.title ?? '?'}": ${check.error}`, 'warn');
          continue;
        }
        kept.push({ ...sim, vars });
      }

      const insSim = db.prepare(
        `INSERT INTO simulations (research_id, ord, title, blurb, expression, output_label, output_unit, vars, insight)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      kept.forEach((sim, i) =>
        insSim.run(
          id,
          i,
          String(sim.title ?? 'Try it').slice(0, 200),
          String(sim.blurb ?? ''),
          String(sim.expression),
          String(sim.output_label ?? 'Result').slice(0, 80),
          String(sim.output_unit ?? '').slice(0, 24),
          JSON.stringify(sim.vars),
          String(sim.insight ?? '')
        )
      );
      if (kept.length) say(id, `Built ${kept.length} interactive simulator${kept.length > 1 ? 's' : ''}.`);
    } catch (err) {
      if (ctl.signal.aborted) throw err;
      say(id, `Simulators skipped: ${err.message}`, 'warn');
    }

    // Interactive 3D. Same contract as the simulators: best effort, never fatal,
    // and nothing reaches the renderer that has not been validated.
    try {
      touchResearch(id, { stage: 'Building 3D scenes' });
      say(id, 'Looking for ideas worth seeing in 3D…');
      const { data: sceneData, usage: sceneUsage } = await completeJson({
        system: systemPrompt(audience),
        prompt: scenes3dPrompt({ recon, docText, sourceLabel }),
        signal: ctl.signal,
      });
      usage.in += sceneUsage?.in ?? 0;
      usage.out += sceneUsage?.out ?? 0;

      const scenes = Array.isArray(sceneData?.scenes) ? sceneData.scenes : [];
      const keptScenes = [];
      for (const sc of scenes.slice(0, 2)) {
        const check = validateScene3d(sc);
        if (!check.ok) {
          say(id, `Skipped 3D scene "${sc.title ?? '?'}": ${check.error}`, 'warn');
          continue;
        }
        keptScenes.push(sc);
      }

      const insScene = db.prepare(
        `INSERT INTO scenes3d (research_id, ord, title, blurb, kind, spec, vars, insight)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      keptScenes.forEach((sc, i) =>
        insScene.run(
          id,
          i,
          String(sc.title ?? '3D view').slice(0, 200),
          String(sc.blurb ?? ''),
          String(sc.kind ?? sc.spec?.kind),
          JSON.stringify(sc.spec ?? {}),
          JSON.stringify(Array.isArray(sc.vars) ? sc.vars : []),
          String(sc.insight ?? '')
        )
      );
      if (keptScenes.length) say(id, `Built ${keptScenes.length} interactive 3D scene${keptScenes.length > 1 ? 's' : ''}.`);
    } catch (err) {
      if (ctl.signal.aborted) throw err;
      say(id, `3D scenes skipped: ${err.message}`, 'warn');
    }

    say(id, 'Report ready.');
    emit(id, 'status', { status: 'done' });
    emit(id, 'done', {});
  } catch (err) {
    const cancelled = ctl.signal.aborted || /cancel|abort/i.test(err?.message ?? '');
    const message = cancelled ? 'Cancelled.' : err?.message ?? String(err);
    touchResearch(id, {
      status: cancelled ? 'cancelled' : 'error',
      error: message,
      stage: cancelled ? 'Cancelled' : 'Failed',
    });
    say(id, message, cancelled ? 'warn' : 'error');
    emit(id, 'status', { status: cancelled ? 'cancelled' : 'error', error: message });
    emit(id, 'done', {});
  } finally {
    running.delete(id);
  }
}

export function start(researchId) {
  const id = Number(researchId);
  if (running.has(id)) return false;
  touchResearch(id, { status: 'queued', progress: 0, stage: 'Queued', error: '' });
  setImmediate(() => runPipeline(id));
  return true;
}
