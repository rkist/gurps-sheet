// Unit tests for the shared character library, on a directory folder.
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ConflictError, DirectoryFolder, Library } from '../lib/storage.mjs';
import { FORMAT } from '../public/js/characters.js';

const character = (name, attrs = {}) => ({ attrs: { character_name: name, ...attrs }, sections: {} });

async function open(dir) {
  const library = new Library(new DirectoryFolder(dir));
  await library.load();
  return library;
}

describe('character library', () => {
  let dir;
  let library;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gurps-library-'));
    library = await open(dir);
  });

  afterEach(async () => {
    library.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('saves each change as a new file named after the character, and serves the newest', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot', { strength_points: 20 }));
    const v2 = await library.save('c-1', character('Sir Testalot', { strength_points: 30 }), v1.version);

    const files = await readdir(dir);
    assert.equal(files.length, 2);
    for (const file of files) assert.match(file, /^sir-testalot--\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/);

    assert.deepEqual(library.list(), [{ id: 'c-1', name: 'Sir Testalot', savedAt: v2.savedAt, version: v2.version }]);
    assert.equal((await library.get('c-1')).character.attrs.strength_points, 30);
    assert.deepEqual(library.versions('c-1').map((v) => v.version), [v2.version, v1.version]);
    assert.equal((await library.getVersion('c-1', v1.version)).character.attrs.strength_points, 20);
  });

  test('refuses a save based on an older version, and returns the current one', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot'));
    const v2 = await library.save('c-1', character('Sir Testalot', { strength_points: 30 }), v1.version);

    for (const base of [v1.version, null]) {
      await assert.rejects(library.save('c-1', character('Sir Stale'), base), (err) => {
        assert.ok(err instanceof ConflictError);
        assert.equal(err.latest.version, v2.version);
        assert.equal(err.latest.character.attrs.strength_points, 30);
        return true;
      });
    }
    assert.equal(library.versions('c-1').length, 2, 'nothing saved');
  });

  test('handles two saves of the same character at once', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot'));
    const results = await Promise.allSettled([
      library.save('c-1', character('Player one'), v1.version),
      library.save('c-1', character('Player two'), v1.version),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.ok(results.find((r) => r.status === 'rejected').reason instanceof ConflictError);
  });

  test('keeps one history when a character is renamed', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot'));
    await library.save('c-1', character('Sir Renamed'), v1.version);

    assert.deepEqual(library.list().map((c) => c.name), ['Sir Renamed']);
    assert.deepEqual(library.versions('c-1').map((v) => v.name), ['Sir Renamed', 'Sir Testalot']);
    assert.equal((await readdir(dir)).filter((f) => f.startsWith('sir-renamed--')).length, 1);
  });

  test('deletes by adding a file, so the history stays', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot'));
    const deleted = await library.remove('c-1', v1.version);

    assert.ok((await readdir(dir)).some((f) => /^sir-testalot--.*--deleted\.json$/.test(f)));
    assert.deepEqual(library.list(), []);
    assert.equal((await library.get('c-1')).deleted, true);
    assert.equal((await library.getVersion('c-1', v1.version)).character.name, 'Sir Testalot');
    assert.equal(await library.remove('c-nobody', null), null);

    // Saving on top of the deletion brings it back.
    await library.save('c-1', character('Sir Testalot'), deleted.version);
    assert.deepEqual(library.list().map((c) => c.id), ['c-1']);
  });

  test('finds the same characters and history after a restart', async () => {
    const v1 = await library.save('c-1', character('Sir Testalot'));
    await library.save('c-1', character('Sir Testalot', { strength_points: 30 }), v1.version);
    await library.save('c-2', character('Lady Other'));

    const restarted = await open(dir);
    assert.deepEqual(restarted.list(), library.list());
    assert.deepEqual(restarted.versions('c-1'), library.versions('c-1'));
    assert.deepEqual(await restarted.get('c-1'), await library.get('c-1'));
    restarted.close();
  });

  test('reads exports added to the folder by hand, and skips other files', async () => {
    const exported = { format: FORMAT, formatVersion: 1, characters: [character('Dropped In')] };
    await writeFile(path.join(dir, 'dropped-in.gurps.json'), JSON.stringify(exported));
    await writeFile(path.join(dir, 'everyone.json'), JSON.stringify({ ...exported, characters: [character('A'), character('B')] }));
    await writeFile(path.join(dir, 'notes.json'), '{"hello": "world"}');
    await writeFile(path.join(dir, 'broken.json'), '{');

    await library.refresh();
    const [listed, ...others] = library.list();
    assert.equal(others.length, 0);
    assert.equal(listed.name, 'Dropped In');
    assert.match(listed.id, /^c-[0-9a-f]{16}$/);

    const restarted = await open(dir);
    assert.equal(restarted.list()[0].id, listed.id, 'same id after a restart');
    restarted.close();
  });

  test('tries a file again once it has changed', async () => {
    const file = path.join(dir, 'copying.gurps.json');
    await writeFile(file, '{"format": "gurps-sheet-');
    await library.refresh();
    assert.deepEqual(library.list(), []);

    await writeFile(file, JSON.stringify({ format: FORMAT, characters: [character('Copied In')] }));
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    await library.refresh();
    assert.deepEqual(library.list().map((c) => c.name), ['Copied In']);
  });

  test('stores only plain attribute values and valid rows', async () => {
    await library.save('c-1', {
      attrs: { character_name: 'Sir Testalot', constructor: 'x', nested: { a: 1 }, Strength_Points: 20 },
      sections: { repeating_skills: ['-abc', 'not a row'], bogus: ['-def'] },
    });
    const { character: saved } = await library.get('c-1');
    assert.deepEqual(saved.attrs, { character_name: 'Sir Testalot', strength_points: 20 });
    assert.deepEqual(saved.sections, { repeating_skills: ['-abc'] });
    assert.equal(await library.save('c-2', { name: 'no attrs' }), null);
  });
});
