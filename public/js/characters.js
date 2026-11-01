// Character records: the export file format, names, and cleaning up characters
// that come from a file or the network. No DOM, so the server uses it too.
import { isRowId, parseRepeating, UNSAFE_KEYS } from './names.js';

export const FORMAT = 'gurps-sheet-server/characters';

export function newCharacterId() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export const isCharacterId = (id) => typeof id === 'string' && /^c-[a-z0-9-]{1,60}$/.test(id);

export function displayName(attrs) {
  return String(attrs.character_name ?? '').trim() || 'Unnamed character';
}

export function slug(text) {
  return (
    String(text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'character'
  );
}

// Keeps only plain attribute values and valid repeating rows. `id` is the id the
// character gets: a new one for imports, the existing one for library saves.
export function sanitizeCharacter(raw, { id = newCharacterId() } = {}) {
  if (!raw || typeof raw.attrs !== 'object' || raw.attrs === null) return null;

  const attrs = {};
  for (const [k, v] of Object.entries(raw.attrs)) {
    const key = String(k).toLowerCase();
    if (UNSAFE_KEYS.has(key)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[key] = v;
  }

  const sections = {};
  for (const [k, ids] of Object.entries(raw.sections || {})) {
    const key = String(k).toLowerCase();
    if (!/^repeating_[^_]+$/.test(key) || !Array.isArray(ids)) continue;
    sections[key] = [...new Set(ids.map((rowId) => String(rowId).toLowerCase()).filter(isRowId))];
  }
  // Rows that have values but were missing from the order list.
  for (const key of Object.keys(attrs)) {
    const p = parseRepeating(key);
    if (!p?.rowId || !isRowId(p.rowId)) continue;
    const rows = (sections[p.section] ||= []);
    if (!rows.includes(p.rowId)) rows.push(p.rowId);
  }

  const now = Date.now();
  return {
    id,
    name: displayName(attrs),
    attrs,
    sections,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: now,
    sheetVersion: String(raw.sheetVersion || ''),
  };
}
