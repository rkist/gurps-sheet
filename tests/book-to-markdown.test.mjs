// Unit tests for turning a PDF's lines (from scripts/pdf-lines.swift) into rules
// Markdown. Made-up pages only: no book text belongs in this repository.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bodySize,
  bookMarkdown,
  detectOffset,
  joinLines,
  lineWidth,
  linkRefs,
  pageMarkdown,
  readingOrder,
  refText,
} from '../scripts/book-to-markdown.mjs';

// A line as pdf-lines.swift gives it: y from the bottom of a 792-point page.
const line = (x, y, text, { size = 9, w = 146, h = 9.4 } = {}) => ({ x, y, w, h, size, text });
// A paragraph's lines in one column, 11 points apart, the first indented.
const paragraph = (x, top, texts) => texts.map((t, i) => line(i ? x : x + 12, top - 11 * i, t, { w: i ? 146 : 134 }));
const page = (index, lines) => ({ index, width: 612, height: 792, lines });
const footer = (n) => line(272, 18, `SOME CHAPTER ${n}`, { size: 12, w: 295, h: 16 });

describe('book-to-markdown', () => {
  test('writes refs as the sheet does', () => {
    assert.equal(refText('M', 23), 'M23');
    assert.equal(refText('PU2', 12), 'PU2:12');
  });

  test('finds the body text size, line width and page numbering', () => {
    const pages = [2, 3, 4].map((i) => page(i, [footer(i - 1), line(77, 600, 'Plenty of body text on this page.')]));
    assert.equal(bodySize(pages), 9);
    assert.equal(lineWidth(pages, 9), 145);
    assert.equal(detectOffset(pages), 1);
    assert.equal(detectOffset([page(0, [line(77, 600, 'No footer here, 42.')])]), undefined);
    // Footer page numbers win over a chapter's own page numbers in the header.
    const headed = [2, 3, 4].map((i) => page(i, [footer(i - 1), line(272, 760, `CHAPTER PAGE ${i + 5}`, { size: 12, h: 16 })]));
    assert.equal(detectOffset(headed), 1);
    // Footers that disagree as often as they agree.
    const mixed = [2, 3, 4, 5].map((i) => page(i, [footer(i % 2 ? i - 1 : i + 9)]));
    assert.throws(() => detectOffset(mixed), /give --offset/);
  });

  const order = (lines) => readingOrder(lines, 9).map((l) => `${l.column} ${l.text}`);

  test('reads columns left to right, each top to bottom', () => {
    const lines = [
      ...paragraph(241, 600, ['Second column.', 'still second', 'and more', 'and the end']),
      ...paragraph(77, 600, ['First column.', 'still first', 'and more', 'and the end']),
      line(170, 700, 'A centered title', { size: 30, w: 280 }),
      line(141, 572, '– a quote’s author', { w: 60 }),
    ];
    assert.deepEqual(order(lines), [
      '0 A centered title',
      '0 First column.',
      '0 still first',
      '0 and more',
      '0 – a quote’s author',
      '0 and the end',
      '1 Second column.',
      '1 still second',
      '1 and more',
      '1 and the end',
    ]);
  });

  test('keeps an inset box in its column, and finds a column of one line', () => {
    const lines = [
      ...paragraph(77, 600, ['Above the box', 'and more']),
      line(135, 570, 'Inset box line one', { w: 80 }),
      line(135, 559, 'inset box line two', { w: 80 }),
      ...paragraph(77, 540, ['Below the box', 'and more']),
      line(241, 600, 'The last line, in the next column.'),
      line(20, 300, 'A heading out in the margin', { size: 13, w: 50 }),
    ];
    assert.deepEqual(order(lines), [
      '0 Above the box',
      '0 and more',
      '0 Inset box line one',
      '0 inset box line two',
      '0 Below the box',
      '0 and more',
      '0 A heading out in the margin',
      '1 The last line, in the next column.',
    ]);
  });

  test('joins lines, putting split words back together', () => {
    assert.equal(joinLines(['The whirl-', 'wind spun', 'away.']), 'The whirlwind spun away.');
    assert.equal(joinLines(['Earth-', 'Normal stays']), 'Earth- Normal stays');
  });

  test('links references to this book’s pages', () => {
    assert.equal(linkRefs('Use the modifiers (p. 14).', 'M'), 'Use the modifiers ([p. 14](#M14)).');
    assert.equal(linkRefs('See pp. 21-22.', 'M'), 'See [pp. 21-22](#M21).');
    assert.equal(linkRefs('Perks (p. PU3:12)', 'PU2'), 'Perks (p. PU3:12)', 'another book’s ref names it already');
    assert.equal(linkRefs('A cloak (see Cloak, p. B184).', 'M'), 'A cloak (see Cloak, p. B184).');
    assert.equal(linkRefs('A trait (p. 12)', 'PU2'), 'A trait ([p. 12](#PU2:12))');
    assert.equal(linkRefs('Sp. 5 and top. 3 stay', 'M'), 'Sp. 5 and top. 3 stay');
    assert.equal(linkRefs('Not a page: p. 12345', 'M'), 'Not a page: p. 12345');
  });

  test('makes headings, labels and paragraphs', () => {
    const lines = readingOrder(
      [
        line(222, 733, 'CHAPTER ONE', { size: 18, h: 24 }),
        line(170, 671, 'SPELLS', { size: 43, h: 60 }),
        line(76, 620, 'Some Spell', { size: 13, w: 60, h: 14 }),
        line(202, 606, 'Area', { size: 10, w: 21, h: 11 }),
        ...paragraph(77, 590, ['It does a thing in its area of ef-', 'fect for a while; see p. 14 for', 'more.']),
        ...paragraph(77, 550, ['Duration: 1 minute.']),
        line(89, 530, 'Cost', { w: 60 }),
        line(89, 519, '1 70', { w: 60 }),
        line(89, 508, '2 165', { w: 60 }),
      ],
      9,
    );
    assert.equal(
      pageMarkdown(lines, 9, 'M', 146),
      [
        '# CHAPTER ONE SPELLS',
        '### Some Spell',
        '**Area**',
        'It does a thing in its area of effect for a while; see [p. 14](#M14) for more.',
        'Duration: 1 minute.',
        'Cost',
        '1 70',
        '2 165',
      ].join('\n\n'),
    );
  });

  test('keeps a paragraph going in the next column, and around a picture', () => {
    const lines = readingOrder(
      [
        ...paragraph(77, 600, ['A paragraph that runs', 'to the bottom of the column', 'and goes on']),
        line(241, 600, 'in the next column.'),
        line(241, 589, 'And this is not'),
        line(241, 578, 'part of it.'),
        line(253, 560, 'Text around a', { w: 60 }),
        line(241, 549, 'picture keeps', { w: 60 }),
        line(241, 538, 'going.', { w: 30 }),
        line(253, 520, 'Next one.'),
      ],
      9,
    );
    assert.deepEqual(pageMarkdown(lines, 9, 'M', 146).split('\n\n'), [
      'A paragraph that runs to the bottom of the column and goes on in the next column. And this is not part of it.',
      'Text around a picture keeps going.',
      'Next one.',
    ]);
  });

  test('writes the book with front matter and a marker per printed page', () => {
    const pages = [
      page(0, [line(200, 400, 'Cover', { size: 40 })]),
      page(1, [footer(1), line(170, 760, 'BIG TITLE', { size: 30, h: 40 }), ...paragraph(77, 600, ['Page one, $10¥P.'])]),
      page(2, [footer(2), ...paragraph(77, 600, ['Page two.'])]),
    ];
    const markdown = bookMarkdown({ title: 'x.qxd', pages }, { code: 'M', title: 'GURPS Test', source: 'Test.pdf' });
    assert.equal(
      markdown,
      [
        '---',
        'code: "M"',
        'title: "GURPS Test"',
        'source: "Test.pdf"',
        'pages: "M1-M2"',
        '---',
        '',
        '<a id="M1"></a>**[M1]**',
        '',
        '# BIG TITLE',
        '',
        'Page one, $10×P.',
        '',
        '<a id="M2"></a>**[M2]**',
        '',
        'Page two.',
        '',
      ].join('\n'),
      'the cover is skipped, the footers are dropped, the title in the top band stays',
    );
    assert.match(bookMarkdown({ pages }, { code: 'M', title: 'T', source: 'T.pdf', offset: 0 }), /pages: "M1-M2"/);
    assert.throws(() => bookMarkdown({ pages: [page(0, [])] }, { code: 'M', title: 'T', source: 'T.pdf' }), /no text to read/);
    const unnumbered = [page(0, [line(77, 600, 'Text but no page numbers.')])];
    assert.throws(() => bookMarkdown({ pages: unnumbered }, { code: 'M', title: 'T', source: 'T.pdf' }), /give --offset/);
  });
});
