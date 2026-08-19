import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();
}

/** arXiv abstract pages are much more useful as the PDF. */
function normaliseUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const m = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/abs\/(.+)$/i);
  if (m) return `https://arxiv.org/pdf/${m[1].replace(/v\d+$/, '')}`;
  return url;
}

async function extractHtml(html, url) {
  const virtualConsole = new VirtualConsole(); // swallow page JS/CSS noise
  const dom = new JSDOM(html, { url, virtualConsole });
  const docTitle = dom.window.document.title || '';
  let article = null;
  try {
    article = new Readability(dom.window.document.cloneNode(true)).parse();
  } catch {
    /* fall through to raw text */
  }
  let text = article?.textContent?.trim();
  if (!text || text.length < 400) {
    const body = dom.window.document.body;
    body?.querySelectorAll('script,style,noscript,svg,nav,footer,header,aside').forEach((n) => n.remove());
    text = body?.textContent ?? '';
  }
  return { text: tidy(text), title: (article?.title || docTitle || '').trim() };
}

async function extractPdfBuffer(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const [result, info] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);
    const meta = info?.info ?? {};
    return {
      text: tidy(result.text || ''),
      title: (meta.Title || '').trim(),
      pages: result.total ?? info?.total ?? 0,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/**
 * Some hosts — arxiv.org is the notable one — reset Node's TLS handshake while
 * serving curl perfectly well. Rather than failing the run, retry through curl.
 */
function curlFetch(url) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `legible-fetch-${randomUUID()}`);
    const child = spawn(
      'curl',
      ['-sSL', '--max-time', '120', '-A', UA, '-H', 'accept: */*', '-o', out, '-w', '%{content_type}\n%{http_code}', url],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let meta = '';
    child.stdout.on('data', (d) => (meta += d));
    child.on('error', () => resolve(null));
    child.on('close', async (code) => {
      if (code !== 0) {
        await fs.unlink(out).catch(() => {});
        return resolve(null);
      }
      const [contentType = '', status = ''] = meta.trim().split('\n');
      try {
        const buffer = await fs.readFile(out);
        resolve(Number(status) >= 200 && Number(status) < 400 && buffer.length
          ? { buffer, contentType: contentType.toLowerCase() }
          : null);
      } catch {
        resolve(null);
      } finally {
        fs.unlink(out).catch(() => {});
      }
    });
  });
}

async function fetchDocument(url) {
  let nativeError;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: (res.headers.get('content-type') || '').toLowerCase(),
      };
    }
    nativeError = `the server answered HTTP ${res.status} ${res.statusText}`;
  } catch (err) {
    nativeError = err.cause?.code ?? err.cause?.message ?? err.message;
  }

  const viaCurl = await curlFetch(url);
  if (viaCurl) return viaCurl;

  throw new Error(`Could not fetch ${url} — ${nativeError}.`);
}

export async function extractFromUrl(rawUrl) {
  const url = normaliseUrl(rawUrl);
  const { buffer, contentType: ctype } = await fetchDocument(url);

  if (ctype.includes('pdf') || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    const out = await extractPdfBuffer(buffer);
    return { ...out, kind: 'pdf', url };
  }
  if (ctype.includes('html') || ctype.includes('xml') || ctype === '') {
    const out = await extractHtml(buffer.toString('utf8'), url);
    return { ...out, kind: 'html', url };
  }
  // plain text, markdown, RFC .txt, source files …
  return { text: tidy(buffer.toString('utf8')), title: '', kind: 'text', url };
}

export async function extractFromFile(filePath, originalName = '') {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === '.pdf' || buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    const out = await extractPdfBuffer(buffer);
    return { ...out, kind: 'pdf' };
  }
  if (ext === '.docx' || ext === '.doc') {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: tidy(value), title: '', kind: 'doc' };
  }
  if (ext === '.html' || ext === '.htm') {
    const out = await extractHtml(buffer.toString('utf8'), 'file://' + filePath);
    return { ...out, kind: 'html' };
  }
  return { text: tidy(buffer.toString('utf8')), title: '', kind: 'text' };
}

/**
 * Long documents get the middle thinned out rather than a hard cut, so the
 * conclusion / references still make it into the model's context.
 */
export function fitToBudget(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = Math.floor(maxChars * 0.62);
  const tail = maxChars - head - 120;
  return {
    text:
      text.slice(0, head) +
      `\n\n[... ${(text.length - head - tail).toLocaleString()} characters of the middle omitted for length ...]\n\n` +
      text.slice(-tail),
    truncated: true,
  };
}

export function guessTitle(text, fallback) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    if (line.length > 12 && line.length < 160 && !/^(abstract|introduction|contents)$/i.test(line)) {
      return line.replace(/\s+/g, ' ');
    }
  }
  return fallback;
}
