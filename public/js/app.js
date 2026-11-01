// App shell: character list, open/save, import/export, language, and syncing
// with the server's shared character library when it has one.
import { Books } from './books.js';
import { loadSheet, LANGUAGES, LANGUAGE_TAGS } from './sheet-loader.js';
import { SheetView } from './sheet-view.js';
import { contentKey, displayName, FORMAT, newCharacterId, sanitizeCharacter, slug } from './characters.js';
import * as library from './library.js';
import { answerQueries, buildRoll, expandAttributes, findQueries } from './roll20.js';
import { askQueries, RollPanel } from './roll-ui.js';
import * as store from './store.js';

const LANGUAGE_KEY = 'gurps-sheets.language';
// Changes go to the library once editing pauses for UPLOAD_IDLE_MS, at least
// every UPLOAD_MAX_WAIT_MS while it goes on, and when the sheet is left.
const UPLOAD_IDLE_MS = 20_000;
const UPLOAD_MAX_WAIT_MS = 60_000;
const RETRY_MS = 60_000;
const $ = (id) => document.getElementById(id);

// With a library, the browser's copy of a character also has:
//   shared       true: it is in the group library, or will be once uploaded
//   baseVersion  the library version the copy is based on; null until uploaded
//   pending      true: the copy has changes the library doesn't have yet
const state = {
  sheet: null,
  view: null,
  character: null,
  dirty: false,
  saveTimer: 0,
  saving: Promise.resolve(),
  queue: Promise.resolve(),
  rolls: Promise.resolve(),
  focusName: false,
  library: false,       // the server has a shared library
  baseline: null,       // contentKey() of the open character's library version
  touched: false,       // the player changed the open character
  sync: '',             // SYNC_TEXT key shown for the open character
  uploadTimer: 0,
  retryTimer: 0,
  pendingSince: 0,
  uploading: Promise.resolve(),
  uploadInFlight: false,
};

const SYNC_TEXT = {
  local: 'Only in this browser',
  pending: 'Not uploaded yet',
  uploading: 'Uploading…',
  synced: 'In the group library',
  offline: "Can't reach the library",
  conflict: 'Changed elsewhere',
  'too-big': 'Too big for the library',
};

const rollPanel = new RollPanel($('roll-panel'));
const books = new Books({ host: $('sheet-host'), dialog: $('books-dialog'), links: $('ref-links'), notify: toast });

// Navigation, language switches etc. run one at a time.
function enqueue(task) {
  state.queue = state.queue.then(task).catch((err) => {
    console.error(err);
    toast(err.message || String(err), true);
  });
  return state.queue;
}

// ---- helpers ------------------------------------------------------------------

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('app-toast-error', isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3500);
}

function setStatus(text) {
  $('save-status').textContent = text;
}

function setSync(key) {
  state.sync = key;
  $('sync-status').textContent = SYNC_TEXT[key] || '';
  $('sync-status').hidden = !key;
}

function setView(name) {
  document.body.dataset.view = name;
  $('home-view').hidden = name !== 'home';
  $('sheet-view').hidden = name !== 'sheet';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function download(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && LANGUAGES.includes(saved)) return saved;
  } catch {
    // storage unavailable; fall through to the browser language
  }
  for (const tag of navigator.languages || [navigator.language]) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGES.includes(base)) return base;
  }
  return 'en';
}

function languageLabel(code) {
  const tag = LANGUAGE_TAGS[code] || code;
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
  } catch {
    return code;
  }
}

// Asks which of two versions to keep; resolves to 'mine' or 'theirs'. Closing
// the dialog without choosing keeps mine, since theirs stays in the history.
function askChoice({ title, text, mine, theirs }) {
  const dialog = $('choice-dialog');
  dialog.querySelector('.app-dialog-title').textContent = title;
  dialog.querySelector('.app-dialog-text').textContent = text;
  dialog.querySelector('[value="mine"]').textContent = mine;
  dialog.querySelector('[value="theirs"]').textContent = theirs;
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'theirs' ? 'theirs' : 'mine'), { once: true });
    dialog.showModal();
  });
}

const changedElsewhere = (name) => ({
  title: `"${name}" was changed elsewhere`,
  text:
    'Another player, or Claude, saved this character after your copy was loaded. Keep yours as the newest ' +
    "version (theirs stays in the library's history), or load theirs and drop your changes that weren't uploaded.",
  mine: 'Keep mine',
  theirs: 'Load theirs',
});

const deletedElsewhere = (name) => ({
  title: `"${name}" was deleted`,
  text:
    "Someone deleted this character from the group library, but your copy has changes that weren't uploaded. " +
    'Restore it with your changes, or delete your copy too.',
  mine: 'Restore it',
  theirs: 'Delete my copy',
});

// ---- sheet ------------------------------------------------------------------------

async function loadSheetFor(language) {
  $('loading').hidden = false;
  try {
    const sheet = await loadSheet(language);
    if (state.sheet) URL.revokeObjectURL(state.sheet.workerUrl);
    state.sheet = sheet;
    $('sheet-css').textContent = sheet.css;
    $('language').value = sheet.language;
    $('sheet-credit').textContent = `GURPS character sheet ${sheet.version} by ${sheet.authors}, from the Roll20 character sheet repository (MIT license).`;
  } finally {
    $('loading').hidden = true;
  }
}

async function checkLibrary() {
  try {
    state.library = (await library.status()).enabled;
  } catch (err) {
    // The server served this page a moment ago, so unless it says there's no
    // such thing, assume a passing problem and treat the library as unreachable.
    state.library = err.status !== 404;
  }
}

// ---- routing ----------------------------------------------------------------------

async function route() {
  const match = /^#\/c\/([\w-]+)$/.exec(location.hash);
  if (match) await openCharacter(match[1]);
  else await showHome();
}

async function showHome() {
  await closeCharacter();
  clearTimeout(state.retryTimer);

  let copies = await store.listCharacters();
  let cards = copies.map(cardFor);
  let problem = '';
  if (state.library) {
    try {
      cards = await reconcile(copies, await library.list());
      copies = await store.listCharacters();
    } catch (err) {
      problem = `${err.message} Showing the copies saved in this browser.`;
      retryHome();
    }
  }

  setView('home');
  $('browser-note').hidden = state.library;
  $('library-note').hidden = !state.library;
  $('library-problem').textContent = problem;
  $('library-problem').hidden = !problem;
  const localOnly = state.library && !problem ? copies.filter((c) => !c.shared).length : 0;
  $('upload-banner').hidden = localOnly === 0;
  $('upload-banner-text').textContent = `${plural(localOnly, 'character')} ${localOnly === 1 ? 'is' : 'are'} only in this browser.`;

  const list = $('character-list');
  list.replaceChildren();
  $('empty-state').hidden = cards.length > 0;
  $('export-all').disabled = cards.length === 0;

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  for (const c of cards) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'app-card';
    link.href = `#/c/${c.id}`;

    const name = document.createElement('span');
    name.className = 'app-card-name';
    name.textContent = c.name;

    const meta = document.createElement('span');
    meta.className = 'app-card-meta';
    meta.textContent = [c.points ? `${c.points} points` : null, `Edited ${dateFormat.format(c.updatedAt)}`, c.note]
      .filter(Boolean)
      .join(' · ');

    link.append(name, meta);
    li.append(link);
    list.append(li);
  }

  if (state.library && !problem) uploadPending(copies);
}

function cardFor(copy) {
  let note = '';
  if (state.library) note = !copy.shared ? 'Only in this browser' : copy.pending ? 'Not uploaded yet' : '';
  return { id: copy.id, name: copy.name, updatedAt: copy.updatedAt, points: copy.attrs?.total_points ?? state.sheet.defaults.total_points, note };
}

// Lines this browser's copies up with the library's list: copies of characters
// deleted there are dropped (unless they have changes of their own), and copies
// the library doesn't know become characters only in this browser.
async function reconcile(copies, { characters, deleted }) {
  const copyOf = new Map(copies.map((c) => [c.id, c]));
  const listed = new Set(characters.map((c) => c.id));
  const gone = new Set(deleted);
  const cards = characters.map((c) => {
    const copy = copyOf.get(c.id);
    if (copy?.pending) return cardFor(copy);
    const points = copy?.baseVersion === c.version ? cardFor(copy).points : null;
    return { id: c.id, name: c.name, updatedAt: c.savedAt, points, note: '' };
  });
  for (const copy of copies) {
    if (listed.has(copy.id)) continue;
    if (copy.shared && copy.baseVersion && gone.has(copy.id) && !copy.pending) {
      await store.deleteCharacter(copy.id);
      continue;
    }
    if (copy.shared && copy.baseVersion && !gone.has(copy.id)) {
      // E.g. the server got a new library.
      Object.assign(copy, { shared: false, baseVersion: null, pending: false });
      await store.putCharacter(copy);
    }
    cards.push(cardFor(copy));
  }
  return cards.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function openCharacter(id) {
  if (state.character?.id === id) return;
  await closeCharacter();
  await state.uploading;

  const opened = await loadCharacter(id);
  if (!opened) {
    history.replaceState(null, '', '#/');
    await showHome();
    return;
  }
  mountCharacter(opened.character, opened.sync);
  window.scrollTo(0, 0);

  if (state.focusName) {
    state.focusName = false;
    $('character-name').focus();
    $('character-name').select();
  }
}

// This browser's copy of a character, brought up to date with the library, and
// the library status to show. Null, after saying why, if there's nothing to open.
async function loadCharacter(id) {
  const copy = await store.getCharacter(id);
  state.baseline = copy && !copy.pending ? contentKey(copy) : null;
  if (!state.library || (copy && !(copy.shared && copy.baseVersion))) {
    if (copy) return { character: copy, sync: !state.library ? '' : copy.shared ? 'pending' : 'local' };
    toast("That character isn't saved in this browser.", true);
    return null;
  }

  let remote;
  try {
    remote = await library.get(id);
  } catch (err) {
    if (err.status === 404) return missingFromLibrary(copy, err.body);
    if (copy) return { character: copy, sync: 'offline' };
    toast(`Can't open that character: ${err.message}`, true);
    return null;
  }

  const theirs = fromLibrary(remote);
  state.baseline = contentKey(theirs);
  if (copy?.pending && contentKey(copy) !== state.baseline) {
    // Changes of its own, made to the current version or, if someone else
    // saved in between, to an older one.
    const keepMine = copy.baseVersion === remote.version || (await askChoice(changedElsewhere(copy.name))) === 'mine';
    if (keepMine) {
      copy.baseVersion = remote.version;
      await store.putCharacter(copy);
      return { character: copy, sync: 'pending' };
    }
  }
  await store.putCharacter(theirs);
  return { character: theirs, sync: 'synced' };
}

const fromLibrary = ({ version, character }) => ({ ...character, shared: true, baseVersion: version, pending: false });

// The library has no current version of a character this browser has a copy
// of: it was deleted there, or the library never had it.
async function missingFromLibrary(copy, { deleted, version }) {
  if (!copy) {
    toast(deleted ? 'That character was deleted from the group library.' : "That character isn't in the group library.", true);
    return null;
  }
  if (deleted) {
    if (copy.pending && (await askChoice(deletedElsewhere(copy.name))) === 'mine') {
      copy.baseVersion = version; // saving on top of the deletion restores it
      await store.putCharacter(copy);
      return { character: copy, sync: 'pending' };
    }
    await store.deleteCharacter(copy.id);
    toast(`"${copy.name}" was deleted from the group library.`);
    return null;
  }
  Object.assign(copy, { shared: false, baseVersion: null, pending: false });
  await store.putCharacter(copy);
  return { character: copy, sync: 'local' };
}

function mountCharacter(character, sync) {
  state.character = character;
  state.touched = false;
  setView('sheet');
  setStatus('');
  setSync(sync);
  $('character-name').value = character.attrs.character_name ?? character.name;
  document.title = `${character.name} · GURPS Sheets`;

  state.view = new SheetView({
    host: $('sheet-host'),
    sheet: state.sheet,
    character,
    onChange: scheduleSave,
    onEdit: () => (state.touched = true),
    onRoll: (request) => {
      state.rolls = state.rolls.then(() => roll(request)).catch((err) => {
        console.error(err);
        toast(err.message || String(err), true);
      });
    },
    onError: (message) => toast(`Sheet error: ${message}`, true),
  });
  state.view.mount();
  rollPanel.clear();
  if (state.library && character.shared && character.pending) scheduleUpload();
}

async function closeCharacter() {
  if (!state.view) return;
  $('roll-dialog').close();
  await saveNow();
  await uploadNow({ prompt: false });
  clearTimeout(state.uploadTimer);
  state.view.destroy();
  state.view = null;
  state.character = null;
  state.pendingSince = 0;
  document.title = 'GURPS Sheets';
}

// ---- saving -----------------------------------------------------------------------

function scheduleSave() {
  state.dirty = true;
  setStatus('Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 700);
}

// Saves the open sheet to this browser right away (the IndexedDB write follows).
function saveNow() {
  clearTimeout(state.saveTimer);
  const { view, character } = state;
  if (!view || !character || !state.dirty) return state.saving;
  state.dirty = false;

  const { attrs, sections } = view.snapshot();
  Object.assign(character, {
    attrs,
    sections,
    name: displayName(attrs),
    updatedAt: Date.now(),
    sheetVersion: state.sheet.version,
  });
  if (state.library && character.shared) {
    // The sheet sets values of its own when it opens (e.g. 0 becomes "0.000"),
    // so changes count once the player has changed something, and only if the
    // result differs from the library's version.
    if (state.touched) character.pending = contentKey(character) !== state.baseline;
    if (character.pending) scheduleUpload();
    if (['pending', 'synced'].includes(state.sync)) setSync(character.pending ? 'pending' : 'synced');
  }
  const record = structuredClone(character);
  state.saving = state.saving
    .then(() => store.putCharacter(record))
    .then(
      () => {
        if (state.character === character && !state.dirty) setStatus('Saved');
      },
      (err) => {
        console.error(err);
        setStatus('Not saved');
        toast(`Could not save: ${err.message}`, true);
      },
    );
  return state.saving;
}

// Saves the open character's library state to this browser.
function persist(character) {
  const record = structuredClone(character);
  state.saving = state.saving.then(() => store.putCharacter(record)).catch((err) => console.error(err));
  return state.saving;
}

// ---- library uploads ----------------------------------------------------------------

function scheduleUpload() {
  if (state.sync === 'too-big' || state.sync === 'conflict') return;
  const now = Date.now();
  state.pendingSince ||= now;
  clearTimeout(state.uploadTimer);
  const wait = Math.min(UPLOAD_IDLE_MS, Math.max(0, state.pendingSince + UPLOAD_MAX_WAIT_MS - now));
  state.uploadTimer = setTimeout(() => uploadNow(), wait);
}

function uploadNow(options) {
  state.uploading = state.uploading.then(() => uploadOpen(options)).catch((err) => console.error(err));
  return state.uploading;
}

// Sends a copy to the library as its newest version. A conflict with a version
// of the same content (e.g. an upload whose answer was lost when the page
// closed) counts as saved.
async function upload(copy, { keepalive = false } = {}) {
  const character = exportRecord(copy);
  const key = contentKey(character);
  try {
    const saved = await library.save(copy.id, character, copy.baseVersion ?? null, { keepalive });
    return { outcome: 'saved', version: saved.version, key };
  } catch (err) {
    const latest = err.body?.latest;
    if (err.status !== 409 || !latest) return { outcome: 'failed', error: err };
    if (!latest.deleted && contentKey(latest.character) === key) return { outcome: 'saved', version: latest.version, key };
    return { outcome: 'conflict', latest };
  }
}

// Uploads the open character's changes. `prompt: false` (when leaving it)
// leaves a conflict to be settled when it is opened next.
async function uploadOpen({ keepalive = false, prompt = true } = {}) {
  clearTimeout(state.uploadTimer);
  const character = state.character;
  if (!state.library || !character?.shared || state.sync === 'too-big') return;
  saveNow();
  if (!character.pending) return;

  state.uploadInFlight = true;
  setSync('uploading');
  const result = await upload(character, { keepalive });
  state.uploadInFlight = false;
  if (state.character !== character) return;

  if (result.outcome === 'saved') {
    state.pendingSince = 0;
    state.baseline = result.key;
    character.baseVersion = result.version;
    character.pending = state.touched && !!state.view && contentKey(state.view.snapshot()) !== result.key;
    setSync(character.pending ? 'pending' : 'synced');
    if (character.pending) scheduleUpload();
    persist(character);
  } else if (result.outcome === 'conflict') {
    setSync('conflict');
    if (!prompt) {
      toast(`"${character.name}" was changed elsewhere. Open it again to choose which version to keep.`, true);
      return;
    }
    const { latest } = result;
    const choice = await askChoice(latest.deleted ? deletedElsewhere(character.name) : changedElsewhere(character.name));
    if (state.character !== character) return;
    if (choice === 'mine') {
      character.baseVersion = latest.version;
      persist(character);
      setSync('pending');
      await uploadOpen({ keepalive, prompt });
    } else if (latest.deleted) {
      await discardOpen(`"${character.name}" was deleted from the group library.`);
    } else {
      await replaceOpen(latest);
    }
  } else if (result.error.status === 413) {
    setSync('too-big');
    toast(`"${character.name}" is too big for the group library. It stays saved in this browser.`, true);
  } else {
    setSync('offline');
    state.uploadTimer = setTimeout(() => uploadNow(), RETRY_MS);
  }
}

// While the list is shown, loads it again in a while, e.g. once the library
// can be reached again.
function retryHome() {
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(() => {
    if (document.body.dataset.view === 'home' && !state.view) enqueue(showHome);
  }, RETRY_MS);
}

// Uploads changes left in copies that aren't open, e.g. because the page was
// closed before they went out, and tries again later if the library couldn't
// be reached. A conflict waits until the character is opened.
function uploadPending(copies) {
  let failed = false;
  for (const copy of copies.filter((c) => c.shared && c.pending)) {
    state.uploading = state.uploading
      .then(async () => {
        const result = await upload(copy);
        if (result.outcome === 'failed' && result.error.status !== 413) failed = true;
        if (result.outcome !== 'saved') return;
        const current = await store.getCharacter(copy.id);
        if (current && state.character?.id !== copy.id && contentKey(current) === result.key) {
          await store.putCharacter({ ...current, baseVersion: result.version, pending: false });
        }
      })
      .catch((err) => console.error(err));
  }
  state.uploading = state.uploading.then(() => {
    if (failed) retryHome();
  });
}

// Replaces the open sheet with the library's version.
async function replaceOpen(latest) {
  const theirs = fromLibrary(latest);
  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.view.destroy();
  state.view = null;
  await state.saving;
  await store.putCharacter(theirs);
  state.baseline = contentKey(theirs);
  state.pendingSince = 0;
  mountCharacter(theirs, 'synced');
}

// Closes the open sheet and deletes this browser's copy.
async function discardOpen(message) {
  const character = state.character;
  clearTimeout(state.saveTimer);
  clearTimeout(state.uploadTimer);
  state.dirty = false;
  state.view.destroy();
  state.view = null;
  state.character = null;
  await state.saving;
  await store.deleteCharacter(character.id);
  toast(message);
  location.hash = '#/';
}

// ---- rolls ------------------------------------------------------------------------

// Roll buttons don't roll: they fill in the sheet's Roll20 macro, ask its
// prompts, and list the Roll20 chat command to paste. Help buttons hold a link.
async function roll({ text, row }) {
  const view = state.view;
  if (!view) return;
  const macro = expandAttributes(text, (name) => view.lookup(name, row));
  if (/^https?:\/\/\S+$/i.test(macro.trim())) {
    window.open(macro.trim(), '_blank', 'noopener');
    return;
  }

  let answers = new Map();
  const queries = findQueries(macro);
  if (queries.length) {
    const preview = buildRoll(answerQueries(macro));
    answers = await askQueries($('roll-dialog'), preview.title || preview.subtitle, queries);
    if (!answers || state.view !== view) return;
  }

  const result = buildRoll(answerQueries(macro, answers));
  if (result.commands.length) rollPanel.add(result);
  else toast('Nothing to roll on this button.');
}

// ---- actions ----------------------------------------------------------------------

// With a library, new and imported characters go to it.
const newInLibrary = () => (state.library ? { shared: true, baseVersion: null, pending: true } : {});

async function createCharacter() {
  const now = Date.now();
  const character = {
    id: newCharacterId(),
    name: 'New character',
    createdAt: now,
    updatedAt: now,
    sheetVersion: state.sheet.version,
    attrs: { ...state.sheet.newCharacterAttrs, character_name: 'New character' },
    sections: {},
    ...newInLibrary(),
  };
  await store.putCharacter(character);
  navigator.storage?.persist?.().catch(() => {});
  state.focusName = true;
  location.hash = `#/c/${character.id}`;
}

const exportRecord = (c) => ({
  name: c.name,
  sheetVersion: c.sheetVersion,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  attrs: c.attrs,
  sections: c.sections,
});

function exportPayload(characters) {
  return { format: FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), characters: characters.map(exportRecord) };
}

async function exportCurrent() {
  if (!state.character) return;
  await saveNow();
  download(`${slug(state.character.name)}.gurps.json`, exportPayload([state.character]));
}

// With a library: the current version of every character in it, plus the ones
// only in this browser.
async function exportAll() {
  let characters = await store.listCharacters();
  if (state.library) {
    try {
      const { characters: listed, deleted } = await library.list();
      const copyOf = new Map(characters.map((c) => [c.id, c]));
      const shared = await Promise.all(
        listed.map(async (c) => {
          const copy = copyOf.get(c.id);
          if (copy && (copy.pending || copy.baseVersion === c.version)) return copy;
          return (await library.get(c.id)).character;
        }),
      );
      const ids = new Set([...listed.map((c) => c.id), ...deleted]);
      characters = [...shared, ...characters.filter((c) => !ids.has(c.id))];
    } catch (err) {
      toast(`Exporting only the copies in this browser: ${err.message}`, true);
    }
  }
  if (!characters.length) return;
  const day = new Date().toISOString().slice(0, 10);
  download(`gurps-characters-${day}.json`, exportPayload(characters));
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("That file isn't valid JSON.", true);
    return;
  }
  if (!data || data.format !== FORMAT || !Array.isArray(data.characters)) {
    toast("That file isn't a GURPS Sheets export.", true);
    return;
  }

  const imported = [];
  for (const raw of data.characters) {
    const character = sanitizeCharacter(raw);
    if (!character) continue;
    Object.assign(character, newInLibrary());
    await store.putCharacter(character);
    imported.push(character);
  }

  if (imported.length === 0) {
    toast('No characters found in that file.', true);
  } else if (imported.length === 1) {
    toast(`Imported "${imported[0].name}".`);
    location.hash = `#/c/${imported[0].id}`;
  } else {
    toast(`Imported ${imported.length} characters.`);
    if (location.hash === '#/' || location.hash === '') await showHome();
    else location.hash = '#/';
  }
}

async function uploadLocal() {
  const copies = (await store.listCharacters()).filter((c) => !c.shared);
  let uploaded = 0;
  for (let copy of copies) {
    let result = await upload({ ...copy, baseVersion: null });
    if (result.outcome === 'conflict') {
      // The library has another character with this id (e.g. an older copy of
      // this one): keep both. Saved under the new id first, so it can't be lost.
      const old = copy.id;
      copy = { ...copy, id: newCharacterId(), shared: true, baseVersion: null, pending: true };
      await store.putCharacter(copy);
      await store.deleteCharacter(old);
      result = await upload(copy);
    }
    const saved = result.outcome === 'saved';
    Object.assign(copy, { shared: true, baseVersion: saved ? result.version : null, pending: !saved });
    await store.putCharacter(copy);
    if (saved) uploaded++;
  }
  if (uploaded === copies.length) toast(`Uploaded ${plural(uploaded, 'character')} to the group library.`);
  else toast(`Uploaded ${uploaded} of ${copies.length}. The rest go up when the library can be reached.`, true);
  await showHome();
}

async function deleteCurrent() {
  const character = state.character;
  if (!character) return;
  clearTimeout(state.uploadTimer);
  await state.uploading;
  const shared = state.library && character.shared && character.baseVersion;
  const question = shared
    ? `Delete "${character.name}" for everyone in the group? The library keeps its history.`
    : `Delete "${character.name}"? This can't be undone. Export it first if you want a backup.`;
  if (!confirm(question)) return;
  if (shared && !(await removeFromLibrary(character))) return;

  clearTimeout(state.saveTimer);
  state.dirty = false;
  state.view.destroy();
  state.view = null;
  state.character = null;
  await state.saving;
  await store.deleteCharacter(character.id);
  toast(`Deleted "${character.name}".`);
  location.hash = '#/';
}

// Marks a character deleted in the library. False if it wasn't.
async function removeFromLibrary(character) {
  try {
    await library.remove(character.id, character.baseVersion);
    return true;
  } catch (err) {
    if (err.status === 404) return true;
    if (err.status === 409 && err.body.latest) {
      if (!confirm(`"${character.name}" was changed elsewhere since you opened it. Delete it anyway?`)) return false;
      character.baseVersion = err.body.latest.version;
      return removeFromLibrary(character);
    }
    toast(`Could not delete "${character.name}": ${err.message}`, true);
    return false;
  }
}

async function changeLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // not persisted; still switch for this session
  }
  const openId = state.character?.id;
  await closeCharacter();
  await loadSheetFor(language);
  if (openId) await openCharacter(openId);
}

// ---- start ------------------------------------------------------------------------

function wireUp() {
  const select = $('language');
  for (const code of LANGUAGES) select.append(new Option(languageLabel(code), code));
  select.addEventListener('change', () => enqueue(() => changeLanguage(select.value)));

  const fileInput = $('import-file');
  const pickFile = () => {
    fileInput.value = '';
    fileInput.click();
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) enqueue(() => importFile(file));
  });

  $('new-character').addEventListener('click', () => enqueue(createCharacter));
  $('import-character').addEventListener('click', pickFile);
  $('export-all').addEventListener('click', () => enqueue(exportAll));
  $('export-character').addEventListener('click', () => enqueue(exportCurrent));
  $('delete-character').addEventListener('click', () => enqueue(deleteCurrent));
  $('upload-local').addEventListener('click', () => enqueue(uploadLocal));
  $('open-books').addEventListener('click', () => books.showDialog());
  $('empty-state').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'new') enqueue(createCharacter);
    if (action === 'import') pickFile();
  });

  $('roll-dialog').querySelector('[data-action="cancel"]').addEventListener('click', () => $('roll-dialog').close());
  $('choice-dialog').addEventListener('cancel', (e) => e.preventDefault());

  $('character-name').addEventListener('input', (e) => {
    if (!state.view) return;
    state.view.setAttr('character_name', e.target.value);
    document.title = `${displayName({ character_name: e.target.value })} · GURPS Sheets`;
  });

  window.addEventListener('hashchange', () => enqueue(route));
  // Requests sent while the page closes must be keepalive (and small) to get out.
  window.addEventListener('pagehide', () => {
    saveNow();
    if (!state.uploadInFlight) uploadOpen({ keepalive: true, prompt: false }).catch((err) => console.error(err));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    saveNow();
    uploadNow({ keepalive: true });
  });
}

wireUp();
books.load().catch((err) => {
  console.error(err);
  toast(`Can't load your books: ${err.message || err}`, true);
});
enqueue(async () => {
  await Promise.all([loadSheetFor(readLanguage()), checkLibrary()]);
  await route();
});
