// Unit tests for reading the sheet's page references and finding them in the player's PDFs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guessBook, parseRefs, resolveRef } from '../public/js/page-refs.js';

const refs = (text) => parseRefs(text).map(({ code, page }) => `${code} ${page}`);

describe('parseRefs', () => {
  test('reads a book code and page', () => {
    assert.deepEqual(parseRefs('B243'), [{ text: 'B243', code: 'B', page: 243 }]);
    assert.deepEqual(refs('MA45'), ['MA 45']);
  });

  test('reads several references', () => {
    assert.deepEqual(refs('M23, B243'), ['M 23', 'B 243']);
    assert.deepEqual(refs('B66,P119; LT75'), ['B 66', 'P 119', 'LT 75']);
  });

  test('reads codes that end in a digit, with a colon', () => {
    assert.deepEqual(parseRefs('PU2:126'), [{ text: 'PU2:126', code: 'PU2', page: 126 }]);
    assert.deepEqual(refs('B243, PU2:126'), ['B 243', 'PU2 126']);
  });

  test('opens a range at its first page', () => {
    assert.deepEqual(parseRefs('B243-245'), [{ text: 'B243-245', code: 'B', page: 243 }]);
    assert.deepEqual(refs('B243–B245, M20'), ['B 243', 'M 20']);
  });

  test('ignores case, prose and empty fields', () => {
    assert.deepEqual(refs('b243'), ['B 243']);
    assert.deepEqual(refs('see p. B123'), ['B 123']);
    assert.deepEqual(refs(''), []);
    assert.deepEqual(refs(undefined), []);
    assert.deepEqual(refs('Homebrew'), []);
  });
});

describe('resolveRef', () => {
  const characters = { id: 'chars', code: 'B', first: 1, last: 336, offset: 1 };
  const campaigns = { id: 'camps', code: 'B', first: 337, last: 575, offset: -330 };
  const magic = { id: 'magic', code: 'm', first: null, last: null, offset: 2 };

  test('adds the book’s offset to the printed page', () => {
    assert.deepEqual(resolveRef([magic], { code: 'M', page: 23 }), { book: magic, pdfPage: 25 });
  });

  test('picks the PDF whose page range has the page', () => {
    const books = [characters, campaigns, magic];
    assert.equal(resolveRef(books, { code: 'B', page: 66 }).book, characters);
    assert.equal(resolveRef(books, { code: 'B', page: 66 }).pdfPage, 67);
    assert.deepEqual(resolveRef(books, { code: 'B', page: 418 }), { book: campaigns, pdfPage: 88 });
    assert.equal(resolveRef(books, { code: 'B', page: 600 }), null);
  });

  test('prefers a PDF with a range over one without', () => {
    const whole = { id: 'whole', code: 'B', first: null, last: null, offset: 0 };
    assert.equal(resolveRef([whole, campaigns], { code: 'B', page: 400 }).book, campaigns);
    assert.equal(resolveRef([whole, campaigns], { code: 'B', page: 100 }).book, whole);
  });

  test('finds nothing for a code without a PDF', () => {
    assert.equal(resolveRef([magic], { code: 'MA', page: 45 }), null);
    assert.equal(resolveRef([], { code: 'B', page: 1 }), null);
  });

  test('never opens a page before the first', () => {
    const book = { id: 'x', code: 'X', offset: -10 };
    assert.equal(resolveRef([book], { code: 'X', page: 3 }).pdfPage, 1);
  });
});

describe('guessBook', () => {
  test('knows the code and pages of common titles', () => {
    assert.deepEqual(guessBook('GURPS Basic Set - Characters.pdf'), { code: 'B', first: 1, last: 336 });
    assert.deepEqual(guessBook('GURPS_Basic_Set_Campaigns.pdf'), { code: 'B', first: 337, last: 575 });
    assert.deepEqual(guessBook('GURPS_Basic_Set_Fourth_Edition_Revised.pdf'), { code: 'B' });
    assert.deepEqual(guessBook('GURPS 4th - Magic.pdf'), { code: 'M' });
    assert.deepEqual(guessBook('GURPS Martial Arts.pdf'), { code: 'MA' });
    assert.deepEqual(guessBook('GURPS Power-Ups 2 - Perks.pdf'), { code: 'PU2' });
    assert.deepEqual(guessBook('GURPS Powers.pdf'), { code: 'P' });
    assert.deepEqual(guessBook('GURPS Low-Tech.pdf'), { code: 'LT' });
  });

  test('leaves other files to the player', () => {
    assert.deepEqual(guessBook('SJG37-0203.pdf'), {});
  });
});
