// Minimal static file server for the GURPS sheet builder. No dependencies.
// Characters live in each player's browser, so the server only serves files:
// the app from public/ and the vendored Roll20 sheet from GURPS/ at /sheet/.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, 'public');
const sheetRoot = path.join(here, 'GURPS');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const compressible = /^(text\/|application\/(json|manifest)|image\/svg)/;

// The sheet pulls a few images from external hosts; everything else is same-origin.
// The sheet code runs in a worker loaded from a blob: URL, hence `blob:` for scripts.
const csp = [
  "default-src 'self'",
  "script-src 'self' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data:',
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const gzCache = new Map();

// An error in one request (e.g. a file that can't be read) must not stop the server.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(res.headersSent ? undefined : 'Server error');
  });
});

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const [root, relative] = pathname.startsWith('/sheet/')
    ? [sheetRoot, pathname.slice('/sheet'.length)]
    : [appRoot, pathname];
  const file = path.join(root, relative);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }

  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': csp,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let body;
  if (compressible.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const cached = gzCache.get(file);
    if (cached && cached.etag === etag) {
      body = cached.body;
    } else {
      body = gzipSync(await readFile(file));
      gzCache.set(file, { etag, body });
    }
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  } else {
    body = await readFile(file);
  }
  headers['Content-Length'] = body.length;

  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`GURPS sheet builder running at http://${shown}:${port}`);
});
