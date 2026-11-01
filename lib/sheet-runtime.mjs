// The Roll20 sheet running in Node, for the MCP tools that edit characters or
// give roll commands: a worker thread (lib/sheet-thread.mjs) runs the sheet's
// worker code as the browser does, and this side keeps the attributes up to
// date the way SheetView does. Edits go in as a player's would, so the sheet
// computes everything that depends on them.
import { Worker } from 'node:worker_threads';
import { generateRowId } from '../public/js/names.js';

const THREAD = new URL('./sheet-thread.mjs', import.meta.url);
const QUIET_MS = 150;
const MAX_WAIT_MS = 60_000;
const TASK_MS = 120_000;
const MAX_HEAP_MB = 96;
// The server is open, so the runs are limited: a few waiting at most, and a
// number per minute. Others are refused right away.
const MAX_PENDING = 4;
const RUNS_PER_MINUTE = 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One sheet at a time: each needs its own worker thread and a few dozen MB.
let queue = Promise.resolve();
let pending = 0;
const recentRuns = [];

export class SheetBusyError extends Error {}

// Opens `character` ({ id, attrs, sections }) in the sheet, runs `task` with
// the runtime, and closes it. A task that runs too long is stopped.
export function withSheet(character, sheet, task) {
  const now = Date.now();
  while (recentRuns.length && recentRuns[0] <= now - 60_000) recentRuns.shift();
  if (pending >= MAX_PENDING || recentRuns.length >= RUNS_PER_MINUTE) {
    return Promise.reject(new SheetBusyError('The sheet is busy with other requests. Try again in a minute.'));
  }
  pending++;
  recentRuns.push(now);
  const run = queue.then(async () => {
    const runtime = new SheetRuntime(character, sheet);
    const timer = setTimeout(() => runtime.fail(new Error('The sheet took too long.')), TASK_MS);
    try {
      await runtime.open();
      return await Promise.race([task(runtime), runtime.failed]);
    } finally {
      clearTimeout(timer);
      runtime.close();
    }
  });
  queue = run.catch(() => {});
  run.then(
    () => pending--,
    () => pending--,
  );
  return run;
}

export class SheetRuntime {
  constructor(character, sheet) {
    this.character = character;
    this.sheet = sheet;
    this.attrs = { ...character.attrs };
    this.sections = structuredClone(character.sections || {});
    this.rolls = [];       // { text, section, rowId } from startRoll()
    this.errors = [];      // console.warn/error output of the sheet code
    this.lastActivity = Date.now();
    this.failure = null;
    this.failed = new Promise((resolve, reject) => {
      this.fail = (err) => {
        if (this.failure) return;
        this.failure = err;
        reject(err);
      };
    });
    this.failed.catch(() => {});
  }

  open() {
    this.worker = new Worker(THREAD, {
      workerData: { sheetCode: this.sheet.workerCode },
      resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB },
    });
    this.worker.on('message', (json) => this.receive(json));
    this.worker.on('error', (err) => this.fail(err));
    this.worker.on('exit', (code) => this.closed || this.fail(new Error(`The sheet stopped (exit code ${code}).`)));
    const ready = new Promise((resolve) => (this.onReady = resolve));
    this.post({
      type: 'init',
      sheetUrl: 'gurps-sheet-worker.js',
      characterId: this.character.id,
      attrs: this.attrs,
      sections: this.sections,
      defaults: this.sheet.defaults,
      sectionDefaults: this.sheet.sectionDefaults,
      translations: this.sheet.translations,
      language: 'en',
    });
    return Promise.race([ready, this.failed]).then(() => this.settle());
  }

  close() {
    this.closed = true;
    this.worker?.terminate();
  }

  post(message) {
    this.lastActivity = Date.now();
    this.worker.postMessage(JSON.stringify(message));
  }

  receive(json) {
    if (json === 'pong') return this.onPong?.();
    const msg = JSON.parse(json);
    if (msg.type === 'log') {
      this.errors.push(`${msg.level}: ${msg.text}`);
      return;
    }
    this.lastActivity = Date.now();
    if (msg.type === 'ready') this.onReady();
    else if (msg.type === 'update') this.applyUpdate(msg);
    else if (msg.type === 'roll') this.rolls.push({ text: msg.text, section: msg.section, rowId: msg.rowId });
    else if (msg.type === 'fatal') this.fail(new Error(`The sheet failed to start: ${msg.message}`));
  }

  // As SheetView.applyUpdate().
  applyUpdate({ values, sections }) {
    for (const [section, ids] of Object.entries(sections)) {
      for (const id of this.sections[section] || []) if (!ids.includes(id)) this.forgetRow(section, id);
      this.sections[section] = ids.slice();
    }
    Object.assign(this.attrs, values);
  }

  forgetRow(section, rowId) {
    const prefix = `${section}_${rowId}_`;
    for (const key of Object.keys(this.attrs)) if (key.startsWith(prefix)) delete this.attrs[key];
  }

  // Waits until the sheet has stopped changing things: no message for a while,
  // and the thread answers a ping (so it isn't busy) with nothing new after it.
  async settle({ quietMs = QUIET_MS, maxMs = MAX_WAIT_MS } = {}) {
    const start = Date.now();
    for (;;) {
      if (this.failure) throw this.failure;
      if (Date.now() - start > maxMs) throw new Error('The sheet kept changing things for too long.');
      const quiet = Date.now() - this.lastActivity;
      if (quiet < quietMs) {
        await sleep(quietMs - quiet);
        continue;
      }
      const before = this.lastActivity;
      const pong = new Promise((resolve) => (this.onPong = resolve));
      this.worker.postMessage('ping');
      await Promise.race([pong, this.failed]);
      if (this.lastActivity === before) return;
    }
  }

  // A player's edit of one field, as SheetView.handleChange().
  async change(name, value) {
    const key = name.toLowerCase();
    this.attrs[key] = value;
    this.post({ type: 'change', name: key, value });
    await this.settle();
  }

  async addRow(section) {
    const rowId = generateRowId();
    (this.sections[section] ||= []).push(rowId);
    this.post({ type: 'addRow', section, rowId });
    return rowId;
  }

  async removeRow(section, rowId) {
    this.sections[section] = (this.sections[section] || []).filter((id) => id !== rowId);
    this.forgetRow(section, rowId);
    this.post({ type: 'removeRow', section, rowId });
    await this.settle();
  }

  // Clicks an action button; resolves to the rolls it started.
  async click(button, row = null) {
    const first = this.rolls.length;
    this.post({ type: 'click', name: button.name.slice(4).toLowerCase(), htmlAttributes: button.attrs, ...(row || {}) });
    await this.settle();
    return this.rolls.slice(first);
  }

  snapshot() {
    return { attrs: { ...this.attrs }, sections: structuredClone(this.sections) };
  }
}
