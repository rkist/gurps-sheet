// Reading a character's attributes the way the sheet shows them: the stored
// value, else the field's default, where @{field} inside a repeating row means
// that row's field. `sheet` holds the defaults ({ defaults, sectionDefaults }).
// No DOM, so the server uses it too.
import { computeAutocalc } from './autocalc.js';
import { parseRepeating } from './names.js';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function defaultOf(sheet, key) {
  const p = parseRepeating(key);
  if (p && p.rowId !== null) {
    const d = sheet.sectionDefaults[p.section];
    return d && hasOwn(d, p.field) ? d[p.field] : undefined;
  }
  return hasOwn(sheet.defaults, key) ? sheet.defaults[key] : undefined;
}

export function valueOf(attrs, sheet, key) {
  return hasOwn(attrs, key) ? attrs[key] : defaultOf(sheet, key);
}

// `row` is { section, rowId } or null. Also used to fill in roll macros.
export function lookup(attrs, sheet, name, row) {
  const n = name.toLowerCase();
  if (row) {
    const full = `${row.section}_${row.rowId}_${n}`;
    if (hasOwn(attrs, full) || hasOwn(sheet.sectionDefaults[row.section] || {}, n)) return valueOf(attrs, sheet, full);
  }
  return valueOf(attrs, sheet, n);
}

// The value a field shows: auto-calc formulas such as `@{a} + @{b}` computed.
export function shownValue(attrs, sheet, key, row = null) {
  const raw = valueOf(attrs, sheet, key);
  if (raw == null || !String(raw).includes('@{')) return raw;
  return computeAutocalc(String(raw), (name) => lookup(attrs, sheet, name, row));
}
