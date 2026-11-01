// End-to-end tests: the real Roll20 GURPS sheet running in headless Chrome.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { applyChanges } from '../lib/character-edit.mjs';
import { findRoll, rollCommands } from '../lib/rolls.mjs';
import { loadSheetInfo } from '../lib/sheet-html.mjs';
import { withSheet } from '../lib/sheet-runtime.mjs';
import {
  addRow,
  chromePath,
  closeBrowser,
  clickVisible,
  createSampleCharacter,
  launchBrowser,
  newCharacter,
  openApp,
  projectRoot,
  rowIds,
  rowNames,
  settle,
  showTab,
  sleep,
  startServer,
  toggleEditMode,
  typeInto,
  value,
} from './helpers.mjs';

const TIMEOUT = 120_000;
const skip = chromePath ? false : 'Chrome or Chromium not found; set CHROME_PATH';

// A character's attributes with row ids replaced by the row's position, to
// compare characters built in different places.
function byPosition({ attrs, sections }) {
  const out = {};
  for (const [key, value] of Object.entries(attrs)) {
    let name = key;
    for (const [section, ids] of Object.entries(sections)) ids.forEach((id, i) => (name = name.replace(`${section}_${id}_`, `${section}_#${i}_`)));
    out[name] = value;
  }
  return out;
}

const savedCharacter = (page) =>
  page.evaluate(async (id) => (await import(new URL('js/store.js', location.href).href)).getCharacter(id), new URL(page.url()).hash.slice(4));
// A PDF of `count` pages, each saying its page number.
function testPdf(count) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let n = 1; n <= count; n++) {
    const text = `BT /F1 36 Tf 72 700 Td (PDF page ${n}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${count} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const newCharacterInNode = (sheet) => ({ id: 'c-node', attrs: { ...sheet.newCharacterAttrs, character_name: 'New character' }, sections: {} });

describe('GURPS sheet', { skip }, () => {
  let server;
  let browser;
  let app;

  before(async () => {
    server = await startServer();
    browser = await launchBrowser();
  });

  after(async () => {
    await closeBrowser(browser);
    server?.stop();
  });

  async function open() {
    app = await openApp(browser, server.url);
    return app.page;
  }

  async function close() {
    const errors = app.errors;
    await app.context.close();
    assert.deepEqual(errors, [], 'no console errors or warnings');
  }

  test('runs the sheet’s own calculations for a new character', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page);
    await showTab(page, '1');

    assert.equal(await value(page, '#sheet-host span[name="attr_character_name"]'), 'Sir Testalot');
    assert.equal(await value(page, '#sheet-host input[name="attr_strength_display"]'), '12');
    assert.equal(await value(page, '#sheet-host input[name="attr_hit_points_max"]'), '12');
    assert.equal(await value(page, '#sheet-host input[name="attr_basic_lift"]'), '29');
    assert.equal(await value(page, '#sheet-host input[name="attr_simple_lift"]'), '29', 'auto-calc field');
    assert.equal(await value(page, '#sheet-host input[name="attr_thrust"]'), '1d6-1');
    assert.equal(await value(page, '#sheet-host input[name="attr_swing"]'), '1d6+2');
    await close();
  });

  test('shows only the selected tab', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    // Regression: unclosed <b> tags in gurps.html used to wrap these tabs and keep them visible.
    const visible = (selector) => page.$eval(selector, (el) => el.offsetHeight > 0);
    assert.equal(await visible('#sheet-host div.sheet-tab7'), false, 'Updates tab hidden');
    assert.equal(await visible('#sheet-host div.sheet-tab-chase'), false, 'Chases tab hidden');
    assert.ok((await page.$eval('#sheet-host', (el) => el.scrollHeight)) < 3000, 'General tab has a normal height');
    await showTab(page, '7');
    assert.equal(await visible('#sheet-host div.sheet-tab7'), true, 'Updates tab shown when selected');
    await close();
  });

  test('builds the same character in Node as in the browser', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page);
    const inBrowser = await savedCharacter(page);
    const sheet = loadSheetInfo();
    const inNode = await withSheet(newCharacterInNode(sheet), sheet, async (runtime) => {
      await applyChanges(runtime, sheet, [
        { action: 'set', values: { character_name: 'Sir Testalot', strength_points: 20, tab: 3 } },
        { action: 'add_row', section: 'skills', values: { name: 'Broadsword', base: 'DX', difficulty: 'A', points: 4 } },
        { action: 'add_row', section: 'skills', values: { name: 'Stealth', base: 'DX', difficulty: 'A', points: 1 } },
      ]);
      return runtime.snapshot();
    });
    assert.deepEqual(byPosition(inNode), byPosition(inBrowser));
    await close();
  });

  test('computes skill levels and point totals', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page);

    const [broadsword, stealth] = await rowIds(page, 'skills');
    assert.equal(await value(page, `#sheet-host .repitem[data-reprowid="${broadsword}"] input[name="attr_level"]`), '11');
    assert.equal(await value(page, `#sheet-host .repitem[data-reprowid="${stealth}"] input[name="attr_level"]`), '9');
    assert.equal(await value(page, '#sheet-host [name="attr_skills_points"]'), '5');
    assert.equal(await value(page, '#sheet-host input[name="attr_point_summary"]'), '25', 'spent: 20 for ST + 5 for skills');
    assert.equal(await value(page, '#sheet-host input[name="attr_point_diff"]'), '125', 'unspent of 150');
    await close();
  });

  test('reorders and deletes repeating rows', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page);
    const [first, second] = await rowIds(page, 'skills');

    await toggleEditMode(page, 'skills');
    const handle = await (await page.$(`#sheet-host .repitem[data-reprowid="${second}"] .repcontrol_move`)).boundingBox();
    const target = await (await page.$(`#sheet-host .repitem[data-reprowid="${first}"]`)).boundingBox();
    await page.mouse.move(handle.x + 5, handle.y + 5);
    await page.mouse.down();
    await page.mouse.move(handle.x + 5, target.y + 2, { steps: 8 });
    await page.mouse.up();
    assert.deepEqual(await rowNames(page, 'skills'), ['Stealth', 'Broadsword']);

    await page.click(`#sheet-host .repitem[data-reprowid="${first}"] .repcontrol_del`);
    await settle(page);
    assert.deepEqual(await rowNames(page, 'skills'), ['Stealth']);
    assert.equal(await value(page, '#sheet-host [name="attr_skills_points"]'), '1');
    await toggleEditMode(page, 'skills');
    await close();
  });

  test('keeps characters across reloads', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page);
    await showTab(page, '1');
    const url = page.url();

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.view === 'sheet');
    await settle(page);
    assert.equal(page.url(), url);
    assert.equal(await value(page, '#character-name'), 'Sir Testalot');
    assert.equal(await value(page, '#sheet-host input[name="attr_strength_display"]'), '12');
    assert.deepEqual(await rowNames(page, 'skills'), ['Broadsword', 'Stealth']);
    await close();
  });

  test('exports a character and imports it as a new one', { timeout: TIMEOUT }, async () => {
    const page = await open();
    const downloads = await mkdtemp(path.join(os.tmpdir(), 'gurps-sheet-test-'));
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
        browserContextId: app.context.id,
      });

      await createSampleCharacter(page);
      const originalUrl = page.url();
      await page.click('#export-character');
      let file;
      for (let i = 0; i < 50 && !file; i++) {
        await sleep(200);
        file = (await readdir(downloads)).find((f) => f.endsWith('.gurps.json'));
      }
      assert.equal(file, 'sir-testalot.gurps.json');

      await page.click('.app-sheet-only a[href="#/"]');
      await page.waitForFunction(() => document.body.dataset.view === 'home');
      const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#import-character')]);
      await chooser.accept([path.join(downloads, file)]);
      await page.waitForFunction((url) => document.body.dataset.view === 'sheet' && location.href !== url, {}, originalUrl);
      await settle(page);

      assert.equal(await value(page, '#character-name'), 'Sir Testalot');
      assert.equal(await value(page, '#sheet-host input[name="attr_strength_display"]'), '12');
      assert.deepEqual(await rowNames(page, 'skills'), ['Broadsword', 'Stealth']);

      await page.click('.app-sheet-only a[href="#/"]');
      await page.waitForFunction(() => document.querySelectorAll('#character-list li').length === 2);
    } finally {
      await rm(downloads, { recursive: true, force: true });
    }
    await close();
  });

  test('switches the sheet language and keeps the character open', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await createSampleCharacter(page, []);
    await page.select('#language', 'pt');
    await page.waitForFunction(
      () => document.querySelector('#sheet-host input[name="attr_tab"][value="3"] + span')?.textContent === 'Perícias',
      { timeout: 30000 },
    );
    await settle(page);
    assert.equal(await value(page, '#character-name'), 'Sir Testalot');
    await close();
  });

  test('runs the sheet’s built-in GCS importer', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    const { readFile } = await import('node:fs/promises');
    const json = await readFile(path.join(projectRoot, 'GURPS/readme/assets/Artillery Mage (NPC) export.json'), 'utf8');

    await page.evaluate((data) => {
      const textarea = document.querySelector('#sheet-host textarea[name="attr_character_json_data"]');
      textarea.value = data;
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, json);
    await page.evaluate(() => document.querySelector('#sheet-host button[name="act_import_json"]').click());
    await sleep(1000);
    await settle(page, 1500);

    assert.match(await value(page, '#sheet-host [name="attr_import_json_message"]'), /Import has completed/);
    assert.equal((await rowIds(page, 'spells')).length, 31);
    assert.equal((await rowIds(page, 'melee')).length, 10);
    assert.equal((await rowIds(page, 'ranged')).length, 5);

    // The same import in Node, and a weapon's damage roll, whose macro the sheet's code puts together.
    const inBrowser = await savedCharacter(page);
    const sheet = loadSheetInfo();
    const weapon = 'Quarterstaff (Staff Swing)';
    const inNode = await withSheet(newCharacterInNode(sheet), sheet, async (runtime) => {
      await runtime.change('character_json_data', json);
      await runtime.click(sheet.buttons.find((b) => b.name === 'act_import_json'));
      const character = { id: 'c-node', ...runtime.snapshot() };
      const damage = await rollCommands(runtime, sheet, findRoll(character, sheet, { roll: weapon, damage: true }));
      return { ...character, damage: damage.commands.map((c) => c.text) };
    });
    assert.deepEqual(byPosition(inNode), byPosition(inBrowser));

    const row = (await rowIds(page, 'melee'))[(await rowNames(page, 'melee')).indexOf(weapon)];
    await page.$eval(`#sheet-host .repitem[data-reprowid="${row}"] button[name="act_rolldamage"]`, (button) => button.click());
    await page.waitForSelector('#roll-panel:not([hidden])');
    assert.deepEqual(await page.$$eval('#roll-panel .app-roll code', (codes) => codes.map((c) => c.textContent)), inNode.damage);
    await close();
  });

  test('gives the Roll20 command for a skill roll, after asking for the modifier', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await app.context.overridePermissions(new URL(server.url).origin, ['clipboard-read', 'clipboard-sanitized-write']);
    await createSampleCharacter(page);
    const [broadsword] = await rowIds(page, 'skills');

    await clickVisible(page, `#sheet-host .repitem[data-reprowid="${broadsword}"] button[name="act_skillroll"]`);
    await page.waitForSelector('#roll-dialog[open]');
    assert.equal(await value(page, '#roll-dialog .app-dialog-title'), 'Broadsword');
    assert.equal(await value(page, '#roll-dialog .app-field span'), 'Modifier');
    assert.equal(await value(page, '#roll-dialog input'), '0');
    await page.keyboard.type('-2');
    await page.keyboard.press('Enter');

    const command = '/roll {3d6[Broadsword],0d0+99}<9';
    await page.waitForFunction(() => document.querySelector('#roll-panel .app-roll-copy')?.textContent === 'Copied');
    assert.equal(await value(page, '#roll-panel .app-roll code'), command, 'skill 11 with a -2 modifier');
    assert.equal(await value(page, '#roll-panel .app-roll-hint'), 'Succeeds on 9 or less');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), command);
    await close();
  });

  test('gives the Roll20 command for damage, and nothing when a prompt is cancelled', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    await clickVisible(page, '#sheet-host button[name="roll_dmgSwing"]');
    await page.waitForSelector('#roll-panel:not([hidden])');
    assert.equal(await value(page, '#roll-panel .app-roll code'), '/roll {1d6[Swing Damage], {0}}kh1', 'ST 10 swing');

    await clickVisible(page, '#sheet-host button[name="act_roll_attribute_strength"]');
    await page.waitForSelector('#roll-dialog[open]');
    await page.keyboard.press('Escape');
    await sleep(300);
    assert.equal(await page.$$eval('#roll-panel .app-roll', (rolls) => rolls.length), 1, 'no new command');
    await close();
  });

  test('opens the links on the sheet’s help buttons', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    const opened = new Promise((resolve) => app.context.once('targetcreated', (target) => resolve(target.url())));
    await clickVisible(page, '#sheet-host button[name="roll_blank"]');
    assert.match(await opened, /^https:\/\//);
    // The block of links and notices at the bottom of the sheet.
    const footer = await page.$eval('#sheet-host [data-i18n="gurps-4th-edition-wiki-button"]', (el) => el.closest('.logo').textContent);
    assert.match(footer, /GURPS 4th Edition Roll20 Wiki Page/, 'the wiki link stays');
    assert.doesNotMatch(footer, /trademark|feedback|forum|discord/i, 'the trademark notice, forum and Discord lines are left out');
    await close();
  });

  test('opens a Ref’s page in the player’s own PDF', { timeout: TIMEOUT }, async () => {
    const page = await open();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gurps-sheet-test-'));
    try {
      const pdf = path.join(dir, 'GURPS Magic.pdf');
      await writeFile(pdf, testPdf(30));
      const ref = '#sheet-host .repcontainer[data-groupname="repeating_traits"] input[name="attr_ref"]';
      const focusRef = () =>
        page.evaluate((sel) => {
          const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent);
          el.scrollIntoView({ block: 'center' });
          el.focus();
        }, ref);
      const links = () => page.$eval('#ref-links', (el) => (el.hidden ? null : [...el.children].map((b) => b.textContent)));

      await newCharacter(page);
      await showTab(page, '2');
      await addRow(page, 'traits');
      await typeInto(page, ref, 'M23, B243');
      assert.equal(await links(), null, 'the popover goes with the focus');
      await focusRef();
      assert.deepEqual(await links(), ['No PDF for M, B']);

      await page.click('#ref-links .app-ref-missing');
      await page.waitForSelector('#books-dialog[open]');
      const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#books-dialog [data-action="add"]')]);
      await chooser.accept([pdf]);
      await page.waitForSelector('#books-dialog .app-book');
      assert.equal(await value(page, '#books-dialog [name="code"]'), 'M', 'the code comes from the file name');
      await typeInto(page, '#books-dialog [name="pdf"]', 3); // printed page 1 is PDF page 3
      await page.click('#books-dialog button[type="submit"]');

      await focusRef();
      assert.deepEqual(await links(), ['M23', 'No PDF for B']);
      // From the keyboard: the down arrow reaches the links.
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'M23');
      const opened = new Promise((resolve) => app.context.once('targetcreated', resolve));
      await page.keyboard.press('Enter');
      const tab = await opened;
      assert.match(tab.url(), /^blob:http.*#page=25$/);
      await (await tab.page()).close(); // the context doesn't close while a PDF is open

      // The PDF stays in the browser.
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.body.dataset.view === 'sheet');
      await page.click('#open-books');
      await page.waitForSelector('#books-dialog .app-book');
      assert.equal(await value(page, '#books-dialog .app-book-name'), 'GURPS Magic.pdf');
      assert.equal(await value(page, '#books-dialog [name="pdf"]'), '3');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await close();
  });

  test('gives the server the same field defaults as the browser', { timeout: TIMEOUT }, async () => {
    const page = await open();
    const inBrowser = await page.evaluate(async () => {
      const { loadSheet } = await import(new URL('js/sheet-loader.js', location.href).href);
      const { defaults, sectionDefaults, workerUrl } = await loadSheet('en');
      URL.revokeObjectURL(workerUrl);
      return { defaults, sectionDefaults };
    });
    const onServer = loadSheetInfo();
    // In the browser, a tooltip's markup is replaced by its English translation,
    // which has a typo (value"0") that leaves this hidden field without a default.
    assert.deepEqual({ ...inBrowser.defaults, spell_on_count: '0' }, onServer.defaults);
    assert.deepEqual(inBrowser.sectionDefaults, onServer.sectionDefaults);
    await close();
  });

  test('adds rows from the +Add button', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    await showTab(page, '2');
    await addRow(page, 'traits');
    await addRow(page, 'traits');
    assert.equal((await rowIds(page, 'traits')).length, 2);
    await close();
  });
});
