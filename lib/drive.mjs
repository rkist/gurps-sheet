// A Google Drive folder as the character library's file store, through the
// Drive REST API with plain fetch. It signs in as one Google account with an
// OAuth refresh token (scripts/drive-auth.mjs gets one); a service account
// can't create files in a personal Drive folder.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FILE_FIELDS = 'id,name,createdTime,modifiedTime,properties';
const RETRIES = 2;

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class DriveFolder {
  constructor({ clientId, clientSecret, refreshToken, folderId, fetch = globalThis.fetch }) {
    if (!/^[A-Za-z0-9_-]+$/.test(folderId || '')) throw new Error(`Invalid Drive folder id: "${folderId}"`);
    Object.assign(this, { clientId, clientSecret, refreshToken, folderId, fetch });
    this.accessToken = null;
    this.expiresAt = 0;
  }

  describe() {
    return `Google Drive folder ${this.folderId}`;
  }

  async token(refresh = false) {
    if (!refresh && this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new DriveError(`Google sign-in failed: ${data.error_description || data.error || res.status}`, res.status);
    this.accessToken = data.access_token;
    // Renew a minute early so a request never goes out with an expired token.
    this.expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60_000;
    return this.accessToken;
  }

  // Retries once with a new token on 401, and a couple of times on 429 and
  // (unless `retryServerErrors` is false) on 5xx.
  async request(url, init = {}, { retryServerErrors = true } = {}) {
    let refresh = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(refresh);
      const res = await this.fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      if (res.ok) return res;
      if (res.status === 401 && !refresh) {
        refresh = true;
        continue;
      }
      if ((res.status === 429 || (res.status >= 500 && retryServerErrors)) && attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      throw new DriveError(`Google Drive: ${data.error?.message || res.statusText || res.status}`, res.status);
    }
  }

  // Name, id and properties of every file in the folder (not its subfolders),
  // or of the files with the given name.
  async listFiles(name) {
    let q = `'${this.folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
    if (name !== undefined) q += ` and name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const data = await (await this.request(`${API}/files?${params}`)).json();
      files.push(...(data.files || []));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  async readFile(id) {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    return res.text();
  }

  // Drive may have stored a file even when the upload answers with a 5xx, so
  // before trying again, look for it: same name (which includes the time) and
  // same properties, since two characters can share a name.
  async createFile(file) {
    try {
      return await this.upload(file);
    } catch (err) {
      if (!(err instanceof DriveError && err.status >= 500)) throw err;
      const wanted = Object.entries(file.properties || {});
      const stored = (await this.listFiles(file.name)).find((f) => wanted.every(([k, v]) => f.properties?.[k] === v));
      return stored || this.upload(file);
    }
  }

  async upload({ name, properties, content }) {
    const boundary = `gurps-${Math.random().toString(36).slice(2)}`;
    const metadata = { name, parents: [this.folderId], mimeType: 'application/json', properties };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const params = new URLSearchParams({ uploadType: 'multipart', fields: FILE_FIELDS, supportsAllDrives: 'true' });
    const res = await this.request(
      `${UPLOAD}/files?${params}`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
      { retryServerErrors: false },
    );
    return res.json();
  }
}
