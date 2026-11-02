// The text of the group's GURPS rulebooks, for the MCP tools search_rules and
// read_rules: Markdown files made by scripts/book-to-markdown.mjs, one per PDF,
// with a marker <a id="M23"></a>**[M23]** at the start of every printed page.
// They come from a directory (RULES_DIR) or a Google Drive folder
// (RULES_FOLDER_ID, with the library's Google credentials), are read into
// memory and searched with BM25 over sections: a heading and the text under it.
//
// This is book text: server.mjs only loads it when MCP_TOKEN keeps /mcp private.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseRefs } from '../public/js/page-refs.js';
import { DriveFolder } from './drive.mjs';

const REFRESH_MS = 10 * 60_000;
const MARKER = /^<a id="([^"]+)"><\/a>\*\*\[[^\]]*\]\*\*$/;
const MAX_PASSAGE = 1500; // characters of a section shown in a search result
const STOP_WORDS = new Set(
  'a an and are as at be by can do does for from has have he her his how i if in is it its may of on or so than that the their them then there they this to was what when which who will with you your'.split(' '),
);

// Picks the rules folder from the environment: RULES_DIR, or RULES_FOLDER_ID
// with the Google OAuth client and refresh token. Neither: no rules.
export function rulesFromEnv(env) {
  if (env.RULES_DIR) return new Rules(new MarkdownDirectory(env.RULES_DIR));
  if (!env.RULES_FOLDER_ID) return null;
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`RULES_FOLDER_ID is set but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not`);
  return new Rules(
    new DriveFolder({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken: env.GOOGLE_REFRESH_TOKEN,
      folderId: env.RULES_FOLDER_ID,
    }),
  );
}

// The .md files of a directory, with the part of DriveFolder's interface Rules uses.
export class MarkdownDirectory {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  describe() {
    return `directory ${this.dir}`;
  }

  async listFiles() {
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.md'));
    return Promise.all(
      names.map(async (name) => ({ id: name, name, modifiedTime: (await stat(path.join(this.dir, name))).mtime.toISOString() })),
    );
  }

  readFile(id) {
    if (id !== path.basename(id)) throw new Error(`Invalid file name: ${id}`);
    return readFile(path.join(this.dir, id), 'utf8');
  }
}

// A page's ref as the markers write it: M23, or PU2:12 for a code ending in a digit.
const refText = (code, page) => (/\d$/.test(code) ? `${code}:${page}` : `${code}${page}`);

// Lowercase words without accents or common words, plurals made singular.
export function words(text) {
  const all = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return all.filter((w) => !STOP_WORDS.has(w)).map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

// A book file: { code, title, source, pages: [{ ref, page, text }] }.
export function parseBook(markdown) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!front) throw new Error('no front matter (is it from scripts/book-to-markdown.mjs?)');
  const meta = {};
  for (const line of front[1].split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    try {
      meta[m[1]] = JSON.parse(m[2]);
    } catch {
      meta[m[1]] = m[2];
    }
  }
  if (!meta.code) throw new Error('no book code in the front matter');
  const pages = [];
  for (const line of markdown.slice(front[0].length).split('\n')) {
    const marker = MARKER.exec(line);
    if (marker) {
      const [ref] = parseRefs(marker[1]);
      if (ref) pages.push({ ref: marker[1], page: ref.page, lines: [] });
    } else {
      pages[pages.length - 1]?.lines.push(line);
    }
  }
  return {
    code: String(meta.code).toUpperCase(),
    title: String(meta.title || meta.code),
    source: meta.source,
    pages: pages.map(({ lines, ...page }) => ({ ...page, text: lines.join('\n').trim() })),
  };
}

// A book's sections: the text under each heading, page by page. Text before a
// page's first heading belongs to the last heading before it.
function sections(book) {
  const out = [];
  let heading = '';
  for (const page of book.pages) {
    let section = { book, ref: page.ref, heading, paragraphs: [] };
    out.push(section);
    for (const paragraph of page.text.split(/\n\n+/)) {
      const h = /^#+\s+(.*)$/.exec(paragraph);
      if (h) {
        heading = h[1];
        section = { book, ref: page.ref, heading, paragraphs: [] };
        out.push(section);
      } else {
        section.paragraphs.push(paragraph);
      }
    }
  }
  return out.filter((s) => s.paragraphs.length);
}

export class Rules {
  constructor(folder) {
    this.folder = folder;
    this.ready = false;
    this.files = new Map(); // file id -> { modifiedTime, book }
    this.books = [];
    this.pages = new Map(); // ref -> { book, index }
    this.index = { sections: [], df: new Map(), length: 1 };
  }

  describe() {
    return this.folder.describe();
  }

  async load() {
    await this.refresh();
    this.ready = true;
    // Picks up books added to the folder.
    this.timer = setInterval(() => {
      this.refresh().catch((err) => console.error('Could not refresh the rules:', err.message));
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }

  // Reads new and changed files, forgets removed ones, and rebuilds the index
  // when anything changed. A file that isn't a book is skipped until it
  // changes; one that couldn't be read (e.g. Drive failing) is tried again next
  // time, keeping what was read of it before.
  async refresh() {
    const listed = (await this.folder.listFiles()).filter((f) => f.name.endsWith('.md'));
    let changed = listed.length !== this.files.size;
    const files = new Map();
    for (const file of listed) {
      const known = this.files.get(file.id);
      if (known && known.modifiedTime === file.modifiedTime) {
        files.set(file.id, known);
        continue;
      }
      let text;
      try {
        text = await this.folder.readFile(file.id);
      } catch (err) {
        console.error(`Could not read "${file.name}" of the rules, trying again later: ${err.message}`);
        if (known) files.set(file.id, { ...known, modifiedTime: null });
        continue;
      }
      changed = true;
      try {
        files.set(file.id, { modifiedTime: file.modifiedTime, name: file.name, book: parseBook(text) });
      } catch (err) {
        console.error(`Skipping "${file.name}" in the rules: ${err.message}`);
        files.set(file.id, { modifiedTime: file.modifiedTime, name: file.name, book: null });
      }
    }
    if (!changed) return;
    this.files = files;
    const books = [...files.values()].filter((f) => f.book).sort((a, b) => a.name.localeCompare(b.name));
    this.build(books.map((f) => ({ ...f.book, file: f.name })));
  }

  // Indexes the books. A book with a page another book already has (the same
  // book twice, or the Basic Set whole and split) is left out.
  build(books = this.books) {
    this.pages = new Map();
    this.books = [];
    const all = [];
    for (const book of books) {
      const taken = book.pages.find((page) => this.pages.has(page.ref));
      if (taken) {
        const other = this.pages.get(taken.ref).book;
        console.error(`Skipping "${book.file || book.title}" in the rules: ${other.file || other.title} has its page ${taken.ref} already.`);
        continue;
      }
      book.pages.forEach((page, index) => this.pages.set(page.ref, { book, index }));
      this.books.push(book);
      all.push(...sections(book));
    }
    this.books.sort((a, b) => a.code.localeCompare(b.code) || (a.pages[0]?.page ?? 0) - (b.pages[0]?.page ?? 0));
    const df = new Map();
    let total = 0;
    for (const section of all) {
      // A word in the heading counts three times.
      const counts = new Map();
      for (const w of [...words(section.heading), ...words(section.heading), ...words(section.heading), ...words(section.paragraphs.join(' '))]) {
        counts.set(w, (counts.get(w) || 0) + 1);
      }
      section.counts = counts;
      section.length = [...counts.values()].reduce((a, b) => a + b, 0);
      total += section.length;
      for (const w of counts.keys()) df.set(w, (df.get(w) || 0) + 1);
    }
    this.index = { sections: all, df, length: total / (all.length || 1) };
  }

  // The best sections for a query, optionally in one book code: [{ book, ref,
  // heading, text }], the text cut to the paragraphs that match best.
  search(query, { code, limit = 8 } = {}) {
    const terms = [...new Set(words(query))];
    if (!terms.length) return [];
    const { sections: all, df, length: average } = this.index;
    const n = all.length;
    const wanted = words(query).join(' ');
    const scored = [];
    for (const section of all) {
      if (code && section.book.code !== code) continue;
      let score = 0;
      for (const term of terms) {
        const tf = section.counts.get(term);
        if (!tf) continue;
        const idf = Math.log(1 + (n - df.get(term) + 0.5) / (df.get(term) + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * section.length) / average));
      }
      // Asking for something by its name, e.g. a spell.
      if (score && words(section.heading).join(' ') === wanted) score *= 2;
      if (score) scored.push({ section, score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ section }) => ({ book: section.book, ref: section.ref, heading: section.heading, text: passage(section.paragraphs, terms) }));
  }

  // Pages from a ref like "B243", "M23-25" or "PU2:12", up to `count` of them
  // (a range sets its own count): [{ book, ref, text }], or null if no book has it.
  read(text, count = 1) {
    const [ref] = parseRefs(text);
    if (!ref) return null;
    const found = this.pages.get(refText(ref.code, ref.page));
    if (!found) return null;
    const range = /[-–—]\D*(\d+)$/.exec(ref.text);
    const end = range ? Math.max(ref.page, Number(range[1])) : ref.page + count - 1;
    const pages = [];
    for (let i = found.index; i < found.book.pages.length && pages.length < 10; i++) {
      const page = found.book.pages[i];
      if (page.page > end) break;
      pages.push({ book: found.book, ref: page.ref, text: page.text });
    }
    return pages;
  }
}

// The paragraphs of a section that match the query best, up to MAX_PASSAGE
// characters: from the best one on, with "…" where some are left out.
function passage(paragraphs, terms) {
  const text = paragraphs.join('\n\n');
  if (text.length <= MAX_PASSAGE) return text;
  const hits = paragraphs.map((p) => {
    const ws = new Set(words(p));
    return terms.filter((t) => ws.has(t)).length;
  });
  const start = hits.indexOf(Math.max(...hits));
  let out = start ? '…\n\n' : '';
  for (let i = start; i < paragraphs.length; i++) {
    if (out.length + paragraphs[i].length > MAX_PASSAGE) {
      // The best paragraph alone is too long: the part around its first match.
      if (i === start) return `${out}${excerpt(paragraphs[i], terms, MAX_PASSAGE - out.length)}`;
      return `${out}…`;
    }
    out += `${paragraphs[i]}\n\n`;
  }
  return out.trimEnd();
}

function excerpt(paragraph, terms, length) {
  const lower = paragraph.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const hit = found.length ? Math.min(...found) : 0;
  const from = hit < length / 2 ? 0 : paragraph.lastIndexOf(' ', hit - 200) + 1;
  return `${from ? '…' : ''}${paragraph.slice(from, from + length - 2).trimEnd()}…`;
}
