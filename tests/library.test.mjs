// End-to-end tests of the app with the server's shared library: two players in
// separate browser profiles, sharing one library.
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  chromePath,
  closeBrowser,
  createSampleCharacter,
  launchBrowser,
  openApp,
  rowNames,
  settle,
  showTab,
  startLibraryServer,
  typeInto,
  value,
} from './helpers.mjs';

const TIMEOUT = 120_000;
const skip = !chromePath ? 'Chrome or Chromium not found; set CHROME_PATH' : process.env.TEST_URL ? 'needs its own server with a library' : false;
// The browser logs the answer to a save that lost a conflict; those are expected.
const CONFLICT_LOG = /status of 409/;

describe('GURPS sheet with a shared library', { skip }, () => {
  let server;
  let browser;
  const apps = [];

  before(async () => {
    server = await startLibraryServer();
    browser = await launchBrowser();
  });

  // Pages a failed test left open.
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.context.close();
  });

  after(async () => {
    await closeBrowser(browser);
    await server?.stop();
  });

  async function player() {
    const app = await openApp(browser, server.url);
    apps.push(app);
    return app;
  }

  async function finish({ allow = null } = {}) {
    for (const app of apps.splice(0)) {
      await app.context.close();
      assert.deepEqual(app.errors.filter((e) => !allow?.test(e)), [], 'no console errors or warnings');
    }
  }

  const api = async (route) => (await fetch(new URL(`api/${route}`, server.url))).json();
  const idOf = (page) => new URL(page.url()).hash.replace('#/c/', '');

  // Leaving a sheet uploads its changes; the list shows once that is done.
  async function goHome(page) {
    await page.click('.app-sheet-only a[href="#/"]');
    await page.waitForFunction(() => document.body.dataset.view === 'home');
  }

  async function open(page, id) {
    await page.click(`#character-list a[href="#/c/${id}"]`);
    await page.waitForFunction(() => document.body.dataset.view === 'sheet');
    await settle(page);
  }

  const syncStatus = (page) => value(page, '#sync-status');

  async function setStrengthPoints(page, points) {
    await showTab(page, '1');
    await typeInto(page, '#sheet-host input[name="attr_strength_points"]', points);
    await settle(page);
  }

  async function hideTab(page) {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
    });
  }

  test('shares characters: another player sees and opens them, and opening saves nothing new', { timeout: TIMEOUT }, async () => {
    const a = await player();
    assert.equal(await a.page.$eval('#library-note', (el) => el.hidden), false);
    await createSampleCharacter(a.page);
    assert.equal(await syncStatus(a.page), 'Not uploaded yet');
    const id = idOf(a.page);
    await goHome(a.page);

    const listed = await api('characters');
    assert.deepEqual(listed.characters.map((c) => [c.id, c.name]), [[id, 'Sir Testalot']]);
    assert.equal(await a.page.$eval('#library-problem', (el) => el.offsetHeight), 0, 'no problem shown');

    const b = await player();
    assert.equal(await value(b.page, '#character-list .app-card-name'), 'Sir Testalot');
    await open(b.page, id);
    assert.equal(await syncStatus(b.page), 'In the group library');
    assert.equal(await value(b.page, '#sheet-host input[name="attr_strength_display"]'), '12');
    assert.deepEqual(await rowNames(b.page, 'skills'), ['Broadsword', 'Stealth']);
    await goHome(b.page);
    assert.equal((await api(`characters/${id}/versions`)).versions.length, 1, 'opening it saved no new version');
    await finish();
  });

  test('asks which version to keep when someone else saved first, and can load theirs', { timeout: TIMEOUT }, async () => {
    const a = await player();
    await createSampleCharacter(a.page);
    const id = idOf(a.page);
    await goHome(a.page);

    const b = await player();
    await open(b.page, id);
    await open(a.page, id);
    await setStrengthPoints(a.page, 40);
    await goHome(a.page);

    await setStrengthPoints(b.page, 30);
    await hideTab(b.page);
    await b.page.waitForSelector('#choice-dialog[open]');
    assert.equal(await value(b.page, '#choice-dialog .app-dialog-title'), '"Sir Testalot" was changed elsewhere');
    await b.page.click('#choice-dialog button[value="theirs"]');
    await b.page.waitForFunction(() => document.getElementById('sync-status').textContent === 'In the group library');
    await settle(b.page);
    assert.equal(await value(b.page, '#sheet-host input[name="attr_strength_display"]'), '14', "A's ST 14");
    assert.equal((await api(`characters/${id}`)).character.attrs.strength_points, '40');
    await finish({ allow: CONFLICT_LOG });
  });

  test('asks again when changes the library refused are opened, and can keep them', { timeout: TIMEOUT }, async () => {
    const a = await player();
    await createSampleCharacter(a.page);
    const id = idOf(a.page);
    await goHome(a.page);

    const b = await player();
    await open(b.page, id);
    await open(a.page, id);
    await setStrengthPoints(a.page, 40);
    await goHome(a.page);

    // B leaves with changes the library refuses; it asks when B opens it again.
    await setStrengthPoints(b.page, 30);
    await goHome(b.page);
    assert.match(await value(b.page, '#character-list .app-card-meta'), /Not uploaded yet/);
    await b.page.click(`#character-list a[href="#/c/${id}"]`);
    await b.page.waitForSelector('#choice-dialog[open]');
    await b.page.click('#choice-dialog button[value="mine"]');
    await b.page.waitForFunction(() => document.body.dataset.view === 'sheet');
    await settle(b.page);
    assert.equal(await value(b.page, '#sheet-host input[name="attr_strength_display"]'), '13', "B's ST 13");
    await goHome(b.page);

    const current = await api(`characters/${id}`);
    assert.equal(current.character.attrs.strength_points, '30');
    assert.equal((await api(`characters/${id}/versions`)).versions.length, 3, "A's version stays in the history");
    await finish({ allow: CONFLICT_LOG });
  });

  test('uploads characters that are only in this browser, as new ones if their id is taken', { timeout: TIMEOUT }, async () => {
    await fetch(new URL('api/characters/c-taken', server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: { attrs: { character_name: 'Already There' } } }),
    });
    const a = await player();
    // Characters saved before the server had a library.
    await a.page.evaluate(async () => {
      const store = await import(new URL('js/store.js', location.href).href);
      const now = Date.now();
      for (const [id, name] of [['c-old-timer', 'Old Timer'], ['c-taken', 'Taken Twin']]) {
        await store.putCharacter({ id, name, createdAt: now, updatedAt: now, sheetVersion: '', attrs: { character_name: name }, sections: {} });
      }
    });
    await a.page.reload({ waitUntil: 'networkidle0' });
    await a.page.waitForSelector('#upload-banner:not([hidden])');
    assert.equal(await value(a.page, '#upload-banner-text'), '2 characters are only in this browser.');
    assert.match(await value(a.page, 'a[href="#/c/c-old-timer"] .app-card-meta'), /Only in this browser/);

    await a.page.click('#upload-local');
    await a.page.waitForSelector('#upload-banner[hidden]');
    const names = Object.fromEntries((await api('characters')).characters.map((c) => [c.name, c.id]));
    assert.equal(names['Old Timer'], 'c-old-timer');
    assert.equal(names['Already There'], 'c-taken');
    assert.ok(names['Taken Twin'] && names['Taken Twin'] !== 'c-taken', 'uploaded with a new id');
    await finish({ allow: CONFLICT_LOG });
  });

  test('deletes a character for everyone, and other browsers drop their copies', { timeout: TIMEOUT }, async () => {
    const a = await player();
    await createSampleCharacter(a.page);
    const id = idOf(a.page);
    await goHome(a.page);
    const b = await player();
    await open(b.page, id);
    await goHome(b.page);

    await open(a.page, id);
    await a.page.click('#delete-character');
    await a.page.waitForFunction(() => document.body.dataset.view === 'home');
    const listed = await api('characters');
    assert.ok(!listed.characters.some((c) => c.id === id));
    assert.ok(listed.deleted.includes(id));

    await b.page.reload({ waitUntil: 'networkidle0' });
    await b.page.waitForFunction(() => document.body.dataset.view === 'home');
    await b.page.waitForFunction((cid) => !document.querySelector(`#character-list a[href="#/c/${cid}"]`), {}, id);
    const copy = await b.page.evaluate(async (cid) => (await import(new URL('js/store.js', location.href).href)).getCharacter(cid), id);
    assert.equal(copy, undefined, "B's copy is gone");
    await finish();
  });
});
