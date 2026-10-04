// End-to-end tests: the real Roll20 GURPS sheet running in headless Chrome.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  addRow,
  chromePath,
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
  value,
} from './helpers.mjs';

const TIMEOUT = 120_000;
const skip = chromePath ? false : 'Chrome or Chromium not found; set CHROME_PATH';

describe('GURPS sheet', { skip }, () => {
  let server;
  let browser;
  let app;

  before(async () => {
    server = await startServer();
    browser = await launchBrowser();
  });

  after(async () => {
    await browser?.close();
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
    await close();
  });

  test('explains that dice rolling is not available yet', { timeout: TIMEOUT }, async () => {
    const page = await open();
    await newCharacter(page);
    await page.evaluate(() => [...document.querySelectorAll('#sheet-host button[type="roll"]')].find((b) => b.offsetParent).click());
    await page.waitForFunction(() => !document.getElementById('toast').hidden);
    assert.match(await value(page, '#toast'), /Dice rolling/);
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
