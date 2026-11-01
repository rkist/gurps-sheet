// What the server needs to know about the Roll20 sheet, read from GURPS/ with a
// small tag scanner instead of a DOM: every field (name, section, type, select
// options, default) and the field defaults, which match what loadSheet()
// (public/js/sheet-loader.js) collects in the browser.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHEET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'GURPS');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

// Reads the tag that starts at markup[start] ('<'), following the HTML
// tokenizer: a quote starts a value only right after '='; anywhere else it is
// part of an attribute name (the sheet has a few stray quotes, e.g. title=""x").
// Returns { name, closing, attrs, end } or null if there is no tag here.
function readTag(markup, start) {
  const m = /^<(\/?)([a-zA-Z][^\s/>]*)/.exec(markup.slice(start, start + 200));
  if (!m) return null;
  const tag = { name: m[2].toLowerCase(), closing: !!m[1], attrs: {}, end: markup.length };
  let i = start + m[0].length;
  for (;;) {
    while (/[\s/]/.test(markup[i] || '')) i++;
    if (i >= markup.length) return tag;
    if (markup[i] === '>') {
      tag.end = i + 1;
      return tag;
    }
    let name = markup[i++]; // may be '=' or a quote
    while (i < markup.length && !/[\s/>=]/.test(markup[i])) name += markup[i++];
    while (/\s/.test(markup[i] || '')) i++;
    let value;
    if (markup[i] === '=') {
      i++;
      while (/\s/.test(markup[i] || '')) i++;
      const quote = markup[i];
      if (quote === '"' || quote === "'") {
        const close = markup.indexOf(quote, i + 1);
        value = markup.slice(i + 1, close < 0 ? markup.length : close);
        i = close < 0 ? markup.length : close + 1;
      } else {
        value = '';
        while (i < markup.length && !/[\s>]/.test(markup[i])) value += markup[i++];
      }
    }
    name = name.toLowerCase();
    if (!(name in tag.attrs)) tag.attrs[name] = value === undefined ? '' : decode(value); // the first one counts
  }
}

const textOf = (html) => decode(html.replace(/<[^>]*>/g, ''));

// Every attr_ field of the sheet markup, in document order:
// { name, section (null outside repeating sections), tag, type, value,
//   checked, disabled, readonly, title, options: [{ value, label, selected }] }.
export function scanFields(html, translations = {}) {
  const markup = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<rolltemplate\b[\s\S]*?<\/rolltemplate>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const lower = markup.toLowerCase();
  const fields = [];
  const fieldsets = [];
  for (let at = markup.indexOf('<'); at >= 0; at = markup.indexOf('<', at + 1)) {
    const tag = readTag(markup, at);
    if (!tag) continue;
    at = tag.end - 1;
    if (tag.name === 'fieldset') {
      if (tag.closing) fieldsets.pop();
      else fieldsets.push(/(?:^|\s)(repeating_\S+)/.exec(tag.attrs.class || '')?.[1].toLowerCase() ?? null);
      continue;
    }
    if (tag.closing || !['input', 'select', 'textarea'].includes(tag.name)) continue;

    let inner = '';
    if (tag.name !== 'input') {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      if (close < 0) break;
      inner = markup.slice(tag.end, close);
      at = close;
    }
    const { attrs } = tag;
    if (!/^attr_/i.test(attrs.name || '')) continue;

    const field = {
      name: attrs.name.slice(5).toLowerCase(),
      section: fieldsets.findLast((s) => s) ?? null,
      tag: tag.name,
      type: tag.name === 'input' ? (attrs.type || 'text').toLowerCase() : tag.name,
      value: attrs.value,
      checked: 'checked' in attrs,
      disabled: 'disabled' in attrs,
      readonly: 'readonly' in attrs,
      title: attrs.title,
    };
    if (tag.name === 'textarea') field.value = decode(inner.replace(/^\r?\n/, '')); // the parser drops a leading newline
    if (tag.name === 'select') field.options = scanOptions(inner, translations);
    fields.push(field);
  }
  return fields;
}

function scanOptions(inner, translations) {
  const options = [];
  for (let at = inner.indexOf('<'); at >= 0; at = inner.indexOf('<', at + 1)) {
    const tag = readTag(inner, at);
    if (!tag || tag.closing || tag.name !== 'option') continue;
    const next = inner.slice(tag.end).search(/<\/?option\b/i);
    const html = next < 0 ? inner.slice(tag.end) : inner.slice(tag.end, tag.end + next);
    const key = tag.attrs['data-i18n'];
    const text = key && Object.hasOwn(translations, key) ? textOf(translations[key]) : textOf(html);
    options.push({ value: tag.attrs.value ?? text, label: text.trim(), selected: 'selected' in tag.attrs });
  }
  return options;
}

// The value a field gives a new character, as fieldDefault() in sheet-loader.js.
function fieldDefault(field) {
  if (field.type === 'checkbox') return field.checked ? field.value ?? 'on' : '0';
  if (field.type === 'radio') return field.checked ? field.value ?? 'on' : undefined;
  if (field.tag === 'select') {
    const option = field.options.find((o) => o.selected) || field.options[0];
    return option ? option.value : '';
  }
  if (field.tag === 'textarea') return field.value;
  if (field.tag === 'input') return field.value ?? '';
  return undefined;
}

// { defaults, sectionDefaults } as collectDefaults() in sheet-loader.js.
export function collectDefaults(fields) {
  const defaults = {};
  const sectionDefaults = {};
  for (const field of fields) {
    const value = fieldDefault(field);
    if (value === undefined) continue;
    const target = field.section ? (sectionDefaults[field.section] ||= {}) : defaults;
    if (!(field.name in target) || field.type === 'radio') target[field.name] = value;
  }
  return { defaults, sectionDefaults };
}

let cached;

// The sheet in GURPS/, read once: { version, fields, defaults, sectionDefaults }.
export function loadSheetInfo() {
  if (cached) return cached;
  const html = readFileSync(path.join(SHEET_DIR, 'gurps.html'), 'utf8');
  const translations = JSON.parse(readFileSync(path.join(SHEET_DIR, 'translation.json'), 'utf8'));
  const worker = /<script\s+type=["']text\/worker["']\s*>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? '';
  const fields = scanFields(html, translations);
  cached = {
    version: /const\s+version\s*=\s*"([^"]+)"/.exec(worker)?.[1] ?? 'unknown',
    fields,
    ...collectDefaults(fields),
  };
  return cached;
}
