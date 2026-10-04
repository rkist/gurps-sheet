// App shell: character list, open/save, import/export, language.
import { loadSheet, LANGUAGES, LANGUAGE_TAGS } from './sheet-loader.js';
import { SheetView } from './sheet-view.js';
import { isRowId, parseRepeating, UNSAFE_KEYS } from './names.js';
import * as store from './store.js';

const FORMAT = 'gurps-sheet-server/characters';
const LANGUAGE_KEY = 'gurps-sheets.language';
const $ = (id) => document.getElementById(id);

const state = {
  sheet: null,
  view: null,
  character: null,
  dirty: false,
  saveTimer: 0,
  saving: Promise.resolve(),
  queue: Promise.resolve(),
  focusName: false,
  lastRollToast: 0,
};

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

function setView(name) {
  document.body.dataset.view = name;
  $('home-view').hidden = name !== 'home';
  $('sheet-view').hidden = name !== 'sheet';
}

function displayName(attrs) {
  return String(attrs.character_name ?? '').trim() || 'Unnamed character';
}

function slug(text) {
  return (
    String(text)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'character'
  );
}

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

// ---- routing ----------------------------------------------------------------------

async function route() {
  const match = /^#\/c\/([\w-]+)$/.exec(location.hash);
  if (match) await openCharacter(match[1]);
  else await showHome();
}

async function showHome() {
  await closeCharacter();
  setView('home');

  const characters = await store.listCharacters();
  const list = $('character-list');
  list.replaceChildren();
  $('empty-state').hidden = characters.length > 0;
  $('export-all').disabled = characters.length === 0;

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  for (const c of characters) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'app-card';
    link.href = `#/c/${c.id}`;

    const name = document.createElement('span');
    name.className = 'app-card-name';
    name.textContent = c.name;

    const meta = document.createElement('span');
    meta.className = 'app-card-meta';
    const points = c.attrs?.total_points ?? state.sheet.defaults.total_points;
    meta.textContent = [points ? `${points} points` : null, `Edited ${dateFormat.format(c.updatedAt)}`]
      .filter(Boolean)
      .join(' · ');

    link.append(name, meta);
    li.append(link);
    list.append(li);
  }
}

async function openCharacter(id) {
  if (state.character?.id === id) return;
  await closeCharacter();

  const character = await store.getCharacter(id);
  if (!character) {
    toast("That character isn't saved in this browser.", true);
    history.replaceState(null, '', '#/');
    await showHome();
    return;
  }

  state.character = character;
  setView('sheet');
  setStatus('');
  $('character-name').value = character.attrs.character_name ?? character.name;
  document.title = `${character.name} · GURPS Sheets`;

  state.view = new SheetView({
    host: $('sheet-host'),
    sheet: state.sheet,
    character,
    onChange: scheduleSave,
    onRoll: () => {
      if (Date.now() - state.lastRollToast < 5000) return;
      state.lastRollToast = Date.now();
      toast("Dice rolling isn't available yet. This version is a character builder.");
    },
    onError: (message) => toast(`Sheet error: ${message}`, true),
  });
  state.view.mount();
  window.scrollTo(0, 0);

  if (state.focusName) {
    state.focusName = false;
    $('character-name').focus();
    $('character-name').select();
  }
}

async function closeCharacter() {
  if (!state.view) return;
  await saveNow();
  state.view.destroy();
  state.view = null;
  state.character = null;
  document.title = 'GURPS Sheets';
}

// ---- saving -----------------------------------------------------------------------

function scheduleSave() {
  state.dirty = true;
  setStatus('Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, 700);
}

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

// ---- actions ----------------------------------------------------------------------

async function createCharacter() {
  const now = Date.now();
  const character = {
    id: store.newCharacterId(),
    name: 'New character',
    createdAt: now,
    updatedAt: now,
    sheetVersion: state.sheet.version,
    attrs: { ...state.sheet.newCharacterAttrs, character_name: 'New character' },
    sections: {},
  };
  await store.putCharacter(character);
  navigator.storage?.persist?.().catch(() => {});
  state.focusName = true;
  location.hash = `#/c/${character.id}`;
}

function exportPayload(characters) {
  return {
    format: FORMAT,
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    characters: characters.map((c) => ({
      name: c.name,
      sheetVersion: c.sheetVersion,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      attrs: c.attrs,
      sections: c.sections,
    })),
  };
}

async function exportCurrent() {
  if (!state.character) return;
  await saveNow();
  download(`${slug(state.character.name)}.gurps.json`, exportPayload([state.character]));
}

async function exportAll() {
  const characters = await store.listCharacters();
  if (!characters.length) return;
  const day = new Date().toISOString().slice(0, 10);
  download(`gurps-characters-${day}.json`, exportPayload(characters));
}

function sanitizeCharacter(raw) {
  if (!raw || typeof raw.attrs !== 'object' || raw.attrs === null) return null;

  const attrs = {};
  for (const [k, v] of Object.entries(raw.attrs)) {
    const key = String(k).toLowerCase();
    if (UNSAFE_KEYS.has(key)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[key] = v;
  }

  const sections = {};
  for (const [k, ids] of Object.entries(raw.sections || {})) {
    const key = String(k).toLowerCase();
    if (!/^repeating_[^_]+$/.test(key) || !Array.isArray(ids)) continue;
    sections[key] = [...new Set(ids.map((id) => String(id).toLowerCase()).filter(isRowId))];
  }
  // Rows that have values but were missing from the order list.
  for (const key of Object.keys(attrs)) {
    const p = parseRepeating(key);
    if (!p?.rowId || !isRowId(p.rowId)) continue;
    const rows = (sections[p.section] ||= []);
    if (!rows.includes(p.rowId)) rows.push(p.rowId);
  }

  const now = Date.now();
  return {
    id: store.newCharacterId(),
    name: displayName(attrs),
    attrs,
    sections,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: now,
    sheetVersion: String(raw.sheetVersion || ''),
  };
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

async function deleteCurrent() {
  const character = state.character;
  if (!character) return;
  if (!confirm(`Delete "${character.name}"? This can't be undone. Export it first if you want a backup.`)) return;

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
  $('empty-state').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'new') enqueue(createCharacter);
    if (action === 'import') pickFile();
  });

  $('character-name').addEventListener('input', (e) => {
    if (!state.view) return;
    state.view.setAttr('character_name', e.target.value);
    document.title = `${displayName({ character_name: e.target.value })} · GURPS Sheets`;
  });

  window.addEventListener('hashchange', () => enqueue(route));
  window.addEventListener('pagehide', () => saveNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

wireUp();
enqueue(async () => {
  await loadSheetFor(readLanguage());
  await route();
});
