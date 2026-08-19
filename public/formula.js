/**
 * A small, safe arithmetic evaluator.
 *
 * The formulas in a simulation come from a language model, so they are untrusted
 * input. Nothing here can reach the page: no eval, no Function, no property
 * access, no calls other than the fixed whitelist below. Anything unrecognised
 * is a parse error rather than something that runs.
 *
 * Supports: + - * / % ^, parentheses, unary minus, variables, and the functions
 * and constants listed in FUNCTIONS / CONSTANTS.
 */

const FUNCTIONS = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

const CONSTANTS = { pi: Math.PI, e: Math.E };

const OPERATORS = {
  '+': { prec: 1, assoc: 'L', fn: (a, b) => a + b },
  '-': { prec: 1, assoc: 'L', fn: (a, b) => a - b },
  '*': { prec: 2, assoc: 'L', fn: (a, b) => a * b },
  '/': { prec: 2, assoc: 'L', fn: (a, b) => a / b },
  '%': { prec: 2, assoc: 'L', fn: (a, b) => a % b },
  '^': { prec: 4, assoc: 'R', fn: (a, b) => a ** b },
};

/* ──────────────────────────────── tokenise ─────────────────────────────── */

function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src);

  while (i < s.length) {
    const c = s[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i));
      if (!m) throw new Error(`Bad number at position ${i}`);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      out.push({ t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c in OPERATORS) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === ',') {
      out.push({ t: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

/* ───────────────────────── shunting-yard → RPN ─────────────────────────── */

function toRpn(tokens) {
  const out = [];
  const stack = [];
  let prev = null;

  for (const tok of tokens) {
    if (tok.t === 'num') {
      out.push(tok);
    } else if (tok.t === 'name') {
      // a name followed by "(" is a call, otherwise it is a value
      out.push(tok);
    } else if (tok.t === 'op') {
      // unary minus/plus: at the start, or straight after another operator or "("
      const unary =
        (tok.v === '-' || tok.v === '+') &&
        (prev === null || prev.t === 'op' || prev.t === '(' || prev.t === ',');
      if (unary) {
        stack.push({ t: 'op', v: tok.v === '-' ? 'u-' : 'u+', prec: 3, assoc: 'R' });
      } else {
        const o1 = OPERATORS[tok.v];
        while (stack.length) {
          const top = stack[stack.length - 1];
          if (top.t !== 'op') break;
          const p2 = top.prec ?? OPERATORS[top.v]?.prec ?? 0;
          if (p2 > o1.prec || (p2 === o1.prec && o1.assoc === 'L')) out.push(stack.pop());
          else break;
        }
        stack.push({ t: 'op', v: tok.v });
      }
    } else if (tok.t === '(') {
      stack.push(tok);
    } else if (tok.t === ',') {
      while (stack.length && stack[stack.length - 1].t !== '(') out.push(stack.pop());
      if (!stack.length) throw new Error('Misplaced comma');
    } else if (tok.t === ')') {
      while (stack.length && stack[stack.length - 1].t !== '(') out.push(stack.pop());
      if (!stack.length) throw new Error('Unbalanced parentheses');
      stack.pop();
      // the name in front of "(" was a function call
      const before = out[out.length - 1];
      if (before?.t === 'name' && stack.length === 0) {
        /* handled during evaluation */
      }
    }
    prev = tok;
  }
  while (stack.length) {
    const top = stack.pop();
    if (top.t === '(') throw new Error('Unbalanced parentheses');
    out.push(top);
  }
  return out;
}

/**
 * Function calls need their argument count, which RPN alone does not carry, so
 * the expression is parsed recursively instead — simpler and less error-prone
 * than threading arity through the shunting yard.
 */
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t, v) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`Expected ${v ?? t}`);
    }
    pos++;
    return tok;
  };

  const parseExpr = (minPrec = 0) => {
    let left = parseUnary();
    while (peek()?.t === 'op') {
      const op = OPERATORS[peek().v];
      if (!op || op.prec < minPrec) break;
      const { v } = tokens[pos++];
      const next = op.assoc === 'L' ? op.prec + 1 : op.prec;
      const right = parseExpr(next);
      const fn = OPERATORS[v].fn;
      const l = left;
      left = (vars) => fn(l(vars), right(vars));
    }
    return left;
  };

  const parseUnary = () => {
    const tok = peek();
    if (tok?.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      pos++;
      const operand = parseUnary();
      return tok.v === '-' ? (vars) => -operand(vars) : operand;
    }
    return parsePrimary();
  };

  const parsePrimary = () => {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.t === 'num') {
      pos++;
      return () => tok.v;
    }
    if (tok.t === '(') {
      pos++;
      const inner = parseExpr();
      eat(')');
      return inner;
    }
    if (tok.t === 'name') {
      pos++;
      const name = tok.v;
      if (peek()?.t === '(') {
        pos++;
        const args = [];
        if (peek()?.t !== ')') {
          args.push(parseExpr());
          while (peek()?.t === ',') {
            pos++;
            args.push(parseExpr());
          }
        }
        eat(')');
        const fn = FUNCTIONS[name.toLowerCase()];
        if (!fn) throw new Error(`Unknown function "${name}"`);
        return (vars) => fn(...args.map((a) => a(vars)));
      }
      const key = name.toLowerCase();
      if (key in CONSTANTS) return () => CONSTANTS[key];
      return (vars) => {
        const v = vars[name] ?? vars[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new Error(`Unknown variable "${name}"`);
        }
        return v;
      };
    }
    throw new Error(`Unexpected token`);
  };

  const fn = parseExpr();
  if (pos !== tokens.length) throw new Error('Trailing characters in expression');
  return fn;
}

/**
 * Compile an expression once into a reusable function.
 * Returns { ok: true, eval } or { ok: false, error }.
 */
export function compile(expression) {
  try {
    const fn = parse(tokenize(expression));
    return {
      ok: true,
      eval: (vars = {}) => {
        const n = fn(vars);
        return Number.isFinite(n) ? n : NaN;
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Names a formula refers to that were not supplied — used to validate a sim. */
export function freeVariables(expression) {
  try {
    return [...new Set(tokenize(expression).filter((t) => t.t === 'name').map((t) => t.v))].filter(
      (n) => !(n.toLowerCase() in FUNCTIONS) && !(n.toLowerCase() in CONSTANTS)
    );
  } catch {
    return [];
  }
}

export { FUNCTIONS, CONSTANTS };
