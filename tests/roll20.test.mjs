// Unit tests for turning the sheet's roll macros into Roll20 chat commands.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerQueries, buildRoll, evaluate, expandAttributes, findQueries } from '../public/js/roll20.js';

// Macros as they appear in gurps.html.
const STRENGTH_CHECK =
  '@{roll}&{template:skillRoll} {{sheetStyle=@{chatstyle}}} {{type=Attribute Check}} {{activeDefense=[[0]]}} ' +
  '{{characterName=@{character_name}}} {{skillName=Strength Roll}} {{rollResult=[[3d6cs<1cf>6]]}} ' +
  '{{effectiveSkill=[[@{strength_display} + @{modifier}]]}} {{useCriticalPlusTen=[[@{use_critical_plus_10}]]}}';
const THRUST_DAMAGE =
  '@{roll}&{template:skillRoll} {{sheetStyle=@{chatstyle}}} {{type=Damage Roll}} {{characterName=@{character_name}}} ' +
  '{{skillName=Thrust Damage}} {{damageRoll=[[{@{thrust}, {0}}kh1]]}} {{damageType=Crushing (cr)}}';
const INITIATIVE =
  '@{speed_tracker} [[[[@{selected|Basic_Speed}]]+[[(@{selected|dexterity}/100)]] &{tracker:=}]] ' +
  '&{template:addToTracker} {{characterName=@{character_name}}} ' +
  '{{skillName=Added to the Turn Order as [[ [[@{selected|Basic_Speed}]]+[[(@{selected|dexterity}/100)]] ]]}}';

const attrs = {
  roll: '',
  chatstyle: '',
  character_name: 'Sir Testalot',
  strength_display: '12',
  modifier: '[[?{Modifier|0}]]',
  use_critical_plus_10: '0',
  thrust: '1d6-1',
  speed_tracker: '/em',
  basic_speed: '6',
  dexterity: '12',
};
const lookup = (name) => attrs[name];

function commandsFor(macro, answers = {}, overrides = {}) {
  const text = expandAttributes(macro, (name) => (name in overrides ? overrides[name] : lookup(name)));
  return buildRoll(answerQueries(text, new Map(Object.entries(answers))));
}

describe('expandAttributes', () => {
  test('replaces references, including ones inside attribute values', () => {
    const values = { disadvantage_roll: '@{roll}', roll: '/w gm', name: 'Stealth' };
    assert.equal(expandAttributes('@{disadvantage_roll} @{Name}', (n) => values[n]), '/w gm Stealth');
  });

  test('reads @{selected|x} from the character and leaves @{target|x} alone', () => {
    assert.equal(expandAttributes('@{selected|Basic_Speed} @{target|token_name}', lookup), '6 @{target|token_name}');
  });

  test('treats missing attributes as empty and stops on loops', () => {
    assert.equal(expandAttributes('[@{nothing}]', lookup), '[]');
    assert.equal(expandAttributes('@{a}', (n) => ({ a: '@{b}', b: '@{a}' })[n]).startsWith('@{'), true);
  });
});

describe('queries', () => {
  test('finds each prompt once, with its default', () => {
    const text = '[[?{Modifier|0}]] + [[?{Shock|0}]] + [[?{Modifier|0}]]';
    assert.deepEqual(findQueries(text), [
      { prompt: 'Modifier', defaultValue: '0', options: null },
      { prompt: 'Shock', defaultValue: '0', options: null },
    ]);
    assert.equal(answerQueries(text, new Map([['Modifier', '-2']])), '[[-2]] + [[0]] + [[-2]]');
  });

  test('reads dropdown options, with or without separate labels', () => {
    const [plain] = findQueries('?{# of Die|1d6|2d6-1}');
    assert.deepEqual(plain.options.map((o) => o.value), ['1d6', '2d6-1']);
    assert.equal(plain.defaultValue, '1d6');
    const [labelled] = findQueries('?{Location|Torso,0|Skull,-7}');
    assert.deepEqual(labelled.options, [
      { label: 'Torso', value: '0' },
      { label: 'Skull', value: '-7' },
    ]);
  });
});

describe('evaluate', () => {
  test('does arithmetic, functions and keep/drop groups', () => {
    assert.equal(evaluate('12 + -2'), 10);
    assert.equal(evaluate('floor( (10 * 3) / 4 )'), 7);
    assert.equal(evaluate('{13 + -2 + 0, 9 }kl1'), 9);
    assert.equal(evaluate('{5, {0}}kh1'), 5);
    assert.equal(evaluate('{1, 5, 3}dl1'), 8);
    assert.equal(evaluate('6+(12/100)'), 6.12);
  });

  test('ignores labels and rejects anything else', () => {
    assert.equal(evaluate('5[Bonus] + 2'), 7);
    assert.throws(() => evaluate('3d6'));
    assert.throws(() => evaluate('2 +'));
  });
});

describe('buildRoll', () => {
  test('turns a success roll into a group roll against the effective skill', () => {
    const roll = commandsFor(STRENGTH_CHECK, { Modifier: '-2' });
    assert.equal(roll.title, 'Strength Roll');
    assert.equal(roll.subtitle, 'Attribute Check');
    assert.deepEqual(roll.commands, [{ text: '/roll {3d6[Strength Roll],0d0+99}<10', target: 10 }]);
  });

  test('keeps the filler roll above skills of 99 or more', () => {
    const roll = commandsFor(STRENGTH_CHECK, {}, { strength_display: '120' });
    assert.equal(roll.commands[0].text, '/roll {3d6[Strength Roll],0d0+121}<120');
  });

  test('evaluates the sheet’s max-nine cap on effective skill', () => {
    const text = '&{template:skillRoll} {{skillName=Broadsword}} {{rollResult=[[3d6cs<1cf>6]]}} ' +
      '{{effectiveSkill=[[{11 + [[?{Modifier|0}]] + 0, 100 }kl1]]}} {{rollDifference=[[0]]}}';
    const roll = buildRoll(answerQueries(text, new Map([['Modifier', '-2']])));
    assert.deepEqual(roll.commands, [{ text: '/roll {3d6[Broadsword],0d0+99}<9', target: 9 }]);
  });

  test('passes damage expressions through, with the label after the dice', () => {
    const roll = commandsFor(THRUST_DAMAGE);
    assert.deepEqual(roll.commands, [{ text: '/roll {1d6[Thrust Damage]-1, {0}}kh1' }]);
  });

  test('labels fixed damage too', () => {
    const roll = commandsFor(THRUST_DAMAGE, {}, { thrust: '5' });
    assert.deepEqual(roll.commands, [{ text: '/roll 5[Thrust Damage]' }]);
  });

  test('uses /gmroll when the sheet whispers rolls to the GM', () => {
    const roll = commandsFor(THRUST_DAMAGE, {}, { roll: '/w gm {{privateRoll=1}}' });
    assert.equal(roll.gm, true);
    assert.equal(roll.commands[0].text, '/gmroll {1d6[Thrust Damage]-1, {0}}kh1');
  });

  test('adds initiative to the turn order', () => {
    const roll = commandsFor(INITIATIVE);
    assert.deepEqual(roll.commands, [{ text: '/roll 6.12[Initiative] &{tracker}' }]);
  });

  test('has no commands when there is nothing to roll', () => {
    assert.deepEqual(buildRoll('https://wiki.roll20.net/Macros').commands, []);
    assert.deepEqual(buildRoll('&{template:macro} {{title=Use Item}} {{desc=Drink it.}}').commands, []);
  });
});
