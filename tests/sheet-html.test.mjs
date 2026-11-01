// Unit tests for the server's reading of the sheet markup (lib/sheet-html.mjs).
// tests/sheet.test.mjs checks it against the browser's loadSheet().
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { collectDefaults, loadSheetInfo, scanFields } from '../lib/sheet-html.mjs';
import { projectRoot } from './helpers.mjs';

describe('sheet markup', () => {
  test('reads fields the way a browser parses them', () => {
    const html = `
      <input type="text" name="attr_title" title=""broken" quote" value="a &amp; b" />
      <input name="attr_plain" value=5 value=6>
      <!-- <input name="attr_commented" value="x" /> -->
      <script type="text/worker">const s = '<input name="attr_in_script">';</script>
      <input type="checkbox" name="attr_box" value="1" checked />
      <input type="checkbox" name="attr_unchecked" />
      <input type="radio" name="attr_pick" value="a" /><input type="radio" name="attr_pick" value="b" checked />
      <textarea name="attr_notes">
first line</textarea>
      <select name="attr_level"><option value="1">One</option><option value="2" selected>Two</option></select>
      <select name="attr_named"><option data-i18n="label-key">Fallback</option></select>
      <fieldset class="repeating_skills other">
        <input type="text" name="attr_name" value="" /><span name="attr_shown"></span>
      </fieldset>
      <input type="text" name="attr_after" value="top" />`;
    const fields = scanFields(html, { 'label-key': '<b>Translated</b>' });
    assert.deepEqual(
      fields.map((f) => [f.section, f.name]),
      [[null, 'title'], [null, 'plain'], [null, 'box'], [null, 'unchecked'], [null, 'pick'], [null, 'pick'], [null, 'notes'], [null, 'level'], [null, 'named'], ['repeating_skills', 'name'], [null, 'after']],
    );
    assert.equal(fields[0].value, 'a & b', 'a stray quote outside a value is part of an attribute name');
    assert.equal(fields[1].value, '5', 'the first of two attributes counts');

    const { defaults, sectionDefaults } = collectDefaults(fields);
    assert.deepEqual(defaults, { title: 'a & b', plain: '5', box: '1', unchecked: '0', pick: 'b', notes: 'first line', level: '2', named: 'Translated', after: 'top' });
    assert.deepEqual(sectionDefaults, { repeating_skills: { name: '' } });
  });

  test('reads the sheet in GURPS/', async () => {
    const sheet = loadSheetInfo();
    const meta = JSON.parse(await readFile(path.join(projectRoot, 'GURPS/UPSTREAM.json'), 'utf8'));
    assert.equal(sheet.version, meta.version);
    assert.equal(sheet.defaults.total_points, '150');
    assert.match(sheet.defaults.point_summary, /^@\{attribute_positive_total\} \+ /);
    assert.equal(sheet.sectionDefaults.repeating_skills.difficulty, '-2');
    assert.ok(sheet.fields.find((f) => f.section === 'repeating_skills' && f.name === 'difficulty').options.some((o) => o.value === '-2' && o.label === 'A'));
  });
});
