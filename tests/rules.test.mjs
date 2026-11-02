// Unit tests for the rulebooks the MCP server searches (lib/rules.mjs), on
// made-up books in the format of scripts/book-to-markdown.mjs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MarkdownDirectory, parseBook, Rules, rulesFromEnv, words } from '../lib/rules.mjs';
import { projectRoot } from './helpers.mjs';

// A made-up book in the converter's format, also used by tests/mcp.test.mjs.
const TEST_BOOK = await readFile(path.join(projectRoot, 'tests/fixtures/gurps-testing.md'), 'utf8');

const POWER_UPS = `---
code: "PU9"
title: "GURPS Power-Ups 9: Tests"
source: "Power-Ups 9.pdf"
pages: "PU9:5-PU9:5"
---

<a id="PU9:5"></a>**[PU9:5]**

### Teapot Mastery

A perk for those who throw teapots well.
`;

describe('rulebooks', () => {
  let dir;
  let rules;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gurps-rules-'));
    await writeFile(path.join(dir, 'gurps-testing.md'), TEST_BOOK);
    await writeFile(path.join(dir, 'power-ups-9.md'), POWER_UPS);
    await writeFile(path.join(dir, 'notes.txt'), 'not a book');
    rules = new Rules(new MarkdownDirectory(dir));
    await rules.load();
  });

  after(async () => {
    rules?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('reads a book’s front matter and pages', () => {
    const book = parseBook(TEST_BOOK);
    assert.equal(book.code, 'T');
    assert.equal(book.title, 'GURPS Testing');
    assert.deepEqual(book.pages.map((p) => [p.ref, p.page]), [['T1', 1], ['T2', 2], ['T3', 3]]);
    assert.match(book.pages[1].text, /^Cost: 1 to 3/);
    assert.throws(() => parseBook('# no front matter'), /front matter/);
    assert.throws(() => parseBook('---\ntitle: "x"\n---\n'), /book code/);
  });

  test('compares words without case, accents, common words or plurals', () => {
    assert.deepEqual(words('The Flaming Teapots of Öland'), ['flaming', 'teapot', 'oland']);
  });

  test('loads the .md files of the folder', () => {
    assert.deepEqual(rules.books.map((b) => b.code), ['PU9', 'T']);
    assert.equal(rulesFromEnv({}), null);
    assert.ok(rulesFromEnv({ RULES_DIR: dir }) instanceof Rules);
    assert.throws(() => rulesFromEnv({ RULES_FOLDER_ID: 'x' }), /GOOGLE_CLIENT_ID/);
  });

  test('finds sections, the one named for the query first', () => {
    const results = rules.search('flaming teapot');
    assert.deepEqual(results.slice(0, 2).map((r) => `${r.ref} ${r.heading}`), ['T1 Flaming Teapot', 'T2 Flaming Teapot'], 'its text goes on on the next page');
    assert.match(results[0].text, /^\*\*Missile\*\*\n\nThrows a flaming teapot/);
    assert.equal(rules.search('teapot shield')[0].heading, 'Teapot Shield');
    assert.deepEqual(rules.search('teapot', { code: 'PU9' }).map((r) => r.ref), ['PU9:5']);
    assert.equal(rules.search('teapot', { limit: 1 }).length, 1);
    assert.deepEqual(rules.search('the of'), [], 'only common words');
    assert.deepEqual(rules.search('dragon'), []);
  });

  test('shows the paragraphs of a long section that match best', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i} about nothing much at all, going on for a while.`);
    const book = parseBook(`---\ncode: "L"\ntitle: "Long"\n---\n\n<a id="L1"></a>**[L1]**\n\n### Long Section\n\n${[...filler.slice(0, 15), 'The rule about teacups.', ...filler.slice(15)].join('\n\n')}\n`);
    const long = new Rules(null);
    long.build([book]);
    const [result] = long.search('teacups');
    assert.match(result.text, /^…\n\nThe rule about teacups\.\n\nFiller paragraph 15/);
    assert.ok(result.text.length <= 1505);
  });

  test('cuts a long paragraph around its match', () => {
    const long = `${'Words before the match. '.repeat(100)}The teacup rule. ${'Words after it. '.repeat(100)}`;
    const book = parseBook(`---\ncode: "L"\ntitle: "Long"\n---\n\n<a id="L1"></a>**[L1]**\n\n### Long\n\n${long}\n`);
    const one = new Rules(null);
    one.build([book]);
    const { text } = one.search('teacup')[0];
    assert.match(text, /^….*The teacup rule\..*…$/s);
    assert.ok(text.length <= 1500);
  });

  test('leaves out a book whose pages another book has', () => {
    const twice = new Rules(null);
    const copy = { ...parseBook(TEST_BOOK), file: 'copy.md' };
    twice.build([{ ...parseBook(TEST_BOOK), file: 'gurps-testing.md' }, copy]);
    assert.equal(twice.books.length, 1);
    assert.equal(twice.read('T1')[0].book.file, 'gurps-testing.md');
    assert.equal(twice.search('flaming teapot').filter((r) => r.ref === 'T1').length, 1);
  });

  test('tries a file it couldn’t read again, keeping what it had', async () => {
    let fail = false;
    let time = 't1';
    const folder = {
      listFiles: async () => [{ id: 'b', name: 'b.md', modifiedTime: time }],
      readFile: async () => {
        if (fail) throw new Error('Drive is down');
        return TEST_BOOK;
      },
    };
    const flaky = new Rules(folder);
    fail = true;
    await flaky.refresh();
    assert.equal(flaky.books.length, 0);
    fail = false;
    await flaky.refresh();
    assert.equal(flaky.books.length, 1, 'read on the next refresh');
    fail = true;
    time = 't2';
    await flaky.refresh();
    assert.equal(flaky.books.length, 1, 'the book stays while the new version can’t be read');
    fail = false;
    await flaky.refresh();
    assert.equal(flaky.books.length, 1);
    assert.equal(flaky.files.get('b').modifiedTime, 't2');
  });

  test('reads pages by ref', () => {
    const refs = (...args) => rules.read(...args)?.map((p) => p.ref);
    assert.deepEqual(refs('T2'), ['T2']);
    assert.deepEqual(refs('t2'), ['T2']);
    assert.deepEqual(refs('T1-3'), ['T1', 'T2', 'T3']);
    assert.deepEqual(refs('T1-T2'), ['T1', 'T2']);
    assert.deepEqual(refs('T2', 5), ['T2', 'T3'], 'up to the end of the book');
    assert.deepEqual(refs('PU9:5'), ['PU9:5']);
    assert.equal(rules.read('T9'), null);
    assert.equal(rules.read('B1'), null);
    assert.equal(rules.read('hello'), null);
    assert.match(rules.read('T3')[0].text, /^# BREAKAGE/);
  });

  test('picks up books added, changed and removed', async () => {
    const extra = path.join(dir, 'extra.md');
    await writeFile(extra, TEST_BOOK.replace(/"T"/, '"X"').replace(/T(\d)/g, 'X$1'));
    await rules.refresh();
    assert.deepEqual(rules.read('X3')?.map((p) => p.ref), ['X3']);

    await writeFile(extra, TEST_BOOK.replace(/"T"/, '"X"').replace(/T(\d)/g, 'X$1').replace('Broken teapots', 'Shattered teapots'));
    const later = new Date(Date.now() + 5000);
    await utimes(extra, later, later);
    await rules.refresh();
    assert.match(rules.read('X3')[0].text, /Shattered teapots/);

    await unlink(extra);
    await rules.refresh();
    assert.equal(rules.read('X3'), null);
    assert.deepEqual(rules.books.map((b) => b.code), ['PU9', 'T']);
  });
});
