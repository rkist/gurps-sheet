// Unit tests for the Google Drive file store, against a fake Drive API.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DriveError, DriveFolder } from '../lib/drive.mjs';
import { Library } from '../lib/storage.mjs';

const FOLDER = 'folder-123';

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Just enough of the token endpoint and Drive v3 for DriveFolder. `failures`
// is a list of statuses to answer the next Drive calls with; `storeThenFail`
// is a list of statuses to answer the next uploads with after storing them.
function fakeGoogle({ pageSize = 2, failures = [], storeThenFail = [], tokenError = null } = {}) {
  const google = { files: [], tokens: 0, calls: [], failures: [...failures], storeThenFail: [...storeThenFail] };
  google.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    google.calls.push(`${method} ${u.pathname}${u.searchParams.get('alt') ? '?alt=' + u.searchParams.get('alt') : ''}`);

    if (u.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), 'refresh-me');
      if (tokenError) return json(400, { error: tokenError, error_description: 'Token has been expired or revoked.' });
      return json(200, { access_token: `token-${++google.tokens}`, expires_in: 3600 });
    }

    assert.equal(init.headers.Authorization, `Bearer token-${google.tokens}`);
    const failure = google.failures.shift();
    if (failure) return json(failure, { error: { message: `fake ${failure}` } });

    if (method === 'GET' && u.pathname === '/drive/v3/files') {
      const [folderQuery, nameQuery] = u.searchParams.get('q').split(" and name = '");
      assert.equal(folderQuery, `'${FOLDER}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
      const name = nameQuery?.slice(0, -1).replace(/\\(.)/g, '$1');
      const matching = google.files.filter((f) => name === undefined || f.name === name);
      const start = Number(u.searchParams.get('pageToken') || 0);
      const files = matching.slice(start, start + pageSize).map(({ content, parents, ...meta }) => meta);
      const next = start + pageSize < matching.length ? String(start + pageSize) : undefined;
      return json(200, { files, nextPageToken: next });
    }
    if (method === 'GET' && u.pathname.startsWith('/drive/v3/files/') && u.searchParams.get('alt') === 'media') {
      const file = google.files.find((f) => f.id === decodeURIComponent(u.pathname.split('/').pop()));
      return file ? new Response(file.content) : json(404, { error: { message: 'File not found' } });
    }
    if (method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      assert.equal(u.searchParams.get('uploadType'), 'multipart');
      const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
      const [metaPart, contentPart] = init.body.split(`--${boundary}`).slice(1, 3);
      const metadata = JSON.parse(metaPart.split('\r\n\r\n')[1]);
      const file = {
        id: `file-${google.files.length + 1}`,
        name: metadata.name,
        parents: metadata.parents,
        createdTime: new Date().toISOString(),
        modifiedTime: new Date().toISOString(),
        properties: metadata.properties,
        content: contentPart.split('\r\n\r\n')[1].replace(/\r\n$/, ''),
      };
      google.files.push(file);
      const stored = google.storeThenFail.shift();
      if (stored) return json(stored, { error: { message: `fake ${stored}` } });
      const { content, parents, ...meta } = file;
      return json(200, meta);
    }
    return json(404, { error: { message: `fake Drive has no ${method} ${u.pathname}` } });
  };
  return google;
}

const folder = (google) =>
  new DriveFolder({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh-me', folderId: FOLDER, fetch: google.fetch });

describe('Google Drive folder', () => {
  test('creates files in the folder with their properties, and reads them back', async () => {
    const google = fakeGoogle();
    const drive = folder(google);
    const created = await drive.createFile({ name: 'sir-testalot--x.json', properties: { characterId: 'c-1' }, content: '{"a": 1}' });

    assert.equal(created.name, 'sir-testalot--x.json');
    assert.deepEqual(google.files[0].parents, [FOLDER]);
    assert.deepEqual(created.properties, { characterId: 'c-1' });
    assert.equal(await drive.readFile(created.id), '{"a": 1}');
  });

  test('lists every page of the folder', async () => {
    const google = fakeGoogle({ pageSize: 2 });
    const drive = folder(google);
    for (let i = 0; i < 5; i++) await drive.createFile({ name: `f${i}.json`, properties: {}, content: '{}' });
    assert.deepEqual((await drive.listFiles()).map((f) => f.name), ['f0.json', 'f1.json', 'f2.json', 'f3.json', 'f4.json']);
  });

  test('signs in once, and again when Google rejects the token', async () => {
    const google = fakeGoogle();
    const drive = folder(google);
    await drive.listFiles();
    await drive.listFiles();
    assert.equal(google.tokens, 1);

    google.failures.push(401);
    await drive.listFiles();
    assert.equal(google.tokens, 2);
  });

  test('retries when Drive is busy, and reports errors', async () => {
    const google = fakeGoogle({ failures: [503] });
    await folder(google).listFiles();
    assert.deepEqual(google.calls.filter((c) => c.endsWith('/drive/v3/files')).length, 2);

    google.failures.push(403);
    await assert.rejects(folder(google).listFiles(), (err) => err instanceof DriveError && err.status === 403 && /fake 403/.test(err.message));

    await assert.rejects(folder(fakeGoogle({ tokenError: 'invalid_grant' })).listFiles(), /Google sign-in failed: Token has been expired or revoked/);
  });

  test('creates a file once when an upload fails with a server error', async () => {
    const stored = fakeGoogle({ storeThenFail: [500] });
    const file = await folder(stored).createFile({ name: "o'brien--x.json", properties: {}, content: '{}' });
    assert.equal(stored.files.length, 1, 'found the stored file instead of uploading again');
    assert.equal(file.id, stored.files[0].id);

    const lost = fakeGoogle({ failures: [500] });
    await folder(lost).createFile({ name: 'lost--x.json', properties: {}, content: '{}' });
    assert.equal(lost.files.length, 1, 'uploaded again when nothing was stored');

    // Another character with the same name, saved in the same millisecond.
    const twins = fakeGoogle();
    const drive = folder(twins);
    const first = await drive.createFile({ name: 'twin--x.json', properties: { characterId: 'c-1', savedAt: '1' }, content: '{}' });
    twins.failures.push(500);
    const second = await drive.createFile({ name: 'twin--x.json', properties: { characterId: 'c-2', savedAt: '1' }, content: '{}' });
    assert.notEqual(second.id, first.id);
    assert.deepEqual(twins.files.map((f) => f.properties.characterId), ['c-1', 'c-2']);
  });

  test('keeps names that are too long for a Drive property', async () => {
    const google = fakeGoogle();
    const library = new Library(folder(google));
    await library.load();
    const name = 'Sir ' + 'Very Long Name '.repeat(10).trim();
    await library.save('c-1', { attrs: { character_name: name } });
    library.close();

    assert.ok(Buffer.byteLength(google.files[0].properties.name) <= 100);
    const restarted = new Library(folder(google));
    await restarted.load();
    assert.equal(restarted.list()[0].name, name);
    restarted.close();
  });

  test('keeps the library, and rebuilds its index from file properties alone', async () => {
    const google = fakeGoogle();
    const library = new Library(folder(google));
    await library.load();
    const v1 = await library.save('c-1', { attrs: { character_name: 'Sir Testalot', strength_points: 20 } });
    await library.save('c-1', { attrs: { character_name: 'Sir Testalot', strength_points: 30 } }, v1.version);
    library.close();

    google.calls.length = 0;
    const restarted = new Library(folder(google));
    await restarted.load();
    assert.ok(!google.calls.some((c) => c.includes('alt=media')), 'no file contents read to build the index');
    assert.deepEqual(restarted.list().map((c) => c.name), ['Sir Testalot']);
    assert.equal((await restarted.get('c-1')).character.attrs.strength_points, 30);
    restarted.close();
  });
});
