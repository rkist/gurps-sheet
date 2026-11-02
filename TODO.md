# TODO

Known limitations of the first version, as work items.

## Dice rolling

Roll buttons give the Roll20 chat command to paste instead of rolling (`public/js/roll20.js`).

- [x] Success rolls work in Roll20: `{3d6[Skill],0d0+99}<N` reports 1 success when the total is N or less (checked in a game on 2026-10-04). The `0d0+99` filler is what makes Roll20 compare the total; `{3d6}<N` checks each die.
- [x] Damage commands work in Roll20, labels included: `/roll {1d6[Swing Damage]+2, {0}}kh1` (checked on 2026-10-04).
- [ ] Optional in-app rolling: resolve `startRoll` in `public/js/roll20-worker.js` and render the sheet's roll templates (`skillRoll`, `columnlayout`, `macro`, `addToTracker`), which `sheet-loader.js` strips from the markup today.

## Icons

Roll20's Pictos and dice fonts are proprietary, so their glyphs are mapped to Unicode symbols (`ICON_GLYPHS` in `public/js/sheet-loader.js`).

- [ ] Replace the Unicode stand-ins with an open SVG icon set.
- [ ] Check the guessed meanings of the Pictos letters `&`, `_`, `~`, `L` and `F` against the sheet on Roll20.

## Fonts and layout

- [ ] Match Roll20's sheet font metrics more closely, or self-host a similar font.
- [ ] Go through every tab for wrapped or overlapping labels, and replace the `white-space: nowrap` patch on `.sheet-stats .sheet-col0` in `public/app.css` with a general fix.

## GCS / GCA import

- [ ] Set the character name after the sheet's built-in import. The importer leaves `character_name` alone because Roll20 keeps the name outside the sheet.

## Books

- [x] Ref fields open the player's own PDFs at the right page (`public/js/books.js`).
- [ ] Find a PDF's offset by itself, from its page labels or the printed page numbers (as
  [gurps_4e_revised_hyperlink](https://github.com/plazman30/gurps_4e_revised_hyperlink) does), instead of asking for one page.
- [ ] Translated editions: the Portuguese Basic Set keeps the English chapter pages but sorts
  advantages, skills and spells by their Portuguese names, so GCS refs to those land on the wrong page.
- [ ] Link the page references in the sheet's own notes and tooltips (e.g. "B8, B494" in the reaction notes).

## Rules

- [x] Turn GURPS PDFs with a text layer into Markdown, a marker per printed page (`scripts/book-to-markdown.mjs`).
- [x] MCP tools to search and read the rules (`search_rules`, `read_rules`), only when `MCP_TOKEN` is set, from a private folder (`lib/rules.mjs`).
- [ ] Scans without text (the Portuguese Basic Set): OCR with macOS Vision. Its faded stat lines (cost, duration) come out garbled.
- [ ] Keep a paragraph whole when a box in the middle of the page cuts it.

## Storage

Characters live in each browser's IndexedDB, which the browser or player can clear.

- [ ] Remind players to back up (for example, show the last export date and nudge after a while).
- [x] Server-side shared library in a Google Drive folder (or a directory), append-only with history (`lib/storage.mjs`, `/api/characters`).
- [x] The app lists, opens and saves characters in the shared library when the server has one.
- [ ] Show a character's history in the app, and restore an old version (the API has it: `/api/characters/:id/versions`).
- [x] An MCP endpoint, so each player's Claude can read characters (`/mcp`, `lib/mcp.mjs`).
- [x] MCP: Roll20 commands for any roll button, and creating, editing and importing characters, by running the sheet worker in Node.
- [ ] MCP: delete characters and restore old versions (both possible through the library; left out until someone needs them).
