// Gets the OAuth refresh token that lets the server use the Google Drive folder
// of the shared character library. Run it once, on a computer with a browser:
//
//   DRIVE_FOLDER_ID=... node scripts/drive-auth.mjs client_secret_....json --save-to .env.library
//
// The client JSON is the file Google offers for a "Desktop app" OAuth client;
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET can be set instead. Open the link it
// prints, sign in as the Google account that can edit the folder and allow
// access. It checks that the account can add files to the folder, then writes
// the server's four variables to the --save-to file (readable only by you), or
// prints them without one. See "Shared character library" in README.md.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({ options: { 'save-to': { type: 'string' } }, allowPositionals: true });
const client = positionals[0] ? Object.values(JSON.parse(readFileSync(positionals[0], 'utf8')))[0] : {};
const clientId = client.client_id || process.env.GOOGLE_CLIENT_ID;
const clientSecret = client.client_secret || process.env.GOOGLE_CLIENT_SECRET;
const folderId = process.env.DRIVE_FOLDER_ID;
if (!clientId || !clientSecret || !folderId) {
  console.error('Usage: DRIVE_FOLDER_ID=... node scripts/drive-auth.mjs <client_secret.json> [--save-to <path>]');
  console.error('(or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET instead of passing the JSON file)');
  process.exit(1);
}

const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(16).toString('hex');

const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive',
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256',
  state,
});
console.log(`Open this link, sign in as the account that can edit the folder, and allow access:\n\n${authUrl}\n`);

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    if (!params.has('code') && !params.has('error')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ok = params.get('state') === state && params.has('code');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(ok ? 'Done. You can close this tab and go back to the terminal.' : 'Sign-in failed. See the terminal.');
    server.close();
    if (ok) resolve(params.get('code'));
    else reject(new Error(params.get('error') || 'the answer did not match this sign-in'));
  });
});

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  console.error('Google did not return a refresh token:', tokens.error_description || tokens.error || tokenRes.status);
  process.exit(1);
}

const drive = (route) =>
  fetch(`https://www.googleapis.com/drive/v3/${route}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }).then((r) => r.json());
const about = await drive('about?fields=user(emailAddress)');
console.log(`Signed in as ${about.user?.emailAddress ?? 'an unknown account'}.`);

const folder = await drive(`files/${encodeURIComponent(folderId)}?fields=name,capabilities(canAddChildren)&supportsAllDrives=true`);
if (folder.error) console.error(`Can't open folder ${folderId}: ${folder.error.message}`);
else if (!folder.capabilities?.canAddChildren) console.error(`This account can see "${folder.name}" but can't add files to it.`);
else console.log(`This account can add files to "${folder.name}".`);

const env =
  `DRIVE_FOLDER_ID=${folderId}\nGOOGLE_CLIENT_ID=${clientId}\n` +
  `GOOGLE_CLIENT_SECRET=${clientSecret}\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
if (options['save-to']) {
  // A new file replaces the old one, since `mode` only applies when a file is
  // created and an existing one may be readable by others.
  const tmp = `${options['save-to']}.${process.pid}.tmp`;
  writeFileSync(tmp, env, { mode: 0o600, flag: 'wx' });
  renameSync(tmp, options['save-to']);
  console.log(`\nWrote the server's settings to ${options['save-to']}.`);
} else {
  console.log(`\nGive the server these settings:\n\n${env}`);
}
