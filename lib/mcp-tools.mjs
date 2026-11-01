// The MCP tools (see lib/mcp.mjs): reading the group's characters and their
// history, and the fields the sheet has. Each tool's run() gets its arguments
// and { library, sheet }, and returns text or throws ToolError.
import { isCharacterId } from '../public/js/characters.js';
import { summarize } from './character-summary.mjs';

export class ToolError extends Error {}

const characterArg = {
  type: 'string',
  description: 'The character id (c-...) or name, as list_characters gives them. A unique part of the name is enough.',
};
const detailArg = {
  type: 'string',
  enum: ['summary', 'attributes'],
  description: '"summary" (default): readable, with computed values. "attributes": every stored attribute and the row ids of each repeating section, as JSON.',
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const when = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const tools = [
  {
    name: 'list_characters',
    title: 'List characters',
    description:
      "Lists the characters in the group's library, newest first, with their ids and when they were last saved, " +
      'then the deleted ones, whose history is still there.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    run(args, { library }) {
      const characters = library.list();
      const deleted = library.deletedIds().map((id) => ({ id, ...library.versions(id)[0] }));
      const lines = characters.length ? characters.map((c) => `- ${c.name} (${c.id}), saved ${when(c.savedAt)}`) : ['The library has no characters yet.'];
      if (deleted.length) {
        lines.push('', 'Deleted (get_character_history still has their versions):');
        lines.push(...deleted.sort((a, b) => b.savedAt - a.savedAt).map((c) => `- ${c.name} (${c.id}), deleted ${when(c.savedAt)}`));
      }
      return lines.join('\n');
    },
  },
  {
    name: 'get_character',
    title: 'Get a character',
    description:
      "A character's current version: points, attributes, advantages and disadvantages, skills, techniques, spells, " +
      'attacks, defenses and equipment, with the levels the sheet computes.',
    inputSchema: { type: 'object', properties: { character: characterArg, detail: detailArg }, required: ['character'], additionalProperties: false },
    annotations: readOnly,
    async run({ character, detail }, { library, sheet }) {
      const id = findCharacter(library, character);
      return describe(await library.get(id), id, detail, sheet);
    },
  },
  {
    name: 'get_character_history',
    title: 'Get a character’s history',
    description: 'Every saved version of a character, newest first. Nothing in the library is ever overwritten, so each change is there.',
    inputSchema: { type: 'object', properties: { character: characterArg }, required: ['character'], additionalProperties: false },
    annotations: readOnly,
    run({ character }, { library }) {
      const id = findCharacter(library, character);
      const versions = library.versions(id);
      return [
        `${versions.length} version${versions.length === 1 ? '' : 's'} of ${id}, newest first (pass a version to get_character_version):`,
        ...versions.map((v) => `- ${v.version}: ${when(v.savedAt)}, "${v.name}"${v.deleted ? ' (deleted)' : ''}`),
      ].join('\n');
    },
  },
  {
    name: 'get_character_version',
    title: 'Get an older version of a character',
    description: 'One version of a character from its history, e.g. to see what changed.',
    inputSchema: {
      type: 'object',
      properties: { character: characterArg, version: { type: 'string', description: 'A version from get_character_history.' }, detail: detailArg },
      required: ['character', 'version'],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run({ character, version, detail }, { library, sheet }) {
      const id = findCharacter(library, character);
      const found = await library.getVersion(id, version);
      if (!found) throw new ToolError(`${id} has no version "${version}". get_character_history lists them.`);
      return describe(found, id, detail, sheet);
    },
  },
  {
    name: 'sheet_fields',
    title: 'List the sheet’s fields',
    description:
      'The fields of the GURPS sheet: their attribute names, types, choices and defaults. Without arguments, lists the ' +
      'sections. Fields outside repeating sections are in section "character"; a repeating field is stored per row as ' +
      'repeating_<section>_<rowId>_<field>.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'A section such as "character" or "repeating_skills".' },
        search: { type: 'string', description: 'Only fields whose name contains this text, e.g. "dodge".' },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
    run({ section, search }, { sheet }) {
      return listFields(sheet, section, search);
    },
  },
];

// A character id from an id or a (unique part of a) name.
function findCharacter(library, ref) {
  const wanted = String(ref).trim();
  if (isCharacterId(wanted) && library.versions(wanted).length) return wanted;
  const all = library.list();
  const name = wanted.toLowerCase();
  const exact = all.filter((c) => c.name.toLowerCase() === name);
  const matches = exact.length ? exact : all.filter((c) => c.name.toLowerCase().includes(name));
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new ToolError(`No character called "${wanted}". list_characters lists them.`);
  throw new ToolError(`"${wanted}" matches ${matches.map((c) => `${c.name} (${c.id})`).join(', ')}. Use the id.`);
}

function describe(found, id, detail = 'summary', sheet) {
  if (!found) throw new ToolError(`No character ${id}.`);
  if (found.deleted) return `${id} was deleted (version ${found.version}, ${when(found.savedAt)}). get_character_history lists its earlier versions.`;
  const { character, version, savedAt } = found;
  if (detail === 'attributes') {
    return JSON.stringify({ id, version, savedAt: new Date(savedAt).toISOString(), name: character.name, attrs: character.attrs, sections: character.sections }, null, 1);
  }
  return `Character ${id}, version ${version}, saved ${when(savedAt)}\n\n${summarize(character, sheet)}`;
}

const LIMIT = 300;

function listFields(sheet, section, search) {
  const all = [...new Map(sheet.fields.map((f) => [`${f.section}|${f.name}`, f])).values()];
  const sectionOf = (f) => f.section || 'character';
  if (!section && !search) {
    const counts = new Map();
    for (const f of all) counts.set(sectionOf(f), (counts.get(sectionOf(f)) || 0) + 1);
    return [
      'Sections and their number of fields (pass a section, or a search, to list fields):',
      ...[...counts].map(([name, count]) => `- ${name}: ${count}`),
    ].join('\n');
  }
  const wanted = search?.toLowerCase();
  const fields = all.filter((f) => (!section || sectionOf(f) === section) && (!wanted || f.name.includes(wanted)));
  if (!fields.length) throw new ToolError(`No fields${section ? ` in section "${section}"` : ''}${search ? ` matching "${search}"` : ''}.`);
  const lines = fields.slice(0, LIMIT).map((f) => {
    const parts = [f.type];
    if (f.options) parts.push(`choices: ${f.options.map((o) => (o.label && o.label !== o.value ? `${o.value} (${o.label})` : o.value)).join(', ')}`);
    const value = f.type === 'checkbox' ? f.value ?? 'on' : f.value;
    if (f.type === 'checkbox') parts.push(`"${value}" when checked, "0" when not`);
    else if (f.disabled && String(value).includes('@{')) parts.push(`computed: ${value}`);
    else if (value) parts.push(`default "${String(value).slice(0, 80)}"`);
    if (f.type === 'hidden' || f.disabled || f.readonly) parts.push('set by the sheet');
    return `- ${section ? '' : `${sectionOf(f)}: `}${f.name} (${parts.join('; ')})`;
  });
  if (fields.length > LIMIT) lines.push(`… and ${fields.length - LIMIT} more; narrow it down with search.`);
  return lines.join('\n');
}
