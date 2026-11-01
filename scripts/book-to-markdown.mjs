// Turns a GURPS PDF with a text layer into Markdown for looking up rules: one
// file per PDF, where every printed page starts with a marker such as
// <a id="M23"></a>**[M23]** (book code and page, as the sheet's Ref fields
// write them), headings come from the font sizes, lines are joined back into
// paragraphs, and page references like "p. 14" or "p. B184" become links.
// The text comes from scripts/pdf-lines.swift, so this runs on macOS.
//
// The output is the book's text: keep it private, never in this repository or
// the Docker image (both are public).
//
//   node scripts/book-to-markdown.mjs "GURPS Magic.pdf" --code M --out ~/rules
//     [--title "GURPS Magic"] [--offset 1]
//
// --offset is the PDF page index (from 0) minus the printed page number; it is
// found from the page numbers in the footers when left out.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { slug } from '../public/js/characters.js';

const BAND = 45;       // points at the top and bottom with running titles and page numbers
const COLUMN_GAP = 40; // body lines starting further apart than this may be in different columns
const INDENT = 3;      // a line starting further right than the one before starts a paragraph
const NARROW = 0.7;    // a line this much narrower than usual ends a paragraph (or is a table row)

export const refText = (code, page) => (/\d$/.test(code) ? `${code}:${page}` : `${code}${page}`);

const mostCommon = (counts, fallback) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;

// The font size of most of the text.
export function bodySize(pages) {
  const weight = new Map();
  for (const page of pages) for (const line of page.lines) weight.set(line.size, (weight.get(line.size) || 0) + line.text.length);
  return mostCommon(weight, 10);
}

// The usual width of a body line, i.e. of a column, to 5 points.
export function lineWidth(pages, size) {
  const count = new Map();
  for (const page of pages) {
    for (const line of page.lines) {
      if (line.size !== size) continue;
      const w = Math.round(line.w / 5) * 5;
      count.set(w, (count.get(w) || 0) + 1);
    }
  }
  return mostCommon(count, 0);
}

const inBand = (page, line) => line.y < BAND || line.y + line.h > page.height - BAND;

// The PDF page index minus the printed page number, by a vote of the numbers
// in the pages' footers (e.g. a running title "AIR SPELLS 23"), or headers when
// the footers have none. Throws when no offset clearly wins, e.g. when chapter
// page numbers compete with the book's.
export function detectOffset(pages) {
  for (const bottom of [true, false]) {
    const votes = new Map();
    for (const page of pages) {
      for (const line of page.lines) {
        if (!inBand(page, line) || (line.y < BAND) !== bottom) continue;
        for (const m of line.text.matchAll(/(?<![\d,.])\d{1,4}(?![\d,])/g)) {
          const offset = page.index - Number(m[0]);
          votes.set(offset, (votes.get(offset) || 0) + 1);
        }
      }
    }
    if (!votes.size) continue;
    const [[offset, count], second] = [...votes].sort((a, b) => b[1] - a[1]);
    if (second && second[1] * 2 > count) throw new Error(`The page numbers suggest offsets ${offset} and ${second[0]}; give --offset.`);
    return offset;
  }
  return undefined;
}

const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

// The lines in reading order, with their column: columns left to right, each
// top to bottom. A column starts where body lines start beyond the usual right
// edge of the column before; lines starting within a column (an inset box, a
// quote's author, a centered heading) stay in it, in their place from the top,
// as do lines starting left of the first column.
export function readingOrder(lines, size) {
  const clusters = [];
  for (const line of lines.filter((l) => l.size === size).sort((a, b) => a.x - b.x)) {
    const last = clusters[clusters.length - 1];
    if (last && line.x - last.end <= COLUMN_GAP) Object.assign(last, { end: line.x }).rights.push(line.x + line.w);
    else clusters.push({ start: line.x, end: line.x, rights: [line.x + line.w] });
  }
  const columns = [];
  for (const cluster of clusters) {
    const last = columns[columns.length - 1];
    if (last && cluster.start < median(last.rights) - 5) last.rights.push(...cluster.rights);
    else columns.push(cluster);
  }
  const starts = columns.map((c) => c.start);
  const column = (line) => Math.max(0, starts.filter((start) => line.x + 15 >= start).length - 1);
  return lines
    .map((line) => ({ ...line, column: column(line) }))
    .sort((a, b) => a.column - b.column || b.y - a.y || a.x - b.x);
}

// Lines of a paragraph, with words split at the end of a line put back together.
export function joinLines(lines) {
  return lines.reduce((text, line) => {
    if (!text) return line;
    if (/[a-z]-$/.test(text) && /^[a-z]/.test(line)) return text.slice(0, -1) + line;
    return `${text} ${line}`;
  }, '');
}

// "p. 14" and "pp. 21-22" in a book point at its own pages: they link to the
// page markers. "p. B184" names its book already and stays as it is.
export function linkRefs(text, code) {
  return text.replace(
    /\b(pp?)\.\s?(?:([A-Z][A-Z0-9]*:|[A-Z]{1,5}))?(\d{1,4})(?:\s?[-–]\s?(?:[A-Z]{1,5})?\d{1,4})?(?![\d:])/g,
    (match, p, other, page) => (other ? match : `[${match}](#${refText(code, Number(page))})`),
  );
}

// One page's lines, in reading order, as Markdown blocks. A size well above
// the body text is a heading (two heading lines in a row are one heading);
// slightly above, a label like a spell's class; body lines join into
// paragraphs until a line indented from the one before, a gap, a short line
// (a paragraph's last, or a table row; but text around a picture is short too,
// so a line going on in lowercase still joins) or anything else. `width` is
// the usual width of a line (lineWidth).
export function pageMarkdown(lines, size, code, width) {
  const left = new Map(); // column -> where its body lines start
  for (const line of lines) if (line.size === size) left.set(line.column, Math.min(left.get(line.column) ?? Infinity, line.x));
  const blocks = [];
  let block = null;
  let prev = null;
  for (const line of lines) {
    const ratio = line.size / size;
    const kind = ratio >= 1.25 ? 'heading' : ratio > 1.05 ? 'label' : 'text';
    const level = ratio >= 2.5 ? 1 : ratio >= 1.6 ? 2 : 3;
    const sameColumn = prev?.column === line.column;
    const gap = sameColumn ? prev.y - (line.y + line.h) : 0;
    let continues = false;
    if (block?.kind === kind && kind === 'heading') continues = sameColumn && gap < line.h;
    if (block?.kind === kind && kind === 'text' && (prev.w >= width * NARROW || /^[a-z]/.test(line.text))) {
      // A paragraph goes on in the next column when that starts unindented.
      continues = sameColumn
        ? line.x <= prev.x + INDENT && gap < prev.h * 0.8
        : line.x <= (left.get(line.column) ?? line.x) + INDENT;
    }
    if (continues) {
      block.lines.push(line.text);
      block.level = Math.min(block.level, level);
    } else {
      block = { kind, level, lines: [line.text] };
      blocks.push(block);
    }
    prev = line;
  }
  return blocks
    .map(({ kind, level, lines: text }) => {
      if (kind === 'heading') return `${'#'.repeat(level)} ${joinLines(text)}`;
      if (kind === 'label') return `**${joinLines(text)}**`;
      return linkRefs(joinLines(text), code);
    })
    .join('\n\n');
}

// GURPS PDFs set × in a symbol font that comes out as ¥.
const clean = (line) => ({ ...line, text: line.text.replace(/¥/g, '×') });

// The whole book: front matter, then each printed page from 1 with its marker.
export function bookMarkdown(book, { code, title, source, offset }) {
  if (!book.pages.some((page) => page.lines.length)) throw new Error('The PDF has no text to read: a scan needs OCR first.');
  offset ??= detectOffset(book.pages);
  if (offset === undefined) throw new Error('No page numbers found in the footers; give --offset.');
  const size = bodySize(book.pages);
  const width = lineWidth(book.pages, size);
  const pages = [];
  for (const page of book.pages) {
    const printed = page.index - offset;
    if (printed < 1) continue;
    const ref = refText(code, printed);
    // Running titles and page numbers are small; a chapter title there stays.
    const kept = page.lines.filter((line) => !inBand(page, line) || line.size >= size * 1.5).map(clean);
    const lines = readingOrder(kept, size);
    pages.push({ ref, text: `<a id="${ref}"></a>**[${ref}]**\n\n${pageMarkdown(lines, size, code, width)}`.trimEnd() });
  }
  if (!pages.length) throw new Error('No printed pages; check --offset.');
  const front = [
    '---',
    `code: ${JSON.stringify(code)}`,
    `title: ${JSON.stringify(title)}`,
    `source: ${JSON.stringify(source)}`,
    `pages: ${JSON.stringify(`${pages[0].ref}-${pages[pages.length - 1].ref}`)}`,
    '---',
  ].join('\n');
  return `${front}\n\n${pages.map((p) => p.text).join('\n\n')}\n`;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { code: { type: 'string' }, out: { type: 'string' }, title: { type: 'string' }, offset: { type: 'string' } },
  });
  const [pdf] = positionals;
  if (!pdf || !values.code || !values.out) {
    console.error('usage: node scripts/book-to-markdown.mjs Book.pdf --code M --out DIR [--title "GURPS Magic"] [--offset N]');
    process.exit(1);
  }
  if (process.platform !== 'darwin') {
    console.error('Reading the PDF needs macOS (scripts/pdf-lines.swift uses PDFKit).');
    process.exit(1);
  }
  const swift = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf-lines.swift');
  // PDFKit logs noise on stderr for every line; only the JSON on stdout matters
  // (about 12 KB a page), or the one error line the script writes before failing.
  let book;
  try {
    book = JSON.parse(execFileSync('swift', [swift, pdf], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    const reason = String(err.stderr || '').split('\n').find((l) => l.startsWith('pdf-lines:')) || err.message;
    console.error(`Could not read ${pdf}: ${reason}`);
    process.exit(1);
  }
  const source = path.basename(pdf);
  const title = values.title || source.replace(/\.pdf$/i, '');
  const offset = values.offset === undefined ? undefined : Number(values.offset);
  if (offset !== undefined && !Number.isInteger(offset)) {
    console.error(`--offset takes a whole number, not ${values.offset}.`);
    process.exit(1);
  }
  const markdown = bookMarkdown(book, { code: values.code.toUpperCase(), title, source, offset });
  await mkdir(values.out, { recursive: true });
  const file = path.join(values.out, `${slug(title)}.md`);
  await writeFile(file, markdown);
  const pages = markdown.match(/^<a id="/gm).length;
  console.log(`${file}: ${pages} pages, offset ${offset ?? detectOffset(book.pages)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
