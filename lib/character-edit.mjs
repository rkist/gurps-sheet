// Edits from the MCP tools, applied to a character open in the sheet runtime
// the way a player makes them: field by field, so the sheet computes whatever
// depends on them. Everything is checked against the sheet's fields first.
import { lookup } from '../public/js/attributes.js';

export class EditError extends Error {}

const MAX_TEXT = 20_000;
const TRUE = new Set(['true', '1', 'on', 'yes', 'checked']);
const FALSE = new Set(['false', '0', '', 'no', 'off', 'unchecked']);

// Edits: { action: 'set', values } (fields outside repeating sections),
// { action: 'add_row', section, values }, { action: 'update_row', section,
// row, values } and { action: 'remove_row', section, row }, where `row` is a
// row id or the row's name. Resolves to a description of each change.
export async function applyChanges(runtime, sheet, changes) {
  if (!Array.isArray(changes)) throw new EditError('"changes" must be a list.');
  const planned = changes.map((change, i) => plan(sheet, change, i + 1));
  const done = [];
  for (const change of planned) {
    if (change.action === 'set') {
      for (const [field, value] of change.values) await runtime.change(field, value);
      done.push(`set ${change.values.map(([field, value]) => `${field} = ${JSON.stringify(value)}`).join(', ')}`);
    } else if (change.action === 'add_row') {
      const rowId = await runtime.addRow(change.section);
      for (const [field, value] of change.values) await runtime.change(`${change.section}_${rowId}_${field}`, value);
      done.push(`added a ${change.section} row ${rowId}${rowName(runtime, sheet, change.section, rowId)}`);
    } else {
      const rowId = findRow(runtime, sheet, change.section, change.row);
      const name = rowName(runtime, sheet, change.section, rowId);
      if (change.action === 'remove_row') {
        await runtime.removeRow(change.section, rowId);
        done.push(`removed ${change.section} row ${rowId}${name}`);
      } else {
        for (const [field, value] of change.values) await runtime.change(`${change.section}_${rowId}_${field}`, value);
        done.push(`changed ${change.section} row ${rowId}${name}: ${change.values.map(([f, v]) => `${f} = ${JSON.stringify(v)}`).join(', ')}`);
      }
    }
  }
  return done;
}

function rowName(runtime, sheet, section, rowId) {
  const name = String(lookup(runtime.attrs, sheet, 'name', { section, rowId }) ?? '').trim();
  return name ? ` (${name})` : '';
}

function plan(sheet, change, n) {
  const where = `Change ${n}`;
  if (!change || typeof change !== 'object') throw new EditError(`${where} must be an object.`);
  const { action } = change;
  if (!['set', 'add_row', 'update_row', 'remove_row'].includes(action)) {
    throw new EditError(`${where}: action must be set, add_row, update_row or remove_row.`);
  }
  const section = action === 'set' ? null : sectionName(sheet, change.section, where);
  if ((action === 'update_row' || action === 'remove_row') && !String(change.row ?? '').trim()) {
    throw new EditError(`${where}: "row" (the row's id or name) is required.`);
  }
  if (action === 'remove_row') return { action, section, row: String(change.row).trim() };
  const values = change.values;
  if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length) {
    throw new EditError(`${where}: "values" must map field names to values.`);
  }
  return {
    action,
    section,
    row: change.row === undefined ? undefined : String(change.row).trim(),
    values: Object.entries(values).map(([field, value]) => [field.toLowerCase(), normalize(sheet, section, field.toLowerCase(), value, where)]),
  };
}

// "skills" or "repeating_skills" -> "repeating_skills".
function sectionName(sheet, section, where) {
  const name = String(section ?? '').trim().toLowerCase();
  const full = name.startsWith('repeating_') ? name : `repeating_${name}`;
  if (name && Object.hasOwn(sheet.sectionDefaults, full)) return full;
  throw new EditError(`${where}: "section" must be one of ${Object.keys(sheet.sectionDefaults).map((s) => s.slice(10)).join(', ')}.`);
}

const fieldCache = new WeakMap();

// "section|field" -> the elements of that field.
function fieldsOf(sheet) {
  if (fieldCache.has(sheet)) return fieldCache.get(sheet);
  const map = new Map();
  for (const field of sheet.fields) {
    const key = `${field.section ?? ''}|${field.name}`;
    map.set(key, [...(map.get(key) || []), field]);
  }
  fieldCache.set(sheet, map);
  return map;
}

// The value as the sheet's own field would store it.
function normalize(sheet, section, name, value, where) {
  // Roll20 keeps the name outside the sheet; the app has its own box for it.
  if (!section && name === 'character_name') {
    if (!['string', 'number'].includes(typeof value) || !String(value).trim()) throw new EditError(`${where}: character_name must be a name.`);
    return String(value).trim();
  }
  const elements = fieldsOf(sheet).get(`${section ?? ''}|${name}`);
  const label = section ? `${section.slice(10)} field "${name}"` : `field "${name}"`;
  if (!elements) {
    const words = name.split('_').filter((w) => w.length > 2);
    const similar = [...fieldsOf(sheet).keys()]
      .filter((key) => key.startsWith(`${section ?? ''}|`) && words.some((w) => key.includes(w)))
      .map((key) => key.split('|')[1]);
    throw new EditError(`${where}: the sheet has no ${label}.${similar.length ? ` Similar: ${[...new Set(similar)].slice(0, 12).join(', ')}.` : ''} sheet_fields lists them.`);
  }
  const editable = elements.filter((f) => f.type !== 'hidden' && !f.disabled && !f.readonly);
  if (!editable.length) throw new EditError(`${where}: ${label} is computed by the sheet. Change what it depends on instead.`);
  if (value === null || !['string', 'number', 'boolean'].includes(typeof value)) {
    throw new EditError(`${where}: ${label} needs a text, number or true/false value.`);
  }
  const text = String(value);
  const field = editable.find((f) => f.tag === 'select') || editable.find((f) => f.type === 'checkbox') || editable.find((f) => f.type === 'radio') || editable[0];

  if (field.tag === 'select') {
    const option = field.options.find((o) => o.value === text) || field.options.find((o) => o.label.toLowerCase() === text.toLowerCase());
    if (option) return option.value;
    throw new EditError(`${where}: ${label} must be one of ${field.options.map((o) => (o.label && o.label !== o.value ? `${o.value} (${o.label})` : o.value)).join(', ')}.`);
  }
  if (field.type === 'checkbox') {
    const on = field.value ?? 'on';
    if (text === on || TRUE.has(text.toLowerCase())) return on;
    if (FALSE.has(text.toLowerCase())) return '0';
    throw new EditError(`${where}: ${label} is a checkbox; use true or false.`);
  }
  if (field.type === 'radio') {
    const choices = editable.filter((f) => f.type === 'radio').map((f) => f.value ?? 'on');
    if (choices.includes(text)) return text;
    throw new EditError(`${where}: ${label} must be one of ${choices.join(', ')}.`);
  }
  if (field.type === 'number' && text.trim() !== '' && !Number.isFinite(Number(text))) {
    throw new EditError(`${where}: ${label} must be a number.`);
  }
  if (text.length > MAX_TEXT) throw new EditError(`${where}: ${label} is too long (over ${MAX_TEXT} characters).`);
  return text;
}

// A row id from an id or the row's name.
function findRow(runtime, sheet, section, row) {
  const rows = runtime.sections[section] || [];
  if (rows.includes(row.toLowerCase())) return row.toLowerCase();
  const wanted = row.toLowerCase();
  const named = rows.filter((rowId) => String(lookup(runtime.attrs, sheet, 'name', { section, rowId }) ?? '').trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new EditError(`Several ${section.slice(10)} rows are called "${row}": ${named.join(', ')}. Use the row id.`);
  const names = rows.map((rowId) => `${String(lookup(runtime.attrs, sheet, 'name', { section, rowId }) ?? '').trim() || '(unnamed)'} (${rowId})`);
  throw new EditError(`No ${section.slice(10)} row "${row}".${names.length ? ` The rows: ${names.join(', ')}.` : ' The section is empty.'}`);
}
