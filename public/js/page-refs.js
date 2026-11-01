// GURPS page references as the sheet's Ref fields hold them ("B243",
// "M23, B243", "PU2:126", "B243-245"), and the PDF page each one opens in the
// player's books. No DOM, so tests/page-refs.test.mjs imports it directly.

// A book code right before the page (B243, MA45), or, for codes that end in a
// digit, a colon between them (PU2:126), as GCS writes them. A range opens at
// its first page.
const REF = /(?<![A-Z0-9])(?:([A-Z][A-Z0-9]*):\s?|([A-Z]{1,5}))(\d{1,4})(?:\s?[-–—]\s?(?:[A-Z]{1,5})?\d{1,4})?/gi;

export function parseRefs(text) {
  return [...String(text ?? '').matchAll(REF)].map((m) => ({
    text: m[0].replace(/\s/g, ''),
    code: (m[1] ?? m[2]).toUpperCase(),
    page: Number(m[3]),
  }));
}

const hasRange = (book) => book.first != null || book.last != null;

// The book with a ref's page and the PDF page to open: the printed page plus
// the book's offset. A book with a page range only takes its own pages (the
// Basic Set comes as Characters, B1-B336, and Campaigns, B337-B575); one
// without takes any page of its code, when no book with a range has it.
export function resolveRef(books, { code, page }) {
  let found = null;
  for (const book of books) {
    if (String(book.code || '').toUpperCase() !== code) continue;
    if ((book.first != null && page < book.first) || (book.last != null && page > book.last)) continue;
    if (!found || (hasRange(book) && !hasRange(found))) found = book;
  }
  return found && { book: found, pdfPage: Math.max(1, page + (found.offset || 0)) };
}

// Code and page range for a PDF whose file name has a known title; the player
// can change them.
const KNOWN_BOOKS = [
  [/campaigns/i, { code: 'B', first: 337, last: 575 }],
  [/characters/i, { code: 'B', first: 1, last: 336 }],
  [/basic.?set/i, { code: 'B' }],
  [/martial.?arts/i, { code: 'MA' }],
  [/psionic.?powers/i, { code: 'PSI' }],
  [/power.?ups?\W*(\d+)/i, (m) => ({ code: `PU${m[1]}` })],
  [/powers/i, { code: 'P' }],
  [/thaumatology/i, { code: 'T' }],
  [/low.?tech/i, { code: 'LT' }],
  [/high.?tech/i, { code: 'HT' }],
  [/ultra.?tech/i, { code: 'UT' }],
  [/bio.?tech/i, { code: 'BT' }],
  [/horror/i, { code: 'H' }],
  [/supers/i, { code: 'SU' }],
  [/magic/i, { code: 'M' }],
];

export function guessBook(fileName) {
  for (const [pattern, book] of KNOWN_BOOKS) {
    const m = String(fileName).match(pattern);
    if (m) return typeof book === 'function' ? book(m) : { ...book };
  }
  return {};
}
