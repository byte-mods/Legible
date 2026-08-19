/**
 * Password gate.
 *
 * The app shells out to locally-authenticated CLIs and holds everything the user
 * has ever researched, so it must never be reachable without a password once it
 * leaves localhost. No dependencies: scrypt for the password, an HMAC-signed
 * cookie for the session.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, DATA_DIR, getSetting, setSetting } from './db.js';

const COOKIE = 'dr_session';
const SESSION_DAYS = 30;

/* ──────────────────────────────── secrets ──────────────────────────────── */

function secret() {
  let s = getSetting('auth_secret', '');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setSetting('auth_secret', s);
  }
  return s;
}

const hash = (password, salt) =>
  crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

export function setPassword(password) {
  const pw = String(password ?? '');
  if (pw.length < 8) throw new Error('Use at least 8 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  setSetting('auth_salt', salt);
  setSetting('auth_hash', hash(pw, salt));
  // changing the password signs every existing session out
  setSetting('auth_secret', crypto.randomBytes(32).toString('hex'));
  return true;
}

export function hasPassword() {
  return !!(getSetting('auth_hash', '') && getSetting('auth_salt', ''));
}

function passwordMatches(password) {
  const stored = getSetting('auth_hash', '');
  const salt = getSetting('auth_salt', '');
  if (!stored || !salt) return false;
  const got = Buffer.from(hash(password, salt), 'hex');
  const want = Buffer.from(stored, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/**
 * Generate a passphrase on first boot so the app is never unprotected, and leave
 * it somewhere the owner can find it.
 */
const WORDS =
  'anchor amber basalt beacon cedar cobalt cinder delta ember fathom granite harbor indigo ivory jasper kelp lantern marble nectar onyx opal pewter quartz quill ripple saffron slate tundra umber velvet walnut willow zephyr'.split(
    ' '
  );

export function ensurePassword() {
  if (hasPassword()) return null;
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const pass = `${pick()}-${pick()}-${pick()}-${crypto.randomInt(10, 99)}`;
  setPassword(pass);

  const file = path.join(DATA_DIR, 'ACCESS.txt');
  fs.writeFileSync(
    file,
    `Legible access password\n\n    ${pass}\n\n` +
      `Generated ${new Date().toISOString()}.\nChange it in Settings. Delete this file once you have saved the password.\n`,
    { mode: 0o600 }
  );
  return { pass, file };
}

/* ──────────────────────────────── sessions ─────────────────────────────── */

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const want = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );

/* ────────────────────────── brute-force slowdown ───────────────────────── */

const attempts = new Map(); // ip -> { n, until }

function throttled(ip) {
  const a = attempts.get(ip);
  return a?.until && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}

function noteFailure(ip) {
  const a = attempts.get(ip) ?? { n: 0, until: 0 };
  a.n += 1;
  // back off hard after five wrong guesses
  if (a.n >= 5) a.until = Date.now() + Math.min(15 * 60_000, 2 ** (a.n - 5) * 5000);
  attempts.set(ip, a);
}

const clearFailures = (ip) => attempts.delete(ip);

/* ─────────────────────────────── middleware ────────────────────────────── */

const OPEN_PATHS = new Set(['/login', '/api/login', '/login.css']);

export function authMiddleware({ requireAuth }) {
  return (req, res, next) => {
    if (!requireAuth) return next();
    if (OPEN_PATHS.has(req.path)) return next();

    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (verify(token)) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not signed in.', login: true });
    }
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  };
}

export function mountAuthRoutes(app, { requireAuth, secureCookies }) {
  app.post('/api/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    const wait = throttled(ip);
    if (wait) {
      return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    }
    if (!passwordMatches(req.body?.password ?? '')) {
      noteFailure(ip);
      return res.status(401).json({ error: 'Wrong password.' });
    }
    clearFailures(ip);
    res.setHeader(
      'set-cookie',
      [
        `${COOKIE}=${sign({ exp: Date.now() + SESSION_DAYS * 864e5 })}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${SESSION_DAYS * 86400}`,
        secureCookies ? 'Secure' : '',
      ]
        .filter(Boolean)
        .join('; ')
    );
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.json({ ok: true });
  });

  app.post('/api/password', (req, res) => {
    if (requireAuth && !verify(parseCookies(req.headers.cookie)[COOKIE])) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    try {
      setPassword(req.body?.password ?? '');
      res.json({ ok: true, note: 'Password changed. All sessions were signed out.' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}
