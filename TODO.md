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

## Storage

Characters live in each browser's IndexedDB, which the browser or player can clear.

- [ ] Remind players to back up (for example, show the last export date and nudge after a while).
- [ ] Optional server-side storage, so characters survive cleared browser data and can be shared with the GM.
