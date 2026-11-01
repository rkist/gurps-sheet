// Tests for the shared library's HTTP API, on a server with a directory library.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { sleep, startServer } from './helpers.mjs';

const skip = process.env.TEST_URL ? 'needs its own server with a library' : false;

async function call(base, method, route, body) {
  const res = await fetch(new URL(route, base), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function startWithLibrary() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gurps-api-'));
  const server = await startServer({ env: { STORAGE_DIR: dir } });
  for (let i = 0; (await fetch(new URL('api/characters', server.url))).status === 503; i++) {
    if (i > 50) throw new Error('The library never loaded');
    await sleep(100);
  }
  return {
    url: server.url,
    stop: async () => {
      server.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const sir = (strength) => ({ attrs: { character_name: 'Sir Testalot', strength_points: strength }, sections: {} });

describe('library API', { skip }, () => {
  let server;
  before(async () => {
    server = await startWithLibrary();
  });
  after(() => server?.stop());

  test('saves versions, serves the newest and keeps the history', async () => {
    assert.deepEqual((await call(server.url, 'GET', 'api/characters')).body, { characters: [] });

    const first = await call(server.url, 'POST', 'api/characters/c-sir', { character: sir(20) });
    assert.equal(first.status, 201);
    const second = await call(server.url, 'POST', 'api/characters/c-sir', { character: sir(30), baseVersion: first.body.version });
    assert.equal(second.status, 201);

    const list = await call(server.url, 'GET', 'api/characters');
    assert.deepEqual(list.body.characters.map((c) => [c.id, c.name, c.version]), [['c-sir', 'Sir Testalot', second.body.version]]);
    assert.equal(list.headers.get('cache-control'), 'no-store');

    const current = await call(server.url, 'GET', 'api/characters/c-sir');
    assert.equal(current.body.version, second.body.version);
    assert.equal(current.body.character.attrs.strength_points, 30);

    const versions = await call(server.url, 'GET', 'api/characters/c-sir/versions');
    assert.deepEqual(versions.body.versions.map((v) => v.version), [second.body.version, first.body.version]);
    const old = await call(server.url, 'GET', `api/characters/c-sir/versions/${first.body.version}`);
    assert.equal(old.body.character.attrs.strength_points, 20);
  });

  test('answers 409 with the current version when a save is based on an old one', async () => {
    const first = await call(server.url, 'POST', 'api/characters/c-race', { character: sir(20) });
    const theirs = await call(server.url, 'POST', 'api/characters/c-race', { character: sir(25), baseVersion: first.body.version });
    const mine = await call(server.url, 'POST', 'api/characters/c-race', { character: sir(30), baseVersion: first.body.version });
    assert.equal(mine.status, 409);
    assert.equal(mine.body.latest.version, theirs.body.version);
    assert.equal(mine.body.latest.character.attrs.strength_points, 25);
  });

  test('deletes by adding a version, which still shows in the history', async () => {
    const saved = await call(server.url, 'POST', 'api/characters/c-gone', { character: sir(20) });
    const deleted = await call(server.url, 'DELETE', 'api/characters/c-gone', { baseVersion: saved.body.version });
    assert.equal(deleted.status, 200);

    const current = await call(server.url, 'GET', 'api/characters/c-gone');
    assert.equal(current.status, 404);
    assert.equal(current.body.deleted, true);
    assert.ok(!(await call(server.url, 'GET', 'api/characters')).body.characters.some((c) => c.id === 'c-gone'));
    assert.equal((await call(server.url, 'GET', 'api/characters/c-gone/versions')).body.versions.length, 2);
  });

  test('rejects bad requests', async () => {
    assert.equal((await call(server.url, 'GET', 'api/characters/c-nobody')).status, 404);
    assert.equal((await call(server.url, 'GET', 'api/characters/not-an-id')).status, 404);
    assert.equal((await call(server.url, 'GET', 'api/characters/c-sir/versions/nope')).status, 404);
    assert.equal((await call(server.url, 'GET', 'api/other')).status, 404);
    assert.equal((await call(server.url, 'DELETE', 'api/characters/c-nobody', {})).status, 404);
    assert.equal((await call(server.url, 'PUT', 'api/characters/c-sir', {})).status, 405);
    assert.equal((await call(server.url, 'POST', 'api/characters', {})).status, 405);
    assert.equal((await call(server.url, 'POST', 'api/characters/c-bad', '{not json')).status, 400);
    assert.equal((await call(server.url, 'POST', 'api/characters/c-bad', { character: { name: 'no attrs' } })).status, 400);

    const huge = { character: { attrs: { character_name: 'Big', notes: 'x'.repeat(1024 * 1024) } } };
    assert.equal((await call(server.url, 'POST', 'api/characters/c-big', huge)).status, 413);
  });

  test('refuses a body over the limit without reading all of it', async () => {
    // Chunked, so the server only learns the size while reading. It answers 413
    // and closes the connection, which the client may see as a reset instead.
    const total = 64 * 1024 * 1024;
    let sent = 0;
    const outcome = await new Promise((resolve) => {
      const req = http.request(new URL('api/characters/c-big', server.url), { method: 'POST' }, (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', (err) => resolve(err.code));
      const chunk = Buffer.alloc(64 * 1024, 'x');
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!req.write(chunk)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(outcome), `got ${outcome}`);
    assert.ok(sent < total, 'the server stopped reading before the end');
  });

  test('refuses a body whose stated size is over the limit before it is sent', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(new URL('api/characters/c-big', server.url), {
        method: 'POST',
        headers: { 'Content-Length': 64 * 1024 * 1024 },
      });
      req.on('response', (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    assert.equal(status, 413);
  });
});

describe('library API limits', { skip }, () => {
  test('limits saves per minute', async () => {
    const server = await startWithLibrary();
    try {
      const statuses = [];
      for (let i = 0; i < 61; i++) statuses.push((await call(server.url, 'POST', `api/characters/c-spam-${i}`, { character: sir(i) })).status);
      assert.deepEqual([...new Set(statuses.slice(0, 60))], [201]);
      assert.equal(statuses[60], 429);
    } finally {
      await server.stop();
    }
  });

  test('is off when no library is configured', async () => {
    const server = await startServer();
    try {
      const res = await call(server.url, 'GET', 'api/characters');
      assert.equal(res.status, 404);
      assert.match(res.body.error, /no shared character library/);
    } finally {
      server.stop();
    }
  });
});
