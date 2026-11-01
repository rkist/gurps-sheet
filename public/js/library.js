// Client for the server's shared character library (lib/api.mjs). Requests that
// can't reach it reject with LibraryError status 0.

export class LibraryError extends Error {
  constructor(message, status, body = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Browsers drop keepalive requests with bodies over 64 KB.
const KEEPALIVE_LIMIT = 60 * 1024;

async function call(method, route, body, { keepalive = false } = {}) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  let res;
  try {
    res = await fetch(`api/${route}`, {
      method,
      headers: json === undefined ? {} : { 'Content-Type': 'application/json' },
      body: json,
      keepalive: keepalive && json !== undefined && json.length < KEEPALIVE_LIMIT,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new LibraryError("Can't reach the server.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new LibraryError(data.error || `The server answered ${res.status}.`, res.status, data);
  return data;
}

// { enabled, ready }
export const status = () => call('GET', 'library');

// { characters: [{ id, name, savedAt, version }], deleted: [id] }
export const list = () => call('GET', 'characters');

// { version, savedAt, character }; 404 if there is none, with `deleted` if it was deleted.
export const get = (id) => call('GET', `characters/${id}`);

// { version, savedAt }; 409 with `latest` if `baseVersion` isn't the current version.
export const save = (id, character, baseVersion, options) => call('POST', `characters/${id}`, { character, baseVersion }, options);

export const remove = (id, baseVersion) => call('DELETE', `characters/${id}`, { baseVersion });
