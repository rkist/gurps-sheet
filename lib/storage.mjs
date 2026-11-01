// The shared character library. A save never overwrites anything: it adds a
// file named <slug>--<timestamp>.json, the newest file of a character is its
// current version and the older ones are its history. Deleting adds a
// "deleted" file. Files are in a Google Drive folder (production) or a local
// directory (tests, development), in the same format as an export, so any of
// them can be downloaded and imported by hand.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FORMAT, isCharacterId, sanitizeCharacter, slug } from '../public/js/characters.js';
import { DriveFolder } from './drive.mjs';

const REFRESH_MS = 5 * 60_000;

export class ConflictError extends Error {
  constructor(latest) {
    super('This character was changed elsewhere since it was loaded.');
    this.latest = latest;
  }
}

// Picks the file store from the environment: STORAGE_DIR, or DRIVE_FOLDER_ID
// with the Google OAuth client and refresh token. Neither: no library.
export function libraryFromEnv(env) {
  if (env.STORAGE_DIR) return new Library(new DirectoryFolder(env.STORAGE_DIR));
  if (!env.DRIVE_FOLDER_ID) return null;
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`DRIVE_FOLDER_ID is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not`);
  return new Library(
    new DriveFolder({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      folderId: env.DRIVE_FOLDER_ID,
    }),
  );
}

// Same interface as DriveFolder. File ids are the file names.
export class DirectoryFolder {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  describe() {
    return `directory ${this.dir}`;
  }

  file(id) {
    if (id !== path.basename(id) || !id.endsWith('.json')) throw new Error(`Invalid file name: ${id}`);
    return path.join(this.dir, id);
  }

  async listFiles() {
    await mkdir(this.dir, { recursive: true });
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.json'));
    return Promise.all(
      names.map(async (name) => {
        const time = (await stat(this.file(name))).mtime.toISOString();
        return { id: name, name, createdTime: time, modifiedTime: time, properties: null };
      }),
    );
  }

  readFile(id) {
    return readFile(this.file(id), 'utf8');
  }

  async createFile({ name, properties, content }) {
    await mkdir(this.dir, { recursive: true });
    for (let n = 1; ; n++) {
      const id = n === 1 ? name : name.replace(/\.json$/, `-${n}.json`);
      try {
        await writeFile(this.file(id), content, { flag: 'wx' });
        return { id, name: id, createdTime: new Date().toISOString(), properties };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  }
}

export class Library {
  constructor(folder) {
    this.folder = folder;
    this.ready = false;
    this.versionsOf = new Map(); // character id -> [entry], oldest first
    this.known = new Set();      // ids of the files in the index
    this.skipped = new Map();    // file id -> modifiedTime of a version that couldn't be used
    this.contents = new Map();   // file id -> parsed file, for current versions
    this.locks = new Map();      // character id -> promise of its last save
  }

  describe() {
    return this.folder.describe();
  }

  async load() {
    await this.refresh();
    this.ready = true;
    // Picks up files added to the folder by hand.
    this.timer = setInterval(() => {
      this.refresh().catch((err) => console.error('Could not refresh the character library:', err.message));
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  async refresh() {
    for (const file of await this.folder.listFiles()) {
      if (this.known.has(file.id) || (this.skipped.has(file.id) && this.skipped.get(file.id) === file.modifiedTime)) continue;
      const entry = await this.entryFor(file);
      if (this.known.has(file.id)) continue; // saved by us while this was reading
      // A file that can't be used now (e.g. still being copied) is tried again once it changes.
      if (!entry) {
        this.skipped.set(file.id, file.modifiedTime);
        continue;
      }
      this.skipped.delete(file.id);
      this.known.add(file.id);
      this.addEntry(entry);
    }
  }

  // Files we wrote carry what the index needs in their Drive properties; any
  // other file (added by hand, or in a directory folder), or one whose name was
  // too long for a property, has to be read.
  async entryFor(file) {
    const p = file.properties || {};
    if (isCharacterId(p.characterId) && Number(p.savedAt) && p.nameTruncated !== '1') {
      return { version: file.id, characterId: p.characterId, savedAt: Number(p.savedAt), name: p.name || '', deleted: p.deleted === '1' };
    }
    try {
      return describeFile(JSON.parse(await this.folder.readFile(file.id)), file);
    } catch (err) {
      console.warn(`Skipping "${file.name}" in the character library: ${err.message}`);
      return null;
    }
  }

  addEntry(entry) {
    const versions = this.versionsOf.get(entry.characterId) || [];
    const previous = versions.at(-1);
    versions.push(entry);
    versions.sort((a, b) => a.savedAt - b.savedAt || (a.version < b.version ? -1 : 1));
    this.versionsOf.set(entry.characterId, versions);
    // Only current versions stay cached.
    if (previous && versions.at(-1) !== previous) this.contents.delete(previous.version);
  }

  latest(id) {
    return this.versionsOf.get(id)?.at(-1) || null;
  }

  list() {
    const out = [];
    for (const [id, versions] of this.versionsOf) {
      const latest = versions.at(-1);
      if (!latest.deleted) out.push({ id, name: latest.name, savedAt: latest.savedAt, version: latest.version });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1));
  }

  versions(id) {
    return (this.versionsOf.get(id) || [])
      .map(({ version, savedAt, name, deleted }) => ({ version, savedAt, name, deleted }))
      .reverse();
  }

  // The current version, or null if there is none. A deleted character comes
  // back as { deleted: true } without a character.
  async get(id) {
    const latest = this.latest(id);
    return latest ? this.read(latest) : null;
  }

  async getVersion(id, version) {
    const entry = (this.versionsOf.get(id) || []).find((e) => e.version === version);
    return entry ? this.read(entry) : null;
  }

  async read(entry) {
    const { version, savedAt, deleted } = entry;
    if (deleted) return { version, savedAt, deleted: true };
    let content = this.contents.get(version);
    if (!content) {
      content = JSON.parse(await this.folder.readFile(version));
      if (this.latest(entry.characterId) === entry) this.contents.set(version, content);
    }
    const raw = content.characters[0];
    const character = sanitizeCharacter(raw, { id: entry.characterId });
    character.updatedAt = Number(raw.updatedAt) || savedAt;
    return { version, savedAt, deleted: false, character };
  }

  // Adds a version. `baseVersion` is the version the change was made to; if
  // that is no longer the current one, nothing is saved and ConflictError
  // carries the current version. Returns null if `raw` isn't a character.
  save(id, raw, baseVersion = null) {
    return this.locked(id, async () => {
      const character = sanitizeCharacter(raw, { id });
      if (!character) return null;
      const latest = this.latest(id);
      if (latest && latest.version !== baseVersion) throw new ConflictError(await this.read(latest));
      const savedAt = Math.max(Date.now(), (latest?.savedAt ?? 0) + 1);
      character.updatedAt = savedAt;
      return this.write(id, savedAt, character.name, false, { characters: [character] });
    });
  }

  // Adds a "deleted" version. Returns null for an unknown character.
  remove(id, baseVersion = null) {
    return this.locked(id, async () => {
      const latest = this.latest(id);
      if (!latest) return null;
      if (latest.deleted) return { version: latest.version, savedAt: latest.savedAt };
      if (latest.version !== baseVersion) throw new ConflictError(await this.read(latest));
      const savedAt = Math.max(Date.now(), latest.savedAt + 1);
      return this.write(id, savedAt, latest.name, true, { deleted: { id, name: latest.name }, characters: [] });
    });
  }

  async write(characterId, savedAt, name, deleted, body) {
    const content = { format: FORMAT, formatVersion: 1, savedAt: new Date(savedAt).toISOString(), ...body };
    const stamp = new Date(savedAt).toISOString().replace(/[:.]/g, '-');
    const fileName = `${slug(name).slice(0, 60).replace(/-+$/, '')}--${stamp}${deleted ? '--deleted' : ''}.json`;
    const properties = { characterId, savedAt: String(savedAt), name: truncateBytes(name, 100) };
    if (properties.name !== name) properties.nameTruncated = '1';
    if (deleted) properties.deleted = '1';
    const file = await this.folder.createFile({ name: fileName, properties, content: JSON.stringify(content, null, 1) });
    this.known.add(file.id);
    this.addEntry({ version: file.id, characterId, savedAt, name, deleted });
    if (this.latest(characterId)?.version === file.id) this.contents.set(file.id, content);
    return { version: file.id, savedAt };
  }

  // Saves to one character happen one at a time, so the conflict check and the
  // write can't interleave. (The server runs as a single replica.)
  locked(id, task) {
    const run = (this.locks.get(id) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }
}

// What the index needs from a file's contents. A file without a character id
// (an export added by hand) gets one derived from its file id, so it keeps the
// same id across restarts.
function describeFile(content, file) {
  if (!content || content.format !== FORMAT) throw new Error('not a GURPS Sheets file');
  const savedAt = Date.parse(content.savedAt) || Date.parse(file.createdTime) || 0;
  if (content.deleted) {
    if (!isCharacterId(content.deleted.id)) throw new Error('deleted file without a character id');
    return { version: file.id, characterId: content.deleted.id, savedAt, name: String(content.deleted.name || ''), deleted: true };
  }
  const characters = Array.isArray(content.characters) ? content.characters : [];
  if (characters.length !== 1) throw new Error(`holds ${characters.length} characters; the library needs one per file`);
  const character = sanitizeCharacter(characters[0], { id: 'c-x' });
  if (!character) throw new Error('not a character');
  const id = isCharacterId(characters[0].id)
    ? characters[0].id
    : 'c-' + createHash('sha256').update(file.id).digest('hex').slice(0, 16);
  return { version: file.id, characterId: id, savedAt, name: character.name, deleted: false };
}

// Drive limits a property's key and value to 124 bytes together.
function truncateBytes(text, max) {
  const encoder = new TextEncoder();
  let out = '';
  for (const ch of String(text)) {
    if (encoder.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}
