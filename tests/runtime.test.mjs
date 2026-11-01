// Tests for the sheet running in Node (lib/sheet-runtime.mjs), the rolls and
// edits built on it. tests/sheet.test.mjs compares it with the browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { applyChanges, EditError } from '../lib/character-edit.mjs';
import { findRoll, RollError, rollCommands } from '../lib/rolls.mjs';
import { loadSheetInfo } from '../lib/sheet-html.mjs';
import { SheetBusyError, withSheet } from '../lib/sheet-runtime.mjs';
import { projectRoot } from './helpers.mjs';

const sheet = loadSheetInfo();
const newCharacter = () => ({ id: 'c-test', attrs: { ...sheet.newCharacterAttrs, character_name: 'New character' }, sections: {} });
const mage = async () => ({ id: 'c-mage', ...JSON.parse(await readFile(path.join(projectRoot, 'tests/fixtures/artillery-mage.json'), 'utf8')).characters[0] });
const commands = (result) => result.commands.map((c) => c.text);

describe('sheet in Node', () => {
  test('computes what the sheet computes for a player’s edits', async () => {
    const attrs = await withSheet(newCharacter(), sheet, async (runtime) => {
      await applyChanges(runtime, sheet, [
        { action: 'set', values: { character_name: 'Sir Testalot', strength_points: 20 } },
        { action: 'add_row', section: 'skills', values: { name: 'Broadsword', base: 'DX', difficulty: 'A', points: 4 } },
        { action: 'add_row', section: 'repeating_skills', values: { name: 'Stealth', base: '@{dexterity}', difficulty: '-2', points: '1' } },
      ]);
      assert.deepEqual(runtime.errors, [], 'no errors from the sheet code');
      return runtime.snapshot();
    });
    assert.equal(attrs.attrs.strength, 12);
    assert.equal(attrs.attrs.hit_points_max, 12);
    assert.equal(attrs.attrs.swing, '1d6+2');
    assert.deepEqual(attrs.sections.repeating_skills.map((row) => attrs.attrs[`repeating_skills_${row}_level`]), [11, 9]);
    assert.equal(attrs.attrs.skills_points, 5);
  });

  test('updates and removes rows by name, and the totals follow', async () => {
    const result = await withSheet(await mage(), sheet, async (runtime) => {
      const done = await applyChanges(runtime, sheet, [
        { action: 'update_row', section: 'skills', row: 'staff', values: { points: 8 } },
        { action: 'remove_row', section: 'traits', row: 'Wealth' },
      ]);
      return { done, ...runtime.snapshot() };
    });
    assert.match(result.done[0], /^changed repeating_skills row -\S+ \(Staff\): points = "8"$/);
    assert.match(result.done[1], /^removed repeating_traits row -\S+ \(Wealth\)$/);
    const staff = result.sections.repeating_skills.find((row) => result.attrs[`repeating_skills_${row}_name`] === 'Staff');
    assert.equal(result.attrs[`repeating_skills_${staff}_level`], 12);
    assert.equal(result.attrs.skills_points, 16);
    assert.equal(result.attrs.advantages_points, 49);
    assert.ok(!Object.keys(result.attrs).some((key) => result.attrs[key] === 'Wealth'), 'the row’s fields are gone');
  });

  test('refuses edits the sheet wouldn’t take, before changing anything', async () => {
    const refused = (changes, pattern) =>
      assert.rejects(withSheet(newCharacter(), sheet, (runtime) => applyChanges(runtime, sheet, changes)), (err) => err instanceof EditError && pattern.test(err.message));
    await refused([{ action: 'set', values: { dodge: 12 } }], /"dodge" is computed by the sheet/);
    await refused([{ action: 'set', values: { strenght_points: 12 } }], /no field "strenght_points"/);
    await refused([{ action: 'set', values: { strength_points: 'lots' } }], /must be a number/);
    await refused([{ action: 'add_row', section: 'skills', values: { difficulty: 'Medium' } }], /-2 \(A\)/);
    await refused([{ action: 'add_row', section: 'powers', values: { name: 'x' } }], /"section" must be one of .*skills/);
    await refused([{ action: 'update_row', section: 'skills', row: 'Juggling', values: { points: 1 } }], /No skills row "Juggling"/);
    await refused([{ action: 'fly' }], /action must be/);
  });

  test('gives the Roll20 commands the app gives', async () => {
    const character = await mage();
    await withSheet(character, sheet, async (runtime) => {
      const roll = (args, options) => rollCommands(runtime, sheet, findRoll(character, sheet, args), options);
      assert.deepEqual(commands(await roll({ roll: 'Staff' }, { modifier: -2 })), ['/roll {3d6[Staff],0d0+99}<9']);
      assert.deepEqual(commands(await roll({ roll: 'Quarterstaff (Staff Swing)', damage: true })), ['/roll { 1d6[Quarterstaff (Staff Swing)]+1, {0} }kh1']);
      const fireball = await roll({ roll: 'Fireball', damage: true }, { answers: { '# of Die': '3d6' } });
      assert.deepEqual(commands(fireball), ['/roll { 3d6[Fireball], {1} }kh1']);
      assert.equal(fireball.prompts[0].prompt, '# of Die');
      assert.deepEqual(commands(await roll({ roll: 'IQ' }, { modifier: 1 })), ['/roll {3d6[Intelligence Roll],0d0+99}<14']);
      assert.deepEqual(commands(await roll({ roll: 'swing' })), ['/roll {1d6[Swing Damage]-1, {0}}kh1']);
      assert.deepEqual(commands(await roll({ roll: 'Dodge' })), ['/roll {3d6[Dodge],0d0+99}<8']);
    });

    const parry = findRoll(character, sheet, { roll: 'Quarterstaff (Staff Swing)' });
    assert.equal(parry.kind, 'melee', 'an attack before the parry with the same name');
    assert.deepEqual(parry.others, ['defense']);
    assert.equal(findRoll(character, sheet, { roll: 'Quarterstaff (Staff Swing)', kind: 'defense' }).row.section, 'repeating_defense');
    assert.throws(() => findRoll(character, sheet, { roll: 'Quarterstaff' }), (err) => err instanceof RollError && /could be .*Staff Swing.*Staff Thrust/.test(err.message));
    assert.throws(() => findRoll(character, sheet, { roll: 'Juggling' }), (err) => err instanceof RollError && /No roll called "Juggling"\. .*Fright Check.* The character's: .*Staff \(skill\)/.test(err.message));

    // Two attacks with the same name: the row id picks one.
    const punch = character.sections.repeating_melee.find((row) => character.attrs[`repeating_melee_${row}_name`] === 'Punch');
    const twin = '-twinpunch';
    for (const [key, value] of Object.entries(character.attrs)) {
      if (key.startsWith(`repeating_melee_${punch}_`)) character.attrs[key.replace(punch, twin)] = value;
    }
    character.sections.repeating_melee.push(twin);
    assert.throws(() => findRoll(character, sheet, { roll: 'Punch' }), (err) => err instanceof RollError && /Several melee rows are called "Punch": -\S+ \(skill 10\), -twinpunch \(skill 10\)/.test(err.message));
    assert.equal(findRoll(character, sheet, { roll: twin }).row.rowId, twin);
  });

  test('takes a few runs at a time and refuses the rest', async () => {
    let open;
    const gate = new Promise((resolve) => (open = resolve));
    const runs = Array.from({ length: 6 }, () => withSheet(newCharacter(), sheet, () => gate));
    const refused = await Promise.allSettled(runs.slice(4));
    assert.ok(refused.every((r) => r.status === 'rejected' && r.reason instanceof SheetBusyError));
    open();
    assert.ok((await Promise.allSettled(runs.slice(0, 4))).every((r) => r.status === 'fulfilled'));
  });

  test('reports a sheet that fails to start', async () => {
    const broken = { ...sheet, workerCode: 'this is not javascript' };
    await assert.rejects(withSheet(newCharacter(), broken, () => {}), /The sheet failed to start/);
    // The next one still runs.
    assert.equal(await withSheet(newCharacter(), sheet, (runtime) => runtime.attrs.character_name), 'New character');
  });
});
