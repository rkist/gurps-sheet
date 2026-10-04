// Roll20 "auto-calculating" fields: disabled inputs whose value is a formula
// such as `round(2 * @{basic_lift})`. Roll20 shows the computed result while
// the attribute itself keeps the formula text.

const MAX_DEPTH = 12;
const NUMBER = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;

const FUNCTIONS = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
};

// lookup(name) returns the raw value of an attribute (which may itself be a formula).
export function computeAutocalc(formula, lookup, depth = 0) {
  const single = /^\s*@\{([^}]+)\}\s*$/.exec(formula);
  if (single) {
    const value = lookup(single[1].trim());
    if (value == null) return '';
    const text = String(value);
    return text.includes('@{') && depth < MAX_DEPTH ? computeAutocalc(text, lookup, depth + 1) : text;
  }

  const expression = expand(formula, lookup, depth).replace(/\[\[/g, '(').replace(/\]\]/g, ')');
  try {
    const result = evaluate(expression);
    if (!Number.isFinite(result)) return '';
    return String(Math.round(result * 1e10) / 1e10);
  } catch {
    return '';
  }
}

function expand(text, lookup, depth) {
  return text.replace(/@\{([^}]+)\}/g, (_, name) => {
    const value = lookup(name.trim());
    if (value == null || value === '') return '0';
    const str = String(value);
    if (str.includes('@{') && depth < MAX_DEPTH) return '(' + expand(str, lookup, depth + 1) + ')';
    return NUMBER.test(str) ? '(' + str.trim() + ')' : str;
  });
}

// Small recursive-descent parser: numbers, + - * / %, parentheses and FUNCTIONS.
function evaluate(src) {
  let i = 0;

  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = () => {
    throw new Error(`Cannot evaluate "${src}"`);
  };

  function expression() {
    let v = term();
    for (;;) {
      skip();
      if (src[i] === '+') {
        i++;
        v += term();
      } else if (src[i] === '-') {
        i++;
        v -= term();
      } else return v;
    }
  }

  function term() {
    let v = unary();
    for (;;) {
      skip();
      if (src[i] === '*') {
        i++;
        v *= unary();
      } else if (src[i] === '/') {
        i++;
        v /= unary();
      } else if (src[i] === '%') {
        i++;
        v %= unary();
      } else return v;
    }
  }

  function unary() {
    skip();
    if (src[i] === '-') {
      i++;
      return -unary();
    }
    if (src[i] === '+') {
      i++;
      return unary();
    }
    return primary();
  }

  function primary() {
    skip();
    if (src[i] === '(') {
      i++;
      const v = expression();
      skip();
      if (src[i++] !== ')') fail();
      return v;
    }
    const rest = src.slice(i);
    const num = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(rest);
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    const ident = /^[a-z]+/i.exec(rest);
    if (ident) {
      const fn = FUNCTIONS[ident[0].toLowerCase()];
      if (!fn) fail();
      i += ident[0].length;
      skip();
      if (src[i++] !== '(') fail();
      const args = [expression()];
      skip();
      while (src[i] === ',') {
        i++;
        args.push(expression());
        skip();
      }
      if (src[i++] !== ')') fail();
      return fn(...args);
    }
    return fail();
  }

  const value = expression();
  skip();
  if (i !== src.length) fail();
  return value;
}
