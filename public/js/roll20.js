// Turns the sheet's Roll20 roll macros into Roll20 chat commands to copy and
// paste, such as `/roll {3d6[Broadsword],0d0+99}<11`. Nothing is rolled here.
//
// A macro goes through the same steps as on Roll20:
//   expandAttributes()               @{attribute} references
//   findQueries() / answerQueries()  ?{Prompt|default} prompts
//   buildRoll()                      inline rolls [[...]] and template fields {{key=value}}
// No DOM, so the tests can import it directly.

const MAX_DEPTH = 10;
const MARKER = /\$\[\[(\d+)\]\]/g;
// Dice such as 3d6 or 4dF, but not the "d" of drop modifiers like {..}d1.
const DICE = /(^|[^a-z}])\d*d(\d+|f)/i;
// A dice term with its modifiers (3d6cs<1cf>6, 2d6!), for placing a label after it.
const DICE_TERM = /\d*d(\d+|f)[!a-z<>=\d]*/i;
const NUMBER = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i;
const FUNCTIONS = { floor: Math.floor, ceil: Math.ceil, round: Math.round, abs: Math.abs };

// @{name} and @{selected|name}, which on this sheet is the character itself.
// Other forms (@{target|...}, @{name|max}) stay as they are.
export function expandAttributes(text, lookup) {
  let out = String(text);
  for (let depth = 0; depth < MAX_DEPTH && out.includes('@{'); depth++) {
    const next = out.replace(/@\{([^{}]+)\}/g, (ref, inner) => {
      const parts = inner.split('|').map((p) => p.trim());
      if (parts.length > 2 || (parts.length === 2 && parts[0].toLowerCase() !== 'selected')) return ref;
      const value = lookup(parts.at(-1).toLowerCase());
      return value == null ? '' : String(value);
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// ?{Prompt}, ?{Prompt|default} or ?{Prompt|option|option...}, where an option
// can be "Label,value". Like Roll20, a prompt that appears twice is asked once.
export function findQueries(text) {
  const queries = new Map();
  for (const q of scanQueries(text)) if (!queries.has(q.prompt)) queries.set(q.prompt, q);
  return [...queries.values()].map(({ prompt, defaultValue, options }) => ({ prompt, defaultValue, options }));
}

// answers: Map of prompt -> value. Unanswered prompts take their default.
export function answerQueries(text, answers = new Map()) {
  let out = '';
  let last = 0;
  for (const q of scanQueries(text)) {
    out += text.slice(last, q.start) + (answers.has(q.prompt) ? answers.get(q.prompt) : q.defaultValue);
    last = q.end;
  }
  return out + text.slice(last);
}

function scanQueries(text) {
  const found = [];
  let start = text.indexOf('?{');
  while (start >= 0) {
    let depth = 0;
    let end = start + 1;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    if (end >= text.length) break;
    const [prompt, ...rest] = text.slice(start + 2, end).split('|');
    let defaultValue = decodeEntities(rest[0] ?? '');
    let options = null;
    if (rest.length > 1) {
      options = rest.map((option) => {
        const comma = option.indexOf(',');
        return comma < 0
          ? { label: decodeEntities(option), value: decodeEntities(option) }
          : { label: decodeEntities(option.slice(0, comma)), value: decodeEntities(option.slice(comma + 1)) };
      });
      defaultValue = options[0].value;
    }
    found.push({ start, end: end + 1, prompt: prompt.trim(), defaultValue, options });
    start = text.indexOf('?{', end + 1);
  }
  return found;
}

function decodeEntities(text) {
  return text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&amp;/g, '&');
}

// Builds the Roll20 commands for a macro whose attributes and queries are filled in.
// Returns { title, subtitle, gm, commands: [{ text, target? }] }.
export function buildRoll(text) {
  const rolls = [];
  const marked = extractInlineRolls(String(text), rolls);
  const resolved = resolveRolls(rolls);

  const templateAt = marked.search(/&\{template:[^}]*\}/);
  const prefix = templateAt < 0 ? marked : marked.slice(0, templateAt);
  const fields = new Map();
  for (const m of marked.matchAll(/\{\{([^=}]+)=([^}]*)\}\}/g)) {
    if (!fields.has(m[1].trim())) fields.set(m[1].trim(), m[2]);
  }

  const command = /\/w(hisper)?\s+"?gm\b|\/sr\b|\/gmroll\b/i.test(prefix) ? '/gmroll' : '/roll';
  const fieldText = (key) => tidy((fields.get(key) ?? '').replace(MARKER, (_, n) => resolved[n].text));
  const rollIn = (key) => {
    const m = /^\s*\$\[\[(\d+)\]\]\s*$/.exec(fields.get(key) ?? '');
    return m ? resolved[Number(m[1])] : null;
  };
  const title = cleanLabel(fieldText('skillName') || fieldText('title') || fieldText('subtitle'));
  const subtitle = cleanLabel(fieldText('type'));
  const label = title || subtitle;
  const commands = [];
  const used = new Set();

  // A success roll: Roll20 compares a group's total only when the group has a
  // second roll, so 0d0+99 is a filler that never succeeds.
  const check = rollIn('rollResult');
  const skill = rollIn('effectiveSkill');
  if (check?.dice && skill && skill.value != null) {
    const dice = check.text.replace(/c[sf][<>=]?\d+/gi, '');
    const filler = Math.max(99, skill.value + 1);
    commands.push({
      text: `${command} {${withLabel(dice, label)},0d0+${filler}}<${formatNumber(skill.value)}`,
      target: skill.value,
    });
    used.add(check).add(skill);
  }

  // Initiative: the sheet adds Basic Speed + DX/100 to Roll20's turn order.
  for (const m of prefix.matchAll(MARKER)) {
    const roll = resolved[Number(m[1])];
    if (!roll.tracker) continue;
    commands.push({ text: `${command} ${withLabel(roll.text, 'Initiative')} &{tracker}` });
    used.add(roll);
  }

  // Damage, and any other roll with dice in a template field.
  for (const [key, value] of fields) {
    for (const m of value.matchAll(MARKER)) {
      const roll = resolved[Number(m[1])];
      if (used.has(roll) || !(roll.dice || key === 'damageRoll')) continue;
      commands.push({ text: `${command} ${withLabel(roll.text, label)}` });
      used.add(roll);
    }
  }

  return { title, subtitle, gm: command === '/gmroll', commands };
}

// Replaces each [[...]] with a $[[n]] marker, innermost first, as Roll20 does.
// rolls[n] receives the roll's text, which may contain markers of nested rolls.
function extractInlineRolls(text, rolls) {
  let out = '';
  const open = [];
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('[[', i)) {
      open.push(out.length);
      out += '[[';
      i++;
    } else if (text.startsWith(']]', i) && open.length) {
      const start = open.pop();
      rolls.push(out.slice(start + 2));
      out = out.slice(0, start) + `$[[${rolls.length - 1}]]`;
      i++;
    } else {
      out += text[i];
    }
  }
  return out;
}

// Each roll becomes { text, dice, value, tracker }. Rolls without dice are
// evaluated, so nested ones can be replaced by their number.
function resolveRolls(rolls) {
  const resolved = [];
  for (const raw of rolls) {
    const tracker = /&\{tracker[^}]*\}/i.test(raw);
    let text = raw.replace(/&\{tracker[^}]*\}/gi, '');
    text = tidy(text.replace(MARKER, (_, n) => {
      const inner = resolved[Number(n)];
      return inner.value != null ? formatNumber(inner.value) : `(${inner.text})`;
    }));
    const dice = DICE.test(text);
    let value = null;
    if (!dice) {
      try {
        value = evaluate(text);
      } catch {
        value = null;
      }
    }
    resolved.push({ text: value != null ? formatNumber(value) : text, dice, value, tracker });
  }
  return resolved;
}

// Puts the label right after the first dice term (where Roll20 accepts one),
// or after the whole expression if it has no dice.
function withLabel(expression, label) {
  if (!label) return expression;
  const m = DICE_TERM.exec(expression);
  if (!m) return `${expression}[${label}]`;
  const end = m.index + m[0].length;
  return `${expression.slice(0, end)}[${label}]${expression.slice(end)}`;
}

function cleanLabel(text) {
  return tidy(text.replace(/[[\]{}]/g, '').replace(/&nbsp;/g, ' ')).slice(0, 80);
}

function tidy(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function formatNumber(value) {
  return String(Math.round(value * 1e10) / 1e10);
}

// Evaluates a Roll20 expression without dice: numbers, + - * / %, parentheses,
// floor/ceil/round/abs and groups such as {a, b}kh1 or {a, b}kl1. Labels are ignored.
export function evaluate(expression) {
  const src = expression.replace(/\[[^\]]*\]/g, '');
  let i = 0;

  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const fail = () => {
    throw new Error(`Cannot evaluate "${expression}"`);
  };

  function sum() {
    let v = product();
    for (;;) {
      skip();
      if (src[i] === '+') {
        i++;
        v += product();
      } else if (src[i] === '-') {
        i++;
        v -= product();
      } else return v;
    }
  }

  function product() {
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
      const v = sum();
      skip();
      if (src[i++] !== ')') fail();
      return v;
    }
    if (src[i] === '{') {
      i++;
      return group();
    }
    const rest = src.slice(i);
    const num = NUMBER.exec(rest);
    if (num) {
      i += num[0].length;
      return parseFloat(num[0]);
    }
    const name = /^[a-z]+/i.exec(rest);
    const fn = name && FUNCTIONS[name[0].toLowerCase()];
    if (!fn) fail();
    i += name[0].length;
    skip();
    if (src[i++] !== '(') fail();
    const v = sum();
    skip();
    if (src[i++] !== ')') fail();
    return fn(v);
  }

  // {a, b, ...} with an optional keep/drop modifier: kh1 or k1 (keep highest),
  // kl1, dl1 or d1 (drop lowest), dh1. Without one, the group is the sum.
  function group() {
    const items = [sum()];
    skip();
    while (src[i] === ',') {
      i++;
      items.push(sum());
      skip();
    }
    if (src[i++] !== '}') fail();
    const mod = /^([kd])([hl]?)(\d+)/i.exec(src.slice(i));
    if (!mod) return items.reduce((a, b) => a + b, 0);
    i += mod[0].length;
    const n = Number(mod[3]);
    const asc = [...items].sort((a, b) => a - b);
    const keepLowest = mod[1].toLowerCase() === 'k' ? mod[2].toLowerCase() === 'l' : mod[2].toLowerCase() === 'h';
    const keep = Math.min(Math.max(mod[1].toLowerCase() === 'k' ? n : asc.length - n, 0), asc.length);
    const kept = keepLowest ? asc.slice(0, keep) : asc.slice(asc.length - keep);
    return kept.reduce((a, b) => a + b, 0);
  }

  const value = sum();
  skip();
  if (i !== src.length || !Number.isFinite(value)) fail();
  return value;
}
