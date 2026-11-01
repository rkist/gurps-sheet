// Roll20 chat commands for a character, as the app's roll buttons give them:
// the button's macro (for action buttons, from the sheet's own click handler,
// run in lib/sheet-runtime.mjs), its @{attributes} filled in and its ?{prompts}
// answered, then buildRoll() from public/js/roll20.js.
import { lookup } from '../public/js/attributes.js';
import { answerQueries, buildRoll, expandAttributes, findQueries } from '../public/js/roll20.js';

export class RollError extends Error {}

// The rolls of a repeating row, by section. When the same name is in several
// (an attack and its parry, a spell and its missile), the first one counts.
const ROW_ROLLS = {
  repeating_skills: { kind: 'skill', roll: 'act_skillroll' },
  repeating_techniquesrevised: { kind: 'technique', roll: 'act_skillroll' },
  repeating_spells: { kind: 'spell', roll: 'act_skillroll' },
  repeating_melee: { kind: 'melee', roll: 'act_skillroll', damage: 'act_rolldamage' },
  repeating_ranged: { kind: 'ranged', roll: 'act_skillroll', damage: 'act_rolldamage' },
  repeating_defense: { kind: 'defense', roll: 'act_skillroll' },
  repeating_traits: { kind: 'advantage', roll: 'roll_vsAFOA' },
  repeating_perks: { kind: 'perk', roll: 'roll_vsAFOA' },
  repeating_disadvantages: { kind: 'disadvantage', roll: 'roll_vsDSCR' },
  repeating_quirks: { kind: 'quirk', roll: 'roll_vsDSCR' },
  repeating_racial: { kind: 'racial', roll: 'roll_vsRSCR' },
};
export const ROLL_KINDS = [...new Set(Object.values(ROW_ROLLS).map((r) => r.kind)), 'attribute'];

// Rolls outside repeating sections: names a player would use -> button.
const NAMED_ROLLS = [
  ['ST|strength', 'act_roll_attribute_strength'],
  ['DX|dexterity', 'act_roll_attribute_dexterity'],
  ['IQ|intelligence', 'act_roll_attribute_intelligence'],
  ['HT|health', 'act_roll_attribute_health'],
  ['Per|perception', 'act_roll_attribute_perception'],
  ['Vision', 'act_roll_attribute_vision'],
  ['Hearing', 'act_roll_attribute_hearing'],
  ['Taste/Smell|smell|taste', 'act_roll_attribute_smell'],
  ['Touch', 'act_roll_attribute_touch'],
  ['Will|willpower', 'act_roll_attribute_willpower'],
  ['Fright Check|fright', 'act_roll_attribute_fright_check'],
  ['Stun Check|stun', 'act_roll_attribute_stun_check'],
  ['Knockdown Check|knockdown', 'act_roll_attribute_knockdown_check'],
  ['Unconsciousness Check|unconscious check|unconsciousness', 'act_roll_attribute_unconscious_check'],
  ['Death Check|death', 'act_roll_attribute_death_check'],
  ['Dodge', 'act_roll_active_defense_dodge'],
  ['Dodge and Retreat|dodge retreat|retreating dodge', 'act_roll_active_defense_dodge_retreat'],
  ['Dodge and Drop|dodge drop', 'act_roll_active_defense_dodge_drop'],
  ['Knockback', 'act_roll_active_defense_knockback'],
  ['Initiative', 'roll_init'],
  ['Thrust|thrust damage', 'roll_dmgThrust'],
  ['Swing|swing damage', 'roll_dmgSwing'],
].map(([names, button]) => ({ names: names.toLowerCase().split('|'), label: names.split('|')[0], button }));

const buttonOf = (sheet, name, section = null) => sheet.buttons.find((b) => b.name === name && b.section === section);

// Finds the button for a roll: { button, row, label, others }. `roll` is a row's name
// (skill, spell, attack, ...) or one of NAMED_ROLLS; `damage` picks a weapon's
// damage roll; `kind` narrows the search to one kind of row or to attributes.
export function findRoll(character, sheet, { roll, kind, damage = false }) {
  const wanted = String(roll).trim().toLowerCase();
  if (!damage && (!kind || kind === 'attribute')) {
    const named = NAMED_ROLLS.find((r) => r.names.includes(wanted));
    if (named) return { button: buttonOf(sheet, named.button), row: null, label: named.label, others: [] };
  }
  if (kind === 'attribute') throw new RollError(`No roll called "${roll}". Rolls outside the lists: ${NAMED_ROLLS.map((r) => r.label).join(', ')}.`);

  const rows = [];
  for (const [section, rolls] of Object.entries(ROW_ROLLS)) {
    if ((kind && rolls.kind !== kind) || (damage && !rolls.damage)) continue;
    for (const rowId of character.sections?.[section] || []) {
      const name = String(lookup(character.attrs, sheet, 'name', { section, rowId }) ?? '').trim();
      if (name) rows.push({ section, rowId, name, rolls });
    }
  }
  const byId = rows.filter((r) => r.rowId === wanted);
  const exact = byId.length ? byId : rows.filter((r) => r.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : rows.filter((r) => r.name.toLowerCase().includes(wanted));
  const describe = (r) => `${r.name} (${r.rolls.kind})`;
  if (!matches.length) {
    const what = damage ? 'weapon' : kind ? `${kind}` : 'roll';
    throw new RollError(
      `No ${what} called "${roll}".` +
        (damage || kind ? '' : ` Rolls outside the lists: ${NAMED_ROLLS.map((r) => r.label).join(', ')}.`) +
        (rows.length ? ` The character's: ${[...new Set(rows.map(describe))].join(', ')}.` : ''),
    );
  }
  if (new Set(matches.map((r) => r.name)).size > 1) {
    throw new RollError(`"${roll}" could be ${[...new Set(matches.map(describe))].join(', ')}. Pass the full name.`);
  }
  const [match] = matches;
  const twins = matches.filter((r) => r.rolls === match.rolls);
  if (twins.length > 1) {
    const level = (r) => lookup(character.attrs, sheet, r.section === 'repeating_skills' || r.section === 'repeating_spells' ? 'level' : 'skill', r) ?? '';
    throw new RollError(`Several ${match.rolls.kind} rows are called "${match.name}": ${twins.map((r) => `${r.rowId} (skill ${level(r)})`).join(', ')}. Pass the row id as roll.`);
  }
  const button = buttonOf(sheet, damage ? match.rolls.damage : match.rolls.roll, match.section);
  const others = [...new Set(matches.filter((r) => r.rolls !== match.rolls).map((r) => r.rolls.kind))];
  return { button, row: { section: match.section, rowId: match.rowId }, label: `${match.name}${damage ? ' damage' : ''}`, kind: match.rolls.kind, others };
}

// The commands for a roll found by findRoll(), with the character open in
// `runtime`. `modifier` answers the modifier prompt; `answers` maps other
// prompts to an answer (an option's label or value).
export async function rollCommands(runtime, sheet, { button, row }, { modifier, answers = {} } = {}) {
  let text = button.value;
  if (button.type === 'action') {
    const [started] = await runtime.click(button, row);
    if (!started) throw new RollError('The sheet started no roll for that button.');
    text = started.text;
    if (started.section && started.rowId) row = { section: started.section, rowId: started.rowId };
  }
  const macro = expandAttributes(text, (name) => lookup(runtime.attrs, sheet, name, row));
  const queries = findQueries(macro);
  const chosen = new Map();
  for (const query of queries) {
    let answer = answers[query.prompt];
    if (answer === undefined && modifier !== undefined && /modifier/i.test(query.prompt)) answer = modifier;
    if (answer === undefined) continue;
    const option = query.options?.find((o) => o.value === String(answer) || o.label.toLowerCase() === String(answer).toLowerCase());
    chosen.set(query.prompt, option ? option.value : String(answer));
  }
  const result = buildRoll(answerQueries(macro, chosen));
  return {
    ...result,
    prompts: queries.map((q) => ({ ...q, answer: chosen.has(q.prompt) ? chosen.get(q.prompt) : q.defaultValue })),
  };
}
