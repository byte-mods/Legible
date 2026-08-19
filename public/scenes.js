/**
 * Animated scene renderer.
 *
 * One drawScene() is used by both surfaces: the small canvas inside each card in
 * the live reel, and the 1080x1920 canvas the video exporter records. Everything
 * is drawn in a 0..1 normalised space and scaled, so the same code produces the
 * same picture at any size.
 *
 * `t` is seconds since the card appeared.
 */

const ACCENT = '#7c5cff';
const ACCENT_2 = '#22d3ee';
const INK = '#e9eaee';
const MUTED = '#9aa0ad';
const GOOD = '#34d399';
const BAD = '#f87171';

export const SCENE_FONT =
  '-apple-system, "Helvetica Neue", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Arabic", "Hiragino Sans", "PingFang SC", "Apple SD Gothic Neo", sans-serif';
const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

const easeOut = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** Fade/rise a group of elements in one after another. */
function stagger(t, i, delay = 0.14, dur = 0.5) {
  return easeOut((t - i * delay) / dur);
}

function textFit(ctx, text, maxWidth, size, weight = '600') {
  let s = size;
  ctx.font = `${weight} ${s}px ${SCENE_FONT}`;
  while (ctx.measureText(text).width > maxWidth && s > size * 0.55) {
    s -= 1;
    ctx.font = `${weight} ${s}px ${SCENE_FONT}`;
  }
  return s;
}

function label(ctx, text, x, y, maxWidth, size, color = MUTED, weight = '600') {
  if (!text) return;
  textFit(ctx, String(text), maxWidth, size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text), x, y);
}

function emoji(ctx, ch, x, y, size) {
  ctx.font = `${size}px ${EMOJI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch || '✦', x, y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function chip(ctx, x, y, w, h, { fill = 'rgba(255,255,255,.04)', stroke = 'rgba(255,255,255,.12)', lw = 1.5 } = {}) {
  roundRect(ctx, x, y, w, h, Math.min(18, h * 0.28));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

function arrow(ctx, x1, y1, x2, y2, color, lw) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const a = Math.atan2(y2 - y1, x2 - x1);
  const head = lw * 3.2;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(a - 0.42), y2 - head * Math.sin(a - 0.42));
  ctx.lineTo(x2 - head * Math.cos(a + 0.42), y2 - head * Math.sin(a + 0.42));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/**
 * Ambient layer: slow drifting motes behind every scene. Nothing here carries
 * meaning — it exists so a card is never visually still, which is most of the
 * difference between "a slide" and "a reel".
 */
function drawAmbient(ctx, W, H, t) {
  const n = 18;
  ctx.save();
  for (let i = 0; i < n; i++) {
    // deterministic pseudo-random placement, so motes keep their identity
    const seed = i * 127.1;
    const bx = ((Math.sin(seed) * 43758.5) % 1 + 1) % 1;
    const by = ((Math.sin(seed * 1.7) * 27183.3) % 1 + 1) % 1;
    const speed = 0.06 + (i % 5) * 0.02;
    const drift = 0.5 + 0.5 * Math.sin(t * speed * 6 + i);

    const x = bx * W + Math.sin(t * 0.4 + i) * W * 0.02;
    const y = ((by + t * speed * 0.06) % 1) * H;
    const r = (1 + (i % 3)) * (Math.min(W, H) / 320);

    ctx.globalAlpha = 0.05 + 0.13 * drift;
    ctx.fillStyle = i % 3 === 0 ? '#22d3ee' : '#7c5cff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** A soft breathing halo that keeps the centre of a scene alive. */
function drawHalo(ctx, W, H, t, cx = W / 2, cy = H / 2) {
  const pulse = 0.5 + 0.5 * Math.sin(t * 1.1);
  const r = Math.min(W, H) * (0.34 + 0.05 * pulse);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `rgba(124,92,255,${0.1 + 0.05 * pulse})`);
  g.addColorStop(1, 'rgba(124,92,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/* ────────────────────────────── scene types ────────────────────────────── */

function drawActors(ctx, s, W, H, t, U) {
  const items = (s.items ?? []).slice(0, 3);
  if (!items.length) return;

  const slotW = W / items.length;
  const cy = H * 0.5;

  items.forEach((it, i) => {
    const p = stagger(t, i, 0.22, 0.55);
    if (p <= 0) return;
    const cx = slotW * (i + 0.5);

    ctx.save();
    ctx.globalAlpha = p;
    // a gentle idle bob so the characters feel alive
    const bob = Math.sin(t * 1.7 + i * 1.3) * U * 0.5;
    ctx.translate(0, (1 - p) * U * 1.4 + bob);

    // a ring that keeps breathing under each character
    const ring = (t * 0.7 + i * 0.4) % 1;
    ctx.save();
    ctx.globalAlpha = p * (1 - ring) * 0.5;
    ctx.strokeStyle = i % 2 ? '#22d3ee' : '#7c5cff';
    ctx.lineWidth = U * 0.14;
    ctx.beginPath();
    ctx.arc(cx, cy, U * (2.2 + ring * 1.9), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(124,92,255,.45)';
    ctx.shadowBlur = U * 1.6;
    emoji(ctx, it.emoji, cx, cy, U * 4.6);
    ctx.restore();

    label(ctx, it.label, cx, cy + U * 3.6, slotW * 0.86, U * 1.15, INK, '650');
    ctx.restore();
  });

  // dashed connectors between neighbours, drawn only in the gaps so they never
  // run under an emoji
  if (items.length >= 2) {
    const p = clamp01((t - 0.55) / 0.5);
    if (p > 0) {
      ctx.save();
      ctx.globalAlpha = p;
      const pulse = 0.55 + 0.45 * Math.sin(t * 2.6);
      ctx.setLineDash([U * 0.45, U * 0.45]);
      ctx.lineDashOffset = -t * U * 3;
      ctx.strokeStyle = `rgba(34,211,238,${0.35 + 0.35 * pulse})`;
      ctx.lineWidth = U * 0.24;
      for (let i = 0; i < items.length - 1; i++) {
        const x1 = slotW * (i + 0.5) + U * 2.6;
        const x2 = slotW * (i + 1.5) - U * 2.6;
        if (x2 - x1 < U * 0.6) continue;
        ctx.beginPath();
        ctx.moveTo(x1, cy);
        ctx.lineTo(x2, cy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // one caption for the whole relationship, above the row and full width
      if (s.link) label(ctx, s.link, W / 2, H * 0.08, W * 0.92, U * 1.05, ACCENT_2, '600');
      ctx.restore();
    }
  }
}

function drawFlow(ctx, s, W, H, t, U) {
  const items = (s.items ?? []).slice(0, 4);
  if (!items.length) return;

  const pad = U * 1.2;
  const gap = U * 1.5;
  const boxW = (W - pad * 2 - gap * (items.length - 1)) / items.length;
  const boxH = H * 0.52;
  const top = H * 0.16;

  items.forEach((it, i) => {
    const p = stagger(t, i, 0.2, 0.5);
    if (p <= 0) return;
    const x = pad + i * (boxW + gap);

    ctx.save();
    ctx.globalAlpha = p;
    ctx.translate(0, (1 - p) * U);
    const breathe = 0.5 + 0.5 * Math.sin(t * 1.6 - i * 0.7);
    chip(ctx, x, top, boxW, boxH, {
      fill: `rgba(255,255,255,${0.035 + 0.035 * breathe})`,
      stroke: `rgba(124,92,255,${0.18 + 0.3 * breathe})`,
      lw: U * 0.1,
    });
    emoji(ctx, it.emoji, x + boxW / 2, top + boxH * 0.36, Math.min(U * 3.2, boxW * 0.5));
    label(ctx, it.label, x + boxW / 2, top + boxH * 0.76, boxW * 0.88, U * 1.05, INK, '600');
    ctx.restore();

    if (i < items.length - 1) {
      const ap = clamp01((t - (i + 1) * 0.2) / 0.4);
      if (ap > 0) {
        ctx.save();
        ctx.globalAlpha = ap;
        arrow(ctx, x + boxW + gap * 0.15, top + boxH / 2, x + boxW + gap * 0.85, top + boxH / 2, MUTED, U * 0.22);
        ctx.restore();
      }
    }
  });

  // a packet travelling the whole chain, looping
  const travel = (t % 3.2) / 3.2;
  if (t > 0.9) {
    const x = pad + travel * (W - pad * 2);
    const y = top + boxH / 2;
    const g = ctx.createRadialGradient(x, y, 0, x, y, U * 1.5);
    g.addColorStop(0, 'rgba(34,211,238,.95)');
    g.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, U * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCompare(ctx, s, W, H, t, U) {
  const panels = [
    { ...(s.left ?? {}), side: 0 },
    { ...(s.right ?? {}), side: 1 },
  ];
  const gap = U * 1.1;          // outer margin
  const mid = U * 2.4;          // centre channel, wide enough for the badge
  const boxW = (W - gap * 2 - mid) / 2;
  const boxH = H * 0.62;
  const top = H * 0.12;

  panels.forEach((p, i) => {
    const a = stagger(t, i, 0.28, 0.55);
    if (a <= 0) return;
    const x = gap + i * (boxW + mid);
    const good = p.verdict === 'good';
    const bad = p.verdict === 'bad';
    const tint = good ? GOOD : bad ? BAD : ACCENT;

    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate((1 - a) * (i ? U : -U), 0);
    chip(ctx, x, top, boxW, boxH, {
      fill: good ? 'rgba(52,211,153,.07)' : bad ? 'rgba(248,113,113,.06)' : 'rgba(255,255,255,.04)',
      stroke: good ? 'rgba(52,211,153,.4)' : bad ? 'rgba(248,113,113,.35)' : 'rgba(255,255,255,.12)',
      lw: U * 0.14,
    });
    emoji(ctx, p.emoji, x + boxW / 2, top + boxH * 0.34, U * 3.4);
    label(ctx, p.label, x + boxW / 2, top + boxH * 0.68, boxW * 0.85, U * 1.1, INK, '650');
    if (good || bad) {
      ctx.font = `700 ${U * 1.5}px ${SCENE_FONT}`;
      ctx.fillStyle = tint;
      ctx.textAlign = 'center';
      ctx.fillText(good ? '✓' : '✕', x + boxW / 2, top + boxH * 0.9);
    }
    ctx.restore();
  });

  // "vs" sits in its own badge so it never collides with a panel edge
  const vp = clamp01((t - 0.7) / 0.4);
  if (vp > 0) {
    const cy = top + boxH / 2;
    ctx.save();
    ctx.globalAlpha = vp;
    ctx.beginPath();
    ctx.arc(W / 2, cy, mid * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0c11';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = U * 0.1;
    ctx.stroke();
    label(ctx, 'vs', W / 2, cy, mid * 0.7, U * 1.05, MUTED, '700');
    ctx.restore();
  }
}

function drawGrid(ctx, s, W, H, t, U) {
  const n = Math.max(3, Math.min(8, Number(s.size) || 6));
  const side = Math.min(W * 0.62, H * 0.72);
  const cell = side / n;
  const x0 = (W - side) / 2;
  const y0 = H * 0.1;
  const pattern = s.pattern ?? 'all';

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const order =
        pattern === 'diagonal' ? (r === c ? r : -1) : pattern === 'row' ? r : r * n + c;
      const on = order >= 0 && t > 0.35 + order * (pattern === 'all' ? 0.035 : 0.14);
      // a diagonal wave of light keeps sweeping the grid once it is filled
      const wave = Math.sin(t * 2.4 - (r + c) * 0.55);
      const pulse = 0.6 + 0.4 * wave;

      const x = x0 + c * cell + cell * 0.08;
      const y = y0 + r * cell + cell * 0.08;
      const w = cell * 0.84;

      roundRect(ctx, x, y, w, w, w * 0.22);
      if (on) {
        ctx.fillStyle = `rgba(124,92,255,${0.28 + 0.5 * pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(34,211,238,${0.35 * pulse})`;
        ctx.lineWidth = Math.max(1, U * 0.08);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.045)';
        ctx.fill();
      }
    }
  }
  label(ctx, s.label, W / 2, y0 + side + U * 1.6, W * 0.9, U * 1.15, INK, '600');
}

function drawSplit(ctx, s, W, H, t, U) {
  const count = Math.max(2, Math.min(12, Number(s.count) || 4));
  const cy = H * 0.44;
  const leftX = W * 0.12;
  const rightX = W * 0.88;
  const midX = W * 0.5;
  const spread = Math.min(H * 0.34, count * U * 0.62);

  ctx.save();
  ctx.globalAlpha = stagger(t, 0, 0, 0.4);
  ctx.beginPath();
  ctx.arc(leftX, cy, U * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  label(ctx, s.from, leftX, cy + U * 2.4, W * 0.24, U, MUTED, '600');
  ctx.restore();

  for (let i = 0; i < count; i++) {
    const p = stagger(t, i, 0.05, 0.5);
    if (p <= 0) continue;
    const y = cy + (count === 1 ? 0 : (i / (count - 1) - 0.5) * spread * 2);

    ctx.save();
    ctx.globalAlpha = p * 0.85;
    ctx.strokeStyle = `rgba(124,92,255,${0.35 + 0.3 * Math.sin(t * 2.4 + i)})`;
    ctx.lineWidth = U * 0.13;
    ctx.beginPath();
    ctx.moveTo(leftX, cy);
    ctx.quadraticCurveTo(midX * 0.72, y, midX, y);
    ctx.moveTo(midX, y);
    ctx.quadraticCurveTo(rightX * 0.94, y, rightX, cy);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(midX, y, U * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT_2;
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = clamp01((t - 0.6) / 0.5);
  ctx.beginPath();
  ctx.arc(rightX, cy, U * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = ACCENT;
  ctx.fill();
  label(ctx, s.to, rightX, cy + U * 2.4, W * 0.24, U, MUTED, '600');
  ctx.restore();

  label(ctx, s.label, W / 2, H * 0.92, W * 0.9, U * 1.15, INK, '650');
}

function drawStack(ctx, s, W, H, t, U) {
  const count = Math.max(2, Math.min(8, Number(s.count) || 4));
  const boxW = W * 0.52;
  const x = (W - boxW) / 2;
  const areaH = H * 0.62;
  const boxH = Math.min(U * 1.9, (areaH / count) * 0.82);
  const gap = (areaH - boxH * count) / Math.max(1, count - 1);
  const bottomY = H * 0.78;

  label(ctx, s.bottom, W / 2, H * 0.9, W * 0.8, U, MUTED, '600');

  for (let i = 0; i < count; i++) {
    const p = stagger(t, i, 0.12, 0.45);
    if (p <= 0) continue;
    const y = bottomY - i * (boxH + gap) - boxH;

    ctx.save();
    ctx.globalAlpha = p;
    ctx.translate(0, (1 - p) * U * 2);
    // a pulse that climbs the stack, so depth reads as flow
    const glow = 0.5 + 0.5 * Math.sin(t * 2.2 - i * 0.85);
    chip(ctx, x, y, boxW, boxH, {
      fill: `rgba(124,92,255,${0.1 + 0.12 * glow})`,
      stroke: `rgba(124,92,255,${0.35 + 0.3 * glow})`,
      lw: U * 0.12,
    });
    ctx.restore();
  }

  const tp = clamp01((t - count * 0.12) / 0.5);
  if (tp > 0) {
    ctx.save();
    ctx.globalAlpha = tp;
    label(ctx, s.top, W / 2, bottomY - count * (boxH + gap) - U * 0.6, W * 0.8, U, MUTED, '600');
    ctx.restore();
  }
  label(ctx, s.label, W / 2, H * 0.06, W * 0.9, U * 1.15, INK, '650');
}

function drawBars(ctx, s, W, H, t, U) {
  const items = (s.items ?? []).slice(0, 4);
  if (!items.length) return;
  const max = Math.max(...items.map((i) => Math.abs(Number(i.value) || 0)), 1);

  const pad = U * 1.4;
  const gap = U * 1.1;
  const barW = (W - pad * 2 - gap * (items.length - 1)) / items.length;
  const baseY = H * 0.78;
  const maxH = H * 0.56;

  items.forEach((it, i) => {
    const p = stagger(t, i, 0.16, 0.7);
    const v = (Number(it.value) || 0) / max;
    const h = maxH * v * p;
    const x = pad + i * (barW + gap);

    const g = ctx.createLinearGradient(0, baseY - h, 0, baseY);
    if (it.highlight) {
      g.addColorStop(0, ACCENT_2);
      g.addColorStop(1, ACCENT);
    } else {
      g.addColorStop(0, 'rgba(255,255,255,.22)');
      g.addColorStop(1, 'rgba(255,255,255,.08)');
    }
    roundRect(ctx, x, baseY - h, barW, h, Math.min(U * 0.6, barW * 0.2));
    ctx.fillStyle = g;
    ctx.fill();

    // the winning bar keeps a light travelling up it
    if (it.highlight && h > 4) {
      const sweep = (t * 0.5) % 1;
      const sy = baseY - h * sweep;
      const sg = ctx.createLinearGradient(0, sy - U, 0, sy + U);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, `rgba(255,255,255,${0.3 * (1 - sweep)})`);
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      roundRect(ctx, x, baseY - h, barW, h, Math.min(U * 0.6, barW * 0.2));
      ctx.clip();
      ctx.fillStyle = sg;
      ctx.fillRect(x, sy - U, barW, U * 2);
      ctx.restore();
    }

    if (p > 0.2) {
      const shown = (Number(it.value) || 0) * p;
      const dec = String(it.value).includes('.') ? 1 : 0;
      label(
        ctx,
        `${shown.toFixed(dec)}${s.unit ? ' ' + s.unit : ''}`,
        x + barW / 2,
        baseY - h - U * 1.1,
        barW * 1.3,
        U * 1.1,
        it.highlight ? ACCENT_2 : INK,
        '700'
      );
    }
    label(ctx, it.label, x + barW / 2, baseY + U * 1.5, barW * 1.25, U * 0.95, MUTED, '600');
  });

  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  ctx.lineWidth = Math.max(1, U * 0.06);
  ctx.beginPath();
  ctx.moveTo(pad * 0.5, baseY);
  ctx.lineTo(W - pad * 0.5, baseY);
  ctx.stroke();
}


/* ───────────────────────── demonstration scenes ─────────────────────────
   The other scene types are diagrams: they arrange things and label them.
   These SHOW the thing happening — an object accelerating under a force, two
   bodies colliding, something falling and bouncing. Every mode is a short loop
   with a beat of stillness at the end, so a viewer sees the whole action and
   then reads the labels.                                                     */

/** Sweep a loop from 0..1 with a pause before it repeats. */
function loopPhase(t, period, hold = 0.25) {
  const cycle = (t % period) / period;
  return clamp01(cycle / (1 - hold));
}

/** Motion streaks trailing a moving object — the classic "this is fast" cue. */
function speedLines(ctx, x, y, size, strength, dir = -1) {
  if (strength <= 0.02) return;
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${0.1 + 0.35 * strength})`;
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const off = (i - 1.5) * size * 0.32;
    const len = size * (0.5 + strength * 1.5) * (0.6 + (i % 2) * 0.5);
    ctx.lineWidth = size * 0.055;
    ctx.beginPath();
    ctx.moveTo(x + dir * size * 0.62, y + off);
    ctx.lineTo(x + dir * (size * 0.62 + len), y + off);
    ctx.stroke();
  }
  ctx.restore();
}

/** A labelled force arrow pushing a body. */
function forceArrow(ctx, x, y, len, U, text, colour = '#f472b6', labelBelow = false, clear = 1.25) {
  // len is signed — a leftward arrow is negative, so compare on magnitude
  if (Math.abs(len) < U * 0.4) return;
  arrow(ctx, x, y, x + len, y, colour, U * 0.22);
  if (!text) return;
  // the arrow is often short; give the caption room regardless of its length
  const ly = y + (labelBelow ? U * clear : -U * clear);
  label(ctx, text, x + len / 2, ly, Math.max(Math.abs(len) * 2, U * 5), U * 0.95, colour, '700');
}

function impactBurst(ctx, x, y, U, strength) {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalAlpha = strength;
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r0 = U * (0.7 + 1.4 * (1 - strength));
    const r1 = r0 + U * 0.8 * strength;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = U * 0.16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.restore();
}

const groundY = (H) => H * 0.72;

function drawGround(ctx, W, H, U) {
  const y = groundY(H);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = U * 0.07;
  ctx.beginPath();
  ctx.moveTo(W * 0.04, y);
  ctx.lineTo(W * 0.96, y);
  ctx.stroke();
  ctx.restore();
}

function drawDemo(ctx, s, W, H, t, U) {
  const mode = s.mode ?? 'accelerate';
  const a = s.actors?.[0] ?? {};
  const b = s.actors?.[1] ?? {};
  const size = U * 3.6;
  const gy = groundY(H);

  if (mode !== 'orbit' && mode !== 'grow') drawGround(ctx, W, H, U);

  if (mode === 'accelerate') {
    // constant force -> the gap covered grows with the square of time
    const p = loopPhase(t, 3.4);
    const x = W * 0.16 + (W * 0.66) * p * p;
    const speed = Math.min(1, p * 1.6);

    speedLines(ctx, x, gy - size * 0.55, size, speed);
    forceArrow(ctx, x - size * 0.75, gy - size * 0.55, -U * (0.8 + 1.5 * speed), U, s.force || 'force', '#f472b6');
    emoji(ctx, a.emoji || '🚗', x, gy - size * 0.55, size);
    if (a.label) label(ctx, a.label, x, gy + U * 1.1, W * 0.4, U, INK, '650');
    label(ctx, s.caption || 'same push, faster and faster', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
  }

  if (mode === 'collide') {
    const period = 3.6;
    const p = loopPhase(t, period);
    const meet = 0.45;
    const leftHome = W * 0.14;
    const rightHome = W * 0.86;
    const centreL = W * 0.44;
    const centreR = W * 0.56;

    let xa, xb, burst = 0;
    if (p < meet) {
      const k = p / meet;
      xa = leftHome + (centreL - leftHome) * k;
      xb = rightHome + (centreR - rightHome) * k;
    } else {
      const k = (p - meet) / (1 - meet);
      const ease = 1 - Math.pow(1 - k, 2);
      xa = centreL - (centreL - leftHome) * ease * 0.75;
      xb = centreR + (rightHome - centreR) * ease * 0.75;
      burst = Math.max(0, 1 - k * 3.2);
    }

    speedLines(ctx, xa, gy - size * 0.55, size, p < meet ? 0.7 : 0.4, p < meet ? -1 : 1);
    speedLines(ctx, xb, gy - size * 0.55, size, p < meet ? 0.7 : 0.4, p < meet ? 1 : -1);
    emoji(ctx, a.emoji || '🚗', xa, gy - size * 0.55, size);
    emoji(ctx, b.emoji || '🚙', xb, gy - size * 0.55, size);
    impactBurst(ctx, (xa + xb) / 2, gy - size * 0.55, U, burst);

    if (a.label) label(ctx, a.label, xa, gy + U * 1.1, W * 0.3, U * 0.95, INK, '650');
    if (b.label) label(ctx, b.label, xb, gy + U * 1.1, W * 0.3, U * 0.95, INK, '650');
    label(ctx, s.caption || 'equal and opposite', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
  }

  if (mode === 'push') {
    const p = loopPhase(t, 3.2);
    const pusherX = W * 0.18 + W * 0.28 * p;
    const boxX = pusherX + size * 1.25;

    emoji(ctx, a.emoji || '🧍', pusherX, gy - size * 0.55, size * 0.9);
    forceArrow(ctx, pusherX + size * 0.42, gy - size * 0.55, size * 0.72, U, s.force || 'push', '#f472b6', false, 2.5);
    emoji(ctx, b.emoji || '📦', boxX, gy - size * 0.5, size);
    speedLines(ctx, boxX, gy - size * 0.5, size, p * 0.8);

    if (b.label) label(ctx, b.label, boxX, gy + U * 1.1, W * 0.35, U * 0.95, INK, '650');
    label(ctx, s.caption || 'push harder, it moves faster', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
  }

  if (mode === 'fall') {
    const period = 2.6;
    const p = loopPhase(t, period, 0.18);
    // fall, then a decaying bounce
    const topY = H * 0.26;
    let y;
    if (p < 0.62) {
      const k = p / 0.62;
      y = topY + (gy - size * 0.5 - topY) * k * k;
    } else {
      const k = (p - 0.62) / 0.38;
      const h = Math.sin(k * Math.PI) * (gy - topY) * 0.22 * (1 - k);
      y = gy - size * 0.5 - h;
    }
    const x = W * 0.5;

    forceArrow(ctx, x + size * 0.72, y, U * 1.3, U, s.force || 'gravity', '#f472b6', true);
    ctx.save();
    ctx.rotate(0);
    emoji(ctx, a.emoji || '🍎', x, y, size);
    ctx.restore();
    impactBurst(ctx, x, gy - size * 0.2, U, p > 0.6 && p < 0.72 ? 1 - (p - 0.6) / 0.12 : 0);
    label(ctx, s.caption || 'pulled down, always', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
    if (a.label) label(ctx, a.label, x, gy + U * 1.1, W * 0.4, U, INK, '650');
  }

  if (mode === 'orbit') {
    const cx = W / 2;
    const cy = H * 0.56;   // sits low enough that the orbiter clears the caption
    // size each axis independently, or a wide short canvas squashes the orbit
    // until the two bodies overlap
    const rx = W * 0.31;
    const ry = H * 0.2;
    const ang = t * 0.9;
    const x = cx + Math.cos(ang) * rx;
    const y = cy + Math.sin(ang) * ry;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.13)';
    ctx.lineWidth = U * 0.07;
    ctx.setLineDash([U * 0.4, U * 0.4]);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    emoji(ctx, b.emoji || '☀️', cx, cy, size * 1.1);
    arrow(ctx, x, y, cx + (x - cx) * 0.35, cy + (y - cy) * 0.35, '#f472b6', U * 0.16);
    emoji(ctx, a.emoji || '🌍', x, y, size * 0.8);
    label(ctx, s.caption || 'always falling inward', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
  }

  if (mode === 'grow') {
    const p = loopPhase(t, 3.2);
    const cx = W / 2;
    const cy = H * 0.46;
    const k = 0.5 + 1.5 * p;

    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = U * 0.1;
    ctx.beginPath();
    ctx.arc(cx, cy, size * k * 0.75, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    emoji(ctx, a.emoji || '🎈', cx, cy, size * k);
    label(ctx, s.caption || 'it scales up fast', W / 2, H * 0.1, W * 0.9, U * 1.05, ACCENT_2, '650');
    if (a.label) label(ctx, a.label, cx, H * 0.86, W * 0.7, U, INK, '650');
  }
}

const RENDERERS = {
  demo: drawDemo,
  actors: drawActors,
  flow: drawFlow,
  compare: drawCompare,
  grid: drawGrid,
  split: drawSplit,
  stack: drawStack,
  bars: drawBars,
};

export const SCENE_TYPES = Object.keys(RENDERERS);

/**
 * Draw a scene into the box (0,0,W,H) of ctx. `t` is seconds since the card
 * appeared. Returns false if there was nothing to draw.
 */
export function drawScene(ctx, scene, W, H, t) {
  const fn = scene && RENDERERS[scene.type];
  if (!fn) return false;
  const U = Math.min(W, H) / 12; // one unit, so scenes scale with the box
  ctx.save();
  ctx.textBaseline = 'middle';
  try {
    drawHalo(ctx, W, H, Math.max(0, t));
    drawAmbient(ctx, W, H, Math.max(0, t));
    fn(ctx, scene, W, H, Math.max(0, t), U);
  } catch (err) {
    // a scene that throws must not take the card down with it, but silently
    // swallowing it once cost hours — say so
    console.error('scene render failed', scene?.type, err);
    ctx.restore();
    return false;
  }
  ctx.restore();
  return true;
}
