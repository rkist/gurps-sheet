// Shared setup for the browser tests: a server on a free port, a headless
// Chrome, and small helpers for driving the sheet.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const chromePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// TEST_URL runs the tests against a server that is already running, such as the Docker image.
export async function startServer() {
  if (process.env.TEST_URL) return { url: process.env.TEST_URL.replace(/\/?$/, '/'), stop() {} };
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`server exited with code ${code}`)));
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('running at')) resolve();
    });
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => child.kill() };
}

export function launchBrowser() {
  return puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox'] });
}

// A fresh browser profile (empty IndexedDB) with the app's home page loaded.
// `errors` collects console errors/warnings and uncaught exceptions,
// including ones from the sheet worker.
export async function openApp(browser, url) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 1280, height: 1000 });

  const errors = [];
  page.on('console', (msg) => {
    if (['error', 'warn', 'warning'].includes(msg.type())) errors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.dataset.view === 'home');
  return { context, page, errors };
}

// Waits until the sheet worker has stopped changing things and the result is saved.
export async function settle(page, quietMs = 500) {
  for (let i = 0; i < 40; i++) {
    await page.waitForFunction(() => document.getElementById('save-status').textContent === 'Saved', { timeout: 30000 });
    await sleep(quietMs);
    const stillSaved = await page.$eval('#save-status', (el) => el.textContent === 'Saved');
    if (stillSaved) return;
  }
  throw new Error('The sheet never settled');
}

export async function newCharacter(page) {
  await page.click('#new-character');
  await page.waitForFunction(() => document.body.dataset.view === 'sheet');
  await settle(page);
}

export async function showTab(page, value) {
  await page.evaluate((v) => document.querySelector(`#sheet-host input[name="attr_tab"][value="${v}"]`).click(), value);
  await sleep(200);
}

// The same attribute can appear in several places; use the visible copy.
async function visibleElement(page, selector) {
  const handle = await page.evaluateHandle(
    (sel) => [...document.querySelectorAll(sel)].find((el) => el.offsetParent && el.type !== 'hidden'),
    selector,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`No visible element matches ${selector}`);
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  return el;
}

export async function typeInto(page, selector, value) {
  const el = await visibleElement(page, selector);
  await el.evaluate((e) => {
    e.value = '';
  });
  await el.type(String(value));
  await page.keyboard.press('Tab');
}

export async function choose(page, selector, value) {
  await page.select(selector, value);
}

export function value(page, selector) {
  return page.evaluate((sel) => {
    const all = [...document.querySelectorAll(sel)];
    const el = all.find((e) => e.offsetParent) || all[0];
    if (!el) return undefined;
    return 'value' in el ? el.value : el.textContent;
  }, selector);
}

// Some sections are shown in more than one place (melee, ranged, items);
// every copy has the same rows, so read the first one.
export function rowIds(page, section) {
  return page.$eval(`#sheet-host .repcontainer[data-groupname="repeating_${section}"]`, (container) =>
    [...container.children].map((r) => r.dataset.reprowid),
  );
}

export function rowNames(page, section) {
  return page.$eval(`#sheet-host .repcontainer[data-groupname="repeating_${section}"]`, (container) =>
    [...container.children].map((r) => r.querySelector('[name="attr_name"]')?.value),
  );
}

export function addRow(page, section) {
  return page.click(`#sheet-host .repcontrol[data-groupname="repeating_${section}"] .repcontrol_add`);
}

export function toggleEditMode(page, section) {
  return page.click(`#sheet-host .repcontrol[data-groupname="repeating_${section}"] .repcontrol_edit`);
}

// A character with a name, ST 12 and the skills given as [name, points].
export async function createSampleCharacter(page, skills = [['Broadsword', 4], ['Stealth', 1]]) {
  await newCharacter(page);
  await page.$eval('#character-name', (el) => {
    el.value = '';
  });
  await page.type('#character-name', 'Sir Testalot');
  await typeInto(page, '#sheet-host input[name="attr_strength_points"]', 20);
  await showTab(page, '3');
  for (const [name, points] of skills) {
    await addRow(page, 'skills');
    const ids = await rowIds(page, 'skills');
    const row = `#sheet-host .repitem[data-reprowid="${ids.at(-1)}"]`;
    await typeInto(page, `${row} input[name="attr_name"]`, name);
    await choose(page, `${row} select[name="attr_base"]`, '@{dexterity}');
    await choose(page, `${row} select[name="attr_difficulty"]`, '-2');
    await typeInto(page, `${row} input[name="attr_points"]`, points);
  }
  await settle(page);
}
