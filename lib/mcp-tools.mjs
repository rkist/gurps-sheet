// The MCP tools (see lib/mcp.mjs): reading the group's characters and their
// history and the fields the sheet has, Roll20 commands, and creating, editing
// and importing characters with the sheet running in Node. Each tool's run()
// gets its arguments and { library, sheet }, and returns text or throws ToolError.
import { displayName, isCharacterId, newCharacterId } from '../public/js/characters.js';
import { allowWrite } from './api.mjs';
import { applyChanges, EditError } from './character-edit.mjs';
import { summarize } from './character-summary.mjs';
import { findRoll, ROLL_KINDS, RollError, rollCommands } from './rolls.mjs';
import { SheetBusyError, withSheet } from './sheet-runtime.mjs';
import { ConflictError } from './storage.mjs';

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
const changesArg = {
  type: 'array',
  description:
    'The changes, applied in order like a player typing them into the sheet. Examples: ' +
    '{"action":"set","values":{"strength_points":20}}; ' +
    '{"action":"add_row","section":"skills","values":{"name":"Stealth","base":"DX","difficulty":"A","points":2}}; ' +
    '{"action":"update_row","section":"skills","row":"Stealth","values":{"points":4}}; ' +
    '{"action":"remove_row","section":"traits","row":"Wealth"}. ' +
    'Advantages are in section "traits"; others include perks, disadvantages, quirks, spells, techniquesrevised, melee, ranged, defense, item, languages, cultures.',
  items: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'add_row', 'update_row', 'remove_row'] },
      section: { type: 'string', description: 'For row changes: the repeating section, e.g. "skills".' },
      row: { type: 'string', description: 'For update_row and remove_row: the row id or the row’s name.' },
      values: {
        type: 'object',
        additionalProperties: { type: ['string', 'number', 'boolean'] },
        description: 'Field names (see sheet_fields) and their values. Choices may be given by label, checkboxes as true/false.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Edits add a version; nothing is overwritten.
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

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
  {
    name: 'roll_command',
    title: 'Get a Roll20 command',
    description:
      'The Roll20 chat command for one of a character’s rolls, exactly as the web app’s roll buttons give it: ' +
      'skills, spells, techniques, attacks and their damage, defenses, attributes and checks, Dodge, Thrust and ' +
      'Swing damage, Initiative. Nothing is rolled: the player pastes the command into the Roll20 chat.',
    inputSchema: {
      type: 'object',
      properties: {
        character: characterArg,
        roll: {
          type: 'string',
          description:
            'What to roll: the name of one of the character’s skills, spells, techniques, attacks, defenses or traits, ' +
            'or ST, DX, IQ, HT, Will, Per, Vision, Hearing, Taste/Smell, Touch, Fright Check, Stun Check, Knockdown Check, ' +
            'Unconsciousness Check, Death Check, Dodge, Dodge and Retreat, Dodge and Drop, Knockback, Initiative, Thrust, Swing. ' +
            'A row id (from get_character with detail "attributes") picks one of several rows with the same name.',
        },
        kind: { type: 'string', enum: ROLL_KINDS, description: 'Which kind of roll, when the name is in several (e.g. "defense" for the parry with a weapon).' },
        damage: { type: 'boolean', description: 'For a melee or ranged attack: its damage roll instead of the attack roll.' },
        modifier: { type: 'integer', description: 'The answer to the roll’s Modifier prompt, e.g. -2.' },
        answers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Answers to the roll’s other prompts, by prompt, e.g. {"# of Die": "3d6"}. Unanswered prompts take their default; the result lists them.',
        },
      },
      required: ['character', 'roll'],
      additionalProperties: false,
    },
    annotations: readOnly,
    async run({ character, roll, kind, damage, modifier, answers = {} }, { library, sheet }) {
      const current = await currentVersion(library, character);
      const found = await attempt(() => findRoll(current.character, sheet, { roll, kind, damage }));
      for (const [prompt, answer] of Object.entries(answers)) {
        if (typeof answer !== 'string' && typeof answer !== 'number') throw new ToolError(`The answer to "${prompt}" must be text.`);
      }
      const result = await attempt(() => withSheet(current.character, sheet, (runtime) => rollCommands(runtime, sheet, found, { modifier, answers })));
      const lines = [`${found.label}${found.kind ? ` (${found.kind})` : ''}`];
      for (const command of result.commands) lines.push(`${command.text}${command.target != null ? `   (succeeds on ${command.target} or less)` : ''}`);
      if (!result.commands.length) lines.push('This roll gives no Roll20 command.');
      if (result.gm) lines.push('It goes to the GM only (/gmroll).');
      for (const p of result.prompts) {
        const choices = p.options ? ` (choices: ${p.options.map((o) => (o.label === o.value ? o.value : `${o.label}: ${o.value}`)).join(', ')})` : '';
        lines.push(`Prompt "${p.prompt}": ${p.answer === '' ? '(empty)' : p.answer}${choices}`);
      }
      if (found.others?.length) lines.push(`"${roll}" is also a ${found.others.join(' and a ')}: pass kind for that roll.`);
      return lines.join('\n');
    },
  },
  {
    name: 'create_character',
    title: 'Create a character',
    description:
      'Creates a character in the group library, with the sheet’s defaults for a new character, and optionally ' +
      'applies changes to it as edit_character does.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The character’s name.' }, changes: changesArg },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ name, changes = [] }, { library, sheet }) {
      checkWrite();
      const now = Date.now();
      const character = {
        id: newCharacterId(),
        name,
        createdAt: now,
        sheetVersion: sheet.version,
        attrs: { ...sheet.newCharacterAttrs, character_name: name },
        sections: {},
      };
      const { record, done } = await edit(character, sheet, (runtime) => attempt(() => applyChanges(runtime, sheet, changes)));
      const saved = await library.save(character.id, record, null);
      return `Created "${record.name}" (${character.id}), version ${saved.version}.${listChanges(done)}\n\n${summarize(record, sheet)}`;
    },
  },
  {
    name: 'edit_character',
    title: 'Edit a character',
    description:
      'Changes a character the way a player would in the sheet, which then computes everything that depends on ' +
      'the changes (levels, point totals, derived values), and saves it as a new version.',
    inputSchema: {
      type: 'object',
      properties: { character: characterArg, changes: changesArg },
      required: ['character', 'changes'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ character, changes }, { library, sheet }) {
      checkWrite();
      if (!changes.length) throw new ToolError('"changes" is empty.');
      const current = await currentVersion(library, character);
      const { record, done } = await edit(current.character, sheet, (runtime) => attempt(() => applyChanges(runtime, sheet, changes)));
      const saved = await save(library, current, record);
      return `Saved "${record.name}" as version ${saved.version}.${listChanges(done)}\n\n${summarize(record, sheet)}`;
    },
  },
  {
    name: 'import_character',
    title: 'Import a character',
    description:
      'Creates a character from a GURPS Character Sheet (GCS) or GURPS Character Assistant (GCA) export, with ' +
      'the sheet’s own importer, as the sheet’s Import button does. GCS: the JSON from GCS’s Roll20 export; GCA: ' +
      'the JSON from the GCA export the sheet documents.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The export file’s contents.' },
        format: { type: 'string', enum: ['gcs', 'gca'], description: '"gcs" (default) or "gca".' },
        name: { type: 'string', description: 'The character’s name; by default the name in the export.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    annotations: writes,
    async run({ content, format = 'gcs', name }, { library, sheet }) {
      checkWrite();
      try {
        JSON.parse(content);
      } catch {
        throw new ToolError('The content isn’t JSON. Pass the whole export file.');
      }
      const [field, button, message] =
        format === 'gca' ? ['json_data', 'act_import_gca', 'import_message'] : ['character_json_data', 'act_import_json', 'import_json_message'];
      const now = Date.now();
      const character = {
        id: newCharacterId(),
        name: 'Imported character',
        createdAt: now,
        sheetVersion: sheet.version,
        attrs: { ...sheet.newCharacterAttrs, character_name: 'Imported character' },
        sections: {},
      };
      const { record } = await edit(character, sheet, async (runtime) => {
        await runtime.change(field, content);
        await runtime.click(sheet.buttons.find((b) => b.name === button));
        const outcome = String(runtime.attrs[message] ?? '');
        if (!/^Import has completed/.test(outcome)) throw new ToolError(`The sheet’s importer said: ${outcome || 'nothing'}`);
        // The importer leaves the name alone (Roll20 keeps it outside the sheet).
        await runtime.change('character_name', name || String(runtime.attrs.fullname || '').trim() || 'Imported character');
      });
      const saved = await library.save(character.id, record, null);
      return `Imported "${record.name}" (${character.id}), version ${saved.version}.\n\n${summarize(record, sheet)}`;
    },
  },
];

// The current version of a character: { version, character: { id, ... } }.
async function currentVersion(library, ref) {
  const id = findCharacter(library, ref);
  const found = await library.get(id);
  if (!found || found.deleted) throw new ToolError(`${id} was deleted. get_character_history lists its earlier versions.`);
  return { version: found.version, character: { ...found.character, id } };
}

// Runs `task` with the character open in the sheet; resolves to the record to
// save and what `task` returned.
async function edit(character, sheet, task) {
  return attempt(() => withSheet(character, sheet, async (runtime) => {
    const done = await task(runtime);
    const { attrs, sections } = runtime.snapshot();
    const record = { ...character, attrs, sections, name: displayName(attrs), sheetVersion: sheet.version };
    delete record.id;
    return { record, done };
  }));
}

async function save(library, current, record) {
  try {
    return await library.save(current.character.id, record, current.version);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    throw new ToolError(`Someone saved "${record.name}" while this edit ran, so it wasn't saved. Read it again and redo the edit.`);
  }
}

function checkWrite() {
  if (!allowWrite()) throw new ToolError('Too many saves right now (the library takes 60 a minute). Try again in a minute.');
}

// Turns the edit, roll and sheet modules' errors into tool errors.
async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof EditError || err instanceof RollError || err instanceof SheetBusyError) throw new ToolError(err.message);
    throw err;
  }
}

const listChanges = (done) => (done?.length ? `\nChanges:\n${done.map((d) => `- ${d}`).join('\n')}` : '');

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
