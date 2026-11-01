// A readable summary of a character for the MCP tools: identity, points,
// attributes and the rows of the main sections, with the values the sheet
// shows (auto-calc fields computed, select values as their labels).
import { shownValue, valueOf } from '../public/js/attributes.js';

const POINTS = [
  ['attributes', 'attribute_positive_total', 'attribute_negative_total'],
  ['advantages', 'advantages_points'],
  ['perks', 'advantages_perks'],
  ['disadvantages', 'disadvantages_points'],
  ['quirks', 'disadvantages_quirks'],
  ['racial', 'racial_points'],
  ['skills', 'skills_points'],
  ['techniques', 'techniques_points', 'techniques_revised_points'],
  ['spells', 'spells_points'],
  ['languages', 'languages_points'],
  ['cultures', 'cf_points'],
  ['TL', 'tl_pts'],
  ['other', 'misc_points_detailed'],
];

const text = (value) => (value == null ? '' : String(value).trim());
const number = (value) => Number(text(value)) || 0;
const short = (value, max = 90) => {
  const line = text(value).replace(/<[^>]*>/g, '').split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
// ?{Prompt|options...} in a stored roll, e.g. a spell's damage, as [Prompt].
const withoutQueries = (value) => text(value).replace(/\?\{([^|}]*)(\|[^}]*)?\}/g, (_, prompt) => `[${prompt.trim()}]`);
const join = (...parts) => parts.filter(Boolean).join(', ');

export function summarize(character, sheet) {
  const { attrs, sections = {} } = character;
  const labels = optionLabels(sheet);
  const value = (key) => text(shownValue(attrs, sheet, key));
  const rows = (section) =>
    (sections[section] || []).map((rowId) => {
      const row = { section, rowId };
      const get = (field) => text(shownValue(attrs, sheet, `${section}_${rowId}_${field}`, row));
      // Select values can be formulas themselves (a skill's base is "@{dexterity}").
      get.label = (field) => {
        const raw = text(valueOf(attrs, sheet, `${section}_${rowId}_${field}`));
        return labels.get(`${section}|${field}`)?.get(raw) ?? get(field);
      };
      return get;
    });
  const out = [];
  const list = (title, section, line) => {
    const lines = rows(section)
      .filter((get) => get('name'))
      .map((get) => `- ${line(get)}`);
    if (lines.length) out.push('', `## ${title}`, ...lines);
  };
  const cost = (get) => `[${get('points') || 0}]`;

  out.push(`# ${value('character_name') || character.name || 'Unnamed character'}`);
  const fullname = value('fullname');
  const identity = [
    fullname && fullname !== value('character_name') ? fullname : '',
    value('playername') && `player ${value('playername')}`,
    value('race'),
    value('tl') && `TL ${value('tl')}`,
  ].filter(Boolean);
  if (identity.length) out.push(identity.join(' · '));
  out.push(`Points: ${value('total_points')} total, ${value('point_summary')} spent, ${value('point_diff')} unspent`);
  const breakdown = POINTS.map(([label, ...keys]) => [label, keys.reduce((sum, key) => sum + number(value(key)), 0)])
    .filter(([, points]) => points)
    .map(([label, points]) => `${label} ${points}`);
  if (breakdown.length) out.push(`(${breakdown.join(', ')})`);

  out.push(
    '',
    '## Attributes',
    `ST ${value('strength')} · DX ${value('dexterity')} · IQ ${value('intelligence')} · HT ${value('health')}`,
    `HP ${value('hit_points')}/${value('hit_points_max')} · Will ${value('willpower')} · Per ${value('perception')} · FP ${value('fatigue_points')}/${value('fatigue_points_max')}`,
    `Basic Speed ${value('basic_speed')} · Basic Move ${value('basic_move')} · Dodge ${value('dodge')} · Basic Lift ${value('basic_lift')} · Thrust ${value('thrust')} · Swing ${value('swing')}`,
  );
  const current = join(value('current_move') && `Move ${value('current_move')}`, value('current_dodge') && `Dodge ${value('current_dodge')}`);
  if (current) out.push(`With encumbrance: ${current}`);

  const level = (get) => (['', '0', '1'].includes(get('trait_level')) ? '' : ` ${get('trait_level')}`);
  const notes = (get) => (short(get('notes')) ? ` — ${short(get('notes'))}` : '');
  list('Advantages', 'repeating_traits', (get) => `${get('name')}${level(get)} ${cost(get)}${notes(get)}`);
  list('Perks', 'repeating_perks', (get) => `${get('name')} ${cost(get)}`);
  list('Disadvantages', 'repeating_disadvantages', (get) =>
    `${get('name')}${level(get)}${get('control_rating') ? ` (${get('control_rating')})` : ''} ${cost(get)}${notes(get)}`,
  );
  list('Quirks', 'repeating_quirks', (get) => `${get('name')} ${cost(get)}`);
  list('Racial traits', 'repeating_racial', (get) => `${get('name')}${level(get)} ${cost(get)}`);
  list('Cultures', 'repeating_cultures', (get) => `${get('name')} ${cost(get)}`);
  list('Languages', 'repeating_languages', (get) =>
    `${get('name')}: spoken ${get.label('spoken')}, written ${get.label('written')} ${cost(get)}`,
  );
  list('Skills', 'repeating_skills', (get) =>
    `${get('name')}${get('tl') ? `/TL${get('tl')}` : ''} (${get.label('base')}/${get.label('difficulty')}) ${get('level')} ${cost(get)}`,
  );
  list('Techniques', 'repeating_techniques', (get) => `${get('name')}${get('parent') ? ` (${get('parent')})` : ''} ${get('level')} ${cost(get)}`);
  list('Techniques', 'repeating_techniquesrevised', (get) =>
    `${get('name')}${get('parent') ? ` (${get('parent')})` : ''} ${get('level')} ${cost(get)}`,
  );
  list('Spells', 'repeating_spells', (get) => {
    const college = [get('spell_college'), get('spell_class')].filter(Boolean).join('/');
    return `${get('name')} (${get.label('difficulty')}) ${get('level')} ${cost(get)} — ${join(
      college,
      get('cost') && `cost ${get('cost')}`,
      get('casttime') && `time ${get('casttime')}`,
      get('duration') && `duration ${get('duration')}`,
    )}`;
  });
  list('Melee attacks', 'repeating_melee', (get) =>
    `${get('name')}: ${join(`${withoutQueries(get('damage'))} ${get.label('type')}`.trim(), get('reach') && `reach ${get('reach')}`, `skill ${get('skill')}`)}`,
  );
  list('Ranged attacks', 'repeating_ranged', (get) =>
    `${get('name')}: ${join(
      `${withoutQueries(get('damage'))} ${get.label('type')}`.trim(),
      get('acc') && `Acc ${get('acc')}`,
      get('range') && `range ${get('range')}`,
      get('rof') && `RoF ${get('rof')}`,
      get('shots') && `shots ${get('shots')}`,
      get('bulk') && `Bulk ${get('bulk')}`,
      `skill ${get('skill')}`,
    )}`,
  );
  list('Defenses', 'repeating_defense', (get) => `${get('name')}: ${get.label('type')} ${get('skill_final')}`);
  list('Equipment', 'repeating_item', (get) => {
    const indent = '  '.repeat(Math.min(number(get('indent_level')), 5));
    const count = number(get('count')) > 1 ? ` ×${get('count')}` : '';
    return `${indent}${get('name')}${count}${get('weight') ? `, ${get('weight')} ${value('weight_system') || 'lbs'}` : ''}${get('cost') ? `, $${get('cost')}` : ''}`;
  });
  if (rows('repeating_item').length) out.push(`Total: ${value('total_weight') || 0} ${value('weight_system') || 'lbs'}, $${value('total_value') || 0}`);

  return out.join('\n');
}

const labelCache = new WeakMap();

// "section|field" -> Map of select value -> label.
function optionLabels(sheet) {
  if (labelCache.has(sheet)) return labelCache.get(sheet);
  const labels = new Map();
  for (const field of sheet.fields || []) {
    if (!field.options) continue;
    const key = `${field.section}|${field.name}`;
    const map = labels.get(key) || new Map();
    for (const option of field.options) if (!map.has(option.value)) map.set(option.value, option.label);
    labels.set(key, map);
  }
  labelCache.set(sheet, labels);
  return labels;
}
