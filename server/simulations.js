/**
 * Server-side validation for model-authored simulations.
 *
 * The browser evaluates these formulas with a whitelist-only parser, but a bad
 * formula should never reach the page at all — a slider that shows NaN is worse
 * than no slider. Everything is checked here before it is written to disk.
 */

import { db } from './db.js';

const FUNCTION_NAMES = new Set([
  'abs', 'sqrt', 'cbrt', 'exp', 'ln', 'log', 'log2', 'log10',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'floor', 'ceil', 'round', 'sign', 'min', 'max', 'pow',
]);
const CONSTANT_NAMES = new Set(['pi', 'e']);

/** Every identifier an expression mentions. */
function identifiers(expression) {
  return [...String(expression).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
}

/**
 * Reject anything that is not plain arithmetic over the declared variables.
 * Returns { ok } or { ok: false, error }.
 */
export function validateSimulation(expression, vars) {
  const expr = String(expression ?? '').trim();
  if (!expr) return { ok: false, error: 'no expression' };
  if (expr.length > 400) return { ok: false, error: 'expression is implausibly long' };

  // characters only — no assignment, no comparison, no member access, no calls
  // beyond name(...)
  if (/[^A-Za-z0-9_+\-*/%^(),.\s]/.test(expr)) {
    return { ok: false, error: 'expression contains characters that are not arithmetic' };
  }

  if (!Array.isArray(vars) || vars.length < 1 || vars.length > 4) {
    return { ok: false, error: 'needs between 1 and 4 variables' };
  }

  const keys = new Set();
  for (const v of vars) {
    const key = String(v?.key ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `bad variable key "${key}"` };
    if (FUNCTION_NAMES.has(key.toLowerCase()) || CONSTANT_NAMES.has(key.toLowerCase())) {
      return { ok: false, error: `variable "${key}" collides with a built-in` };
    }
    if (keys.has(key)) return { ok: false, error: `duplicate variable "${key}"` };
    keys.add(key);

    const min = Number(v.min);
    const max = Number(v.max);
    const value = Number(v.value);
    const step = Number(v.step);
    if (![min, max, value].every(Number.isFinite)) {
      return { ok: false, error: `variable "${key}" has a non-numeric range` };
    }
    if (min >= max) return { ok: false, error: `variable "${key}" has min >= max` };
    if (value < min || value > max) {
      return { ok: false, error: `variable "${key}" starts outside its own range` };
    }
    if (Number.isFinite(step) && step <= 0) {
      return { ok: false, error: `variable "${key}" has a non-positive step` };
    }
  }

  // every name must resolve to a declared variable, a whitelisted function, or a constant
  for (const name of identifiers(expr)) {
    const lower = name.toLowerCase();
    if (keys.has(name) || FUNCTION_NAMES.has(lower) || CONSTANT_NAMES.has(lower)) continue;
    return { ok: false, error: `unknown name "${name}" in the formula` };
  }

  // it must actually use what it declares, or the sliders do nothing
  const used = new Set(identifiers(expr));
  const unused = [...keys].filter((k) => !used.has(k));
  if (unused.length) return { ok: false, error: `variable "${unused[0]}" is never used` };

  return { ok: true };
}

export function simulationsFor(researchId) {
  return db
    .prepare('SELECT * FROM simulations WHERE research_id = ? ORDER BY ord')
    .all(Number(researchId))
    .map((row) => {
      let vars = [];
      try {
        vars = JSON.parse(row.vars);
      } catch {
        vars = [];
      }
      return { ...row, vars };
    });
}

/* ═════════════════════════════ 3D scenes ═════════════════════════════ */

const SCENE_KINDS = new Set(['surface', 'molecule', 'projectile', 'orbit', 'transform']);
const ELEMENTS = /^[A-Z][a-z]?$/;

/** Same variable rules as a simulation, minus the "must be used" requirement. */
function checkVars(vars) {
  if (!Array.isArray(vars) || vars.length > 4) return { ok: false, error: 'needs 0 to 4 variables' };
  const keys = new Set();
  for (const v of vars) {
    const key = String(v?.key ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { ok: false, error: `bad variable key "${key}"` };
    if (FUNCTION_NAMES.has(key.toLowerCase()) || CONSTANT_NAMES.has(key.toLowerCase())) {
      return { ok: false, error: `variable "${key}" collides with a built-in` };
    }
    if (keys.has(key)) return { ok: false, error: `duplicate variable "${key}"` };
    keys.add(key);
    const [min, max, value] = [Number(v.min), Number(v.max), Number(v.value)];
    if (![min, max, value].every(Number.isFinite)) return { ok: false, error: `"${key}" has a non-numeric range` };
    if (min >= max) return { ok: false, error: `"${key}" has min >= max` };
    if (value < min || value > max) return { ok: false, error: `"${key}" starts outside its range` };
  }
  return { ok: true, keys };
}

/**
 * Validate a model-authored 3D scene. Anything unrecognised is rejected rather
 * than passed to the renderer, and every *Key must resolve to a declared slider.
 */
export function validateScene3d(scene) {
  const kind = String(scene?.kind ?? scene?.spec?.kind ?? '');
  if (!SCENE_KINDS.has(kind)) return { ok: false, error: `unknown kind "${kind}"` };

  const spec = scene?.spec && typeof scene.spec === 'object' ? scene.spec : {};
  const vars = Array.isArray(scene?.vars) ? scene.vars : [];
  const v = checkVars(vars);
  if (!v.ok) return v;
  const keys = v.keys;

  // every "somethingKey" must name a slider that exists
  for (const [k, val] of Object.entries(spec)) {
    if (!k.endsWith('Key')) continue;
    if (!keys.has(String(val))) return { ok: false, error: `${k} points at missing variable "${val}"` };
  }

  if (kind === 'surface') {
    const expr = String(spec.expression ?? '');
    if (!expr) return { ok: false, error: 'surface needs an expression' };
    if (/[^A-Za-z0-9_+\-*/%^(),.\s]/.test(expr)) {
      return { ok: false, error: 'expression contains non-arithmetic characters' };
    }
    for (const name of identifiers(expr)) {
      const lower = name.toLowerCase();
      if (name === 'x' || name === 'y') continue;
      if (keys.has(name) || FUNCTION_NAMES.has(lower) || CONSTANT_NAMES.has(lower)) continue;
      return { ok: false, error: `unknown name "${name}" in the surface formula` };
    }
    for (const k of ['xMin', 'xMax', 'yMin', 'yMax']) {
      if (spec[k] !== undefined && !Number.isFinite(Number(spec[k]))) {
        return { ok: false, error: `${k} is not a number` };
      }
    }
    if (Number(spec.xMin ?? -3) >= Number(spec.xMax ?? 3)) return { ok: false, error: 'xMin >= xMax' };
    if (Number(spec.yMin ?? -3) >= Number(spec.yMax ?? 3)) return { ok: false, error: 'yMin >= yMax' };
  }

  if (kind === 'molecule') {
    const atoms = Array.isArray(spec.atoms) ? spec.atoms : [];
    if (!atoms.length) return { ok: false, error: 'molecule has no atoms' };
    if (atoms.length > 60) return { ok: false, error: 'too many atoms' };
    for (const a of atoms) {
      if (!ELEMENTS.test(String(a?.el ?? ''))) return { ok: false, error: `bad element "${a?.el}"` };
      if (!['x', 'y', 'z'].every((c) => Number.isFinite(Number(a[c])))) {
        return { ok: false, error: 'an atom has non-numeric coordinates' };
      }
    }
    for (const b of Array.isArray(spec.bonds) ? spec.bonds : []) {
      const [i, j] = [Number(b?.a), Number(b?.b)];
      if (!Number.isInteger(i) || !Number.isInteger(j) || !atoms[i] || !atoms[j]) {
        return { ok: false, error: 'a bond points at a missing atom' };
      }
    }
  }

  return { ok: true };
}

export function scenes3dFor(researchId) {
  return db
    .prepare('SELECT * FROM scenes3d WHERE research_id = ? ORDER BY ord')
    .all(Number(researchId))
    .map((row) => {
      const parse = (t, fallback) => {
        try {
          return JSON.parse(t);
        } catch {
          return fallback;
        }
      };
      return { ...row, spec: parse(row.spec, {}), vars: parse(row.vars, []) };
    });
}
