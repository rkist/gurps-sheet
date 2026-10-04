// Attribute-name helpers shared by the page-side code (the worker has its own copy).

// repeating_<section>_<rowId>_<field>; section names never contain "_" and
// row ids always start with "-".
export function parseRepeating(name) {
  const m = /^(repeating_[^_]+)_(.*)$/.exec(name);
  if (!m) return null;
  const rest = m[2];
  if (rest.charAt(0) !== '-') return { section: m[1], rowId: null, field: rest };
  const i = rest.indexOf('_');
  return i < 0
    ? { section: m[1], rowId: rest, field: '' }
    : { section: m[1], rowId: rest.slice(0, i), field: rest.slice(i + 1) };
}

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

// Same shape as Roll20 row ids ("-" + 19 chars) but lowercase and without "_",
// so ids survive the sheet's split("_") parsing.
export function generateRowId() {
  let t = Date.now();
  let id = '';
  for (let i = 0; i < 8; i++) {
    id = ID_CHARS[t % 36] + id;
    t = Math.floor(t / 36);
  }
  for (let i = 0; i < 11; i++) id += ID_CHARS[(Math.random() * 36) | 0];
  return '-' + id;
}

export const isRowId = (id) => typeof id === 'string' && /^-[a-z0-9-]{1,40}$/.test(id);

export const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
