import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSetting } from './db.js';

const CALL_TIMEOUT_MS = 15 * 60 * 1000;

class ProviderError extends Error {}

/* ------------------------------------------------------------ process glue */

function run(cmd, args, { input, timeout = CALL_TIMEOUT_MS, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      return reject(new ProviderError(`Could not start "${cmd}": ${err.message}`));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new ProviderError(`"${cmd}" timed out after ${Math.round(timeout / 1000)}s`));
      }
    }, timeout);

    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new ProviderError('cancelled'));
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new ProviderError(
          err.code === 'ENOENT'
            ? `"${cmd}" is not installed or not on PATH.`
            : `${cmd} failed: ${err.message}`
        )
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code !== 0) {
        // CLIs sometimes report the real reason on stdout, not stderr
        const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ').slice(-900);
        reject(
          new ProviderError(
            `${cmd} exited with code ${code}${detail ? `: ${detail}` : ' with no output (it may be rate-limited or out of quota — try again in a moment)'}`
          )
        );
      } else {
        resolve({ stdout, stderr });
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/* --------------------------------------------------------------- providers */

async function callClaudeCli({ system, prompt, signal }) {
  const model = getSetting('claude_model', '').trim();
  const args = ['-p', '--output-format', 'text'];
  if (model) args.push('--model', model);
  if (system) args.push('--append-system-prompt', system);
  const { stdout } = await run('claude', args, { input: prompt, signal });
  return stdout.trim();
}

async function callCodexCli({ system, prompt, signal }) {
  const model = getSetting('codex_model', '').trim();
  const outFile = path.join(os.tmpdir(), `legible-${randomUUID()}.txt`);
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--output-last-message', outFile,
  ];
  if (model) args.push('--model', model);
  args.push('-');

  const full = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  try {
    const { stdout } = await run('codex', args, { input: full, signal });
    const last = await fs.readFile(outFile, 'utf8').catch(() => '');
    return (last.trim() || stdout.trim());
  } finally {
    fs.unlink(outFile).catch(() => {});
  }
}

async function callAnthropicApi({ system, prompt, signal }) {
  const key = (getSetting('anthropic_api_key', '') || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new ProviderError('No Anthropic API key set. Add one in Settings, or switch provider.');
  const model = getSetting('anthropic_model', 'claude-opus-5').trim() || 'claude-opus-5';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError(`Anthropic API error ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text: text.trim(),
    usage: { in: json.usage?.input_tokens ?? 0, out: json.usage?.output_tokens ?? 0 },
  };
}

const PROVIDERS = {
  claude: { label: 'Claude Code CLI', call: callClaudeCli },
  codex: { label: 'Codex CLI', call: callCodexCli },
  anthropic: { label: 'Anthropic API', call: callAnthropicApi },
};

export function providerLabel(name) {
  return PROVIDERS[name]?.label ?? name;
}

export function activeProvider() {
  const p = getSetting('provider', 'claude');
  return PROVIDERS[p] ? p : 'claude';
}

export function activeModel(provider = activeProvider()) {
  if (provider === 'anthropic') return getSetting('anthropic_model', 'claude-opus-5');
  return getSetting(`${provider}_model`, '') || '(cli default)';
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new ProviderError('cancelled'));
    }, { once: true });
  });

/**
 * Single completion. Returns { text, usage }.
 * Transient CLI failures (a crashed launch, a momentary rate limit) get one
 * retry — they are common enough that failing a whole section over one is wrong.
 */
export async function complete({ system, prompt, signal, provider = activeProvider() }) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new ProviderError(`Unknown provider "${provider}"`);

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(4000, signal);
    try {
      const out = await impl.call({ system, prompt, signal });
      const result = typeof out === 'string' ? { text: out, usage: { in: 0, out: 0 } } : out;
      if (!result.text) throw new ProviderError('The model returned an empty response.');
      return result;
    } catch (err) {
      lastError = err;
      const fatal =
        signal?.aborted ||
        /cancelled|not installed|not on PATH|No Anthropic API key|Unknown provider/i.test(err.message);
      if (fatal) throw err;
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------ JSON helpers */

/** Models like to wrap JSON in prose or fences. Dig it out. */
export function parseJsonLoose(raw) {
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* keep digging */
  }

  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in the model response.');
  const open = s[start];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close && --depth === 0) {
      return JSON.parse(s.slice(start, i + 1));
    }
  }
  throw new Error('Model response contained truncated or malformed JSON.');
}

/** Completion that must come back as JSON, with one repair attempt. */
export async function completeJson({ system, prompt, signal, provider }) {
  const guard =
    '\n\nRespond with raw JSON only. No prose before or after, no markdown code fences.';
  const first = await complete({ system, prompt: prompt + guard, signal, provider });
  try {
    return { data: parseJsonLoose(first.text), usage: first.usage };
  } catch (err) {
    const repair = await complete({
      system: 'You convert malformed output into strictly valid JSON. Output JSON only.',
      prompt:
        `The following was supposed to be valid JSON but failed to parse (${err.message}). ` +
        `Return the same content as strictly valid JSON, preserving all of the text:\n\n${first.text}` +
        guard,
      signal,
      provider,
    });
    return {
      data: parseJsonLoose(repair.text),
      usage: {
        in: first.usage.in + repair.usage.in,
        out: first.usage.out + repair.usage.out,
      },
    };
  }
}
