# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A self-hosted GURPS 4e character builder that runs the Roll20 GURPS character sheet unmodified,
without Roll20, by providing the Roll20 sheet-worker API itself. `README.md` covers running,
Docker, releasing and a per-file overview; `TODO.md` lists known limitations.

## Commands

There is no build step, bundler or linter: the browser loads the ES modules in `public/js/` as-is,
and the server and app have zero runtime dependencies (Node 18+).

```sh
npm start                      # http://localhost:8080 (PORT, HOST env vars)
STORAGE_DIR=./library npm start  # with a shared character library in a local directory
npm install && npm test        # all tests; puppeteer-core drives a local Chrome (CHROME_PATH if not found)
node --test tests/roll20.test.mjs tests/storage.test.mjs tests/drive.test.mjs tests/api.test.mjs tests/mcp.test.mjs tests/sheet-html.test.mjs tests/runtime.test.mjs tests/page-refs.test.mjs tests/book-to-markdown.test.mjs  # no Chrome needed
node --test --test-name-pattern="skill levels" tests/sheet.test.mjs      # one browser test
TEST_URL=http://localhost:8080/ npm test                                 # against an already-running server
make test-docker               # build the image, run it locked down, run the tests against it (what CI runs)
npm run sync                   # replace GURPS/ from ../roll20-character-sheets (or SHEET_SRC=...)
make publish                   # interactive release of the next patch version: tag, wait for CI, GitHub release (needs gh)
make publish VERSION=1.0.0     # a specific version
```

Browser tests in `tests/sheet.test.mjs` are skipped when no Chrome is found. They start the server on
a free port and use a fresh browser context per test. `startServer({ env })` in `tests/helpers.mjs`
passes extra environment, e.g. `STORAGE_DIR`, and `startLibraryServer()` starts one with a library in
a temporary directory. `tests/api.test.mjs` and `tests/library.test.mjs` are skipped under `TEST_URL`.

## Architecture

**The sheet is vendored and never edited.** `GURPS/` is an unmodified copy of upstream's `GURPS`
folder (served at `/sheet/`), plus `LICENSE` and `UPSTREAM.json`. Fix incompatibilities in
`public/js/` or `public/app.css`, not in `GURPS/`. After `npm run sync`, run the tests and commit
`GURPS/` together with the updated `UPSTREAM.json`.

**Load pipeline.** `app.js` calls `loadSheet()` (`sheet-loader.js`), which fetches `gurps.html`,
`gurps.css`, `sheet.json` and translations, cuts the `<script type="text/worker">` block out of the
HTML into a blob URL, and prepares the markup the way Roll20's legacy pipeline does (duplicate
`sheet-` class prefixes, i18n, closing stray `<b>` tags, Pictos/dice icon fonts mapped to Unicode via
`ICON_GLYPHS`, field defaults collected from the HTML, `sheet.json` `useroptions` as new-character
defaults). `SheetView` (`sheet-view.js`) clones that template per character, binds every `attr_*`
element, builds repeating sections, evaluates auto-calc fields with `autocalc.js`, and starts a
Web Worker running `roll20-worker.js`.

**Worker protocol.** `roll20-worker.js` defines Roll20's globals (`on`, `getAttrs`, `setAttrs`,
`getSectionIDs`, `generateRowID`, `startRoll`, a minimal `_`, ...), then `importScripts()` the
sheet's worker code from the blob URL. The worker owns the authoritative attribute store and fires
Roll20-style `change:`/`clicked:`/`sheet:opened` events. Messages:

- page → worker: `init`, `change`, `click`, `addRow`, `removeRow`, `reorder`
- worker → page: `ready`, `update` (batched attribute/row changes), `roll`, `fatal`
- `setActiveCharacter` also reaches the worker's `message` handler, dispatched from inside the
  worker by the sheet's own async helpers; keep handling it.

Changing the protocol means editing both `roll20-worker.js` and `sheet-view.js`. `SheetView` mirrors
updates into its own `attrs`/`sections`; `app.js` saves `view.snapshot()` to IndexedDB (`store.js`)
on a debounce. Characters are `{ id, attrs, sections, ... }`; export/import JSON uses the format tag
`gurps-sheet-server/characters`.

**Rolls produce Roll20 chat commands, not dice results.** The sheet's click handlers call
`startRoll()`; the worker posts a `roll` message and returns a promise that never resolves, so the
sheet never reaches `finishRoll()`. `app.js` then runs the macro through `roll20.js`
(`expandAttributes` → `findQueries`/`askQueries` for `?{prompts}` → `buildRoll`) and `RollPanel`
(`roll-ui.js`) shows the commands to copy. `roll20.js` has no DOM so `tests/roll20.test.mjs`
imports it directly. The output syntax was checked in a real Roll20 game: success rolls are
`/roll {3d6[Label],0d0+99}<N`. The `0d0+F` filler makes Roll20 compare the total (`{3d6}<N` would
check each die) and must never succeed itself, so `buildRoll` uses `F = max(99, N + 1)`. Damage is
`/roll {1d6[Label]+2, {0}}kh1`.

**Shared character library** (optional; `lib/`). With `STORAGE_DIR` or `DRIVE_FOLDER_ID` plus
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`, `server.mjs` loads a `Library`
(`lib/storage.mjs`) over a `DirectoryFolder` or `DriveFolder` (`lib/drive.mjs`, plain `fetch` to the
Drive REST API) and serves it through `lib/api.mjs` at `/api/characters`. It is **append-only on
purpose** (there is no login, so history is the undo): every save creates a new
`<slug>--<timestamp>.json` file, the newest file per character id is current, deletes add a
`--deleted.json` tombstone, and nothing is ever overwritten or removed. Saves carry `baseVersion`;
a stale one gets `ConflictError` / HTTP 409 with the current version. The index lives in memory and
saves are serialized per character, so the server must run as one replica. Drive `properties`
(`characterId`, `savedAt`, `name`, `deleted`) let the index load without reading file contents;
files without them (exports dropped in by hand) are read once. `public/js/characters.js` (export
format, `sanitizeCharacter`, ids, slugs) is shared by the app and the server.

With a library, `app.js` treats IndexedDB as each browser's copy: records also carry `shared`,
`baseVersion` (the library version the copy is based on) and `pending` (changes not uploaded yet).
Uploads go through `public/js/library.js` after 20 s idle, at most every 60 s, and when leaving the
sheet or hiding the tab (keepalive); a 409 asks the player to keep theirs or load the other version,
or, when leaving, waits until the character is opened again. Only player edits (`SheetView`'s
`onEdit`) make a character pending, compared with `contentKey()`: the sheet's own open handlers
rewrite some values (`0` → `"0.000"`), which would otherwise upload a version on every open.
Normal flows must not get a 4xx (Chrome logs each one as a console error, which fails the tests),
hence `GET /api/library` (always 200) and the `deleted` ids in the list.

**MCP server** (`/mcp`, only with a library; with `MCP_TOKEN`, only for clients sending one of its
comma-separated tokens as a Bearer header or as `/mcp/<token>`, compared in constant time). `lib/mcp.mjs` is a hand-written, stateless Streamable
HTTP server (JSON answers, no SSE or sessions; protocol 2025-11-25/06-18/03-26) over the tools in
`lib/mcp-tools.mjs`. Summaries (`lib/character-summary.mjs`) need the field defaults, since
auto-calc fields (e.g. `point_summary`) are stored only as formulas there: `lib/sheet-html.mjs` scans
`GURPS/gurps.html` with a tokenizer that follows the HTML spec (the markup has stray quotes such as
`title=""x"`), and a browser test in `tests/sheet.test.mjs` checks its defaults against `loadSheet()`.
`public/js/attributes.js` (value / default / row-aware lookup / auto-calc) is shared by `SheetView`
and the server. `tests/fixtures/artillery-mage.json` is the sheet's GCS sample imported in the app.

**The sheet in Node** (`lib/sheet-runtime.mjs`, for `roll_command` and the create/edit/import tools).
`lib/sheet-thread.mjs` runs `roll20-worker.js` and the sheet's worker code, both unchanged, in a
`worker_threads` worker inside a `vm` context that mimics a Web Worker scope (`self`, `postMessage`,
`importScripts`, `CustomEvent`/`dispatchEvent` for the sheet's Roll20Async helpers). Messages are the
browser protocol, as JSON so the sheet only sees objects of its own realm. `SheetRuntime` mirrors
updates like `SheetView` and settles when no message arrived for 150 ms and a ping round trip shows
the thread idle. One runs at a time (`withSheet`), with a 96 MB heap cap and a two-minute limit.
`lib/character-edit.mjs` applies edits field by field as player changes (select labels → values,
computed fields refused); `lib/rolls.mjs` maps roll names to the sheet's buttons (`sheet.buttons`) and
reproduces the app's pipeline: action buttons are clicked in the runtime to get the sheet's macro.
Browser tests in `tests/sheet.test.mjs` check that Node and the browser give identical attributes for
the sample character and the GCS import, and the same damage command.

**Books** (`books.js`, `page-refs.js`). Players add PDFs they own; they live in a separate IndexedDB
database, `gurps-books` (settings in `books`, the Blob in `files`), and never go to the server. A book
has a code (`B`), an optional printed page range, and an offset from printed to PDF page.
`page-refs.js` (no DOM, `tests/page-refs.test.mjs`) parses refs like `M23, B243` or `PU2:126` and picks
the PDF. Hovering or focusing a Ref field (`attr_ref`, `attr_race_ref`) shows a popover outside the
sheet with a button per ref, which opens `blob:...#page=N` in a tab named per book. Chrome's PDF viewer
ignores a change of `#page` alone, so each open makes a new blob URL. In tests, close the PDF tab
before closing the browser context, or the close never finishes.

**Rules text** (`scripts/book-to-markdown.mjs`, macOS). `pdf-lines.swift` dumps each PDF line with
its position and font size (PDFKit, run with `swift`); the Node side drops header/footer bands (finding
the page offset from their numbers), orders columns, makes headings from sizes and paragraphs from
indents and line widths, and links "p. N" refs. Output is one Markdown file per PDF with a
`<a id="M23"></a>**[M23]**` marker per printed page. It is copyrighted text: tests use made-up pages,
and output never goes in the repo or image.

**Attribute names.** Stored lowercase. Repeating fields are `repeating_<section>_<rowId>_<field>`;
section names never contain `_`, and row ids start with `-` and contain no `_` (the sheet splits on
`_`). `parseRepeating` exists twice, in `names.js` and inside `roll20-worker.js` (a classic worker
script, so it can't import modules); keep them in sync.

## Constraints

- **Content Security Policy** (`server.mjs`): `script-src 'self' blob:`, no `eval` or inline
  scripts, `connect-src 'self'`. That is why `autocalc.js` parses formulas itself. Images may come
  from anywhere; nothing else may load from other origins.
- **Tests fail on any console error or warning**, including ones from the sheet worker and Chrome's
  own warnings (e.g. a non-number value in `<input type="number">`, which `setInputValue` in
  `sheet-view.js` guards against).
- The same attribute often appears in several elements (and some repeating sections render in
  several places); test helpers in `tests/helpers.mjs` act on the visible copy, and `settle()` waits
  for the worker to go quiet and the save status to read "Saved".
- `public/app.css` gives the sheet Roll20's base styles wrapped in `:where()` (zero specificity) so
  the sheet's own CSS always wins.
- The Docker image copies only `package.json`, `server.mjs`, `lib/`, `public/` and `GURPS/`, and
  `.dockerignore` whitelists the same paths; a new top-level runtime file needs both updated.
- Server code imports DOM-free modules from `public/js/` (`characters.js`, `names.js`,
  `attributes.js`, `autocalc.js`); keep those free of browser globals.
- The `Makefile` must work with GNU Make 3.81 (the macOS default).
