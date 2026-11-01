// JSON API of the shared character library.
//
//   GET    /api/library                        { enabled, ready }: whether this server has a library
//   GET    /api/characters                    current version of every character, and the deleted ids
//   GET    /api/characters/:id                 { version, savedAt, character }
//   GET    /api/characters/:id/versions        history, newest first
//   GET    /api/characters/:id/versions/:vid   one version
//   POST   /api/characters/:id                 { character, baseVersion } -> new version
//   DELETE /api/characters/:id                 { baseVersion } -> "deleted" version
//
// There is no login: anyone who can reach the server can read and write. Saves
// never overwrite, so every change can be undone from the history; the limits
// below keep anyone from filling the store.
import { isCharacterId } from '../public/js/characters.js';
import { ConflictError } from './storage.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_DRAIN = 8 * MAX_BODY;
const WRITES_PER_MINUTE = 60;
const VERSION_ID = /^[A-Za-z0-9_.-]{1,200}$/;

const recentWrites = [];

export async function handleApi(req, res, pathname, library) {
  // Always 200, so the app can check for a library without an error in the console.
  if (pathname === '/api/library') {
    if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    return send(res, 200, library ? { enabled: true, ready: library.ready } : { enabled: false, ready: false });
  }
  if (!library) return send(res, 404, { error: 'This server has no shared character library.' });
  if (!library.ready) return send(res, 503, { error: 'The character library is still loading. Try again shortly.' }, { 'Retry-After': '5' });

  const [, , collection, id, sub, version, ...rest] = pathname.split('/');
  if (collection !== 'characters' || rest.length) return send(res, 404, { error: 'Not found' });
  if (id !== undefined && !isCharacterId(id)) return send(res, 404, { error: 'No such character' });
  if (sub !== undefined && sub !== 'versions') return send(res, 404, { error: 'Not found' });
  if (version !== undefined && !VERSION_ID.test(version)) return send(res, 404, { error: 'No such version' });

  if (req.method === 'GET') {
    if (!id) return send(res, 200, { characters: library.list(), deleted: library.deletedIds() });
    if (!sub) return found(res, await library.get(id));
    if (!version) return send(res, 200, { versions: library.versions(id) });
    return found(res, await library.getVersion(id, version));
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && id && !sub) {
    const body = await readJson(req, res);
    if (body === undefined) return;
    if (!allowWrite()) return send(res, 429, { error: 'Too many saves right now. Try again in a minute.' }, { 'Retry-After': '60' });
    const baseVersion = typeof body.baseVersion === 'string' ? body.baseVersion : null;
    try {
      const saved = req.method === 'POST' ? await library.save(id, body.character, baseVersion) : await library.remove(id, baseVersion);
      if (!saved) return send(res, req.method === 'POST' ? 400 : 404, { error: req.method === 'POST' ? 'That is not a character.' : 'No such character' });
      return send(res, req.method === 'POST' ? 201 : 200, saved);
    } catch (err) {
      if (err instanceof ConflictError) return send(res, 409, { error: err.message, latest: err.latest });
      throw err;
    }
  }

  return send(res, 405, { error: 'Method not allowed' }, { Allow: !id || sub ? 'GET' : 'GET, POST, DELETE' });
}

// A missing character is a 404; a deleted one too, but says it was deleted.
function found(res, result) {
  if (!result) return send(res, 404, { error: 'No such character' });
  if (result.deleted) return send(res, 404, { error: 'This character was deleted.', ...result });
  return send(res, 200, result);
}

export function allowWrite() {
  const now = Date.now();
  while (recentWrites.length && recentWrites[0] < now - 60_000) recentWrites.shift();
  if (recentWrites.length >= WRITES_PER_MINUTE) return false;
  recentWrites.push(now);
  return true;
}

// Resolves to the parsed body, or undefined after answering with an error.
// Resolves to the parsed body, or undefined after answering with an error.
async function readJson(req, res) {
  const text = await readBody(req, res, 'That character is too big (over 1 MB).');
  if (text === undefined) return undefined;
  try {
    const body = JSON.parse(text || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // answered below
  }
  send(res, 400, { error: 'The request body must be a JSON object.' });
  return undefined;
}

// Resolves to the body as text, or undefined after answering 413. A body a
// little over the limit is read to the end and refused, so the client reliably
// gets the answer (a client still sending when the connection closes sees a
// reset instead). A much bigger one is refused as soon as that is known, and
// the connection closed without reading the rest.
export function readBody(req, res, tooBigMessage) {
  return new Promise((resolve, reject) => {
    const tooBig = (close) => {
      send(res, 413, { error: tooBigMessage }, close ? { Connection: 'close' } : {});
      if (close) res.on('finish', () => req.destroy());
      resolve(undefined);
    };
    if (Number(req.headers['content-length']) > MAX_DRAIN) return tooBig(true);

    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > MAX_DRAIN && !res.headersSent) tooBig(true);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > MAX_DRAIN) return;
      if (size > MAX_BODY) return tooBig(false);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}
