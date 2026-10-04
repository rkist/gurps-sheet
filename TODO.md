# TODO

Known limitations of the first version, as work items.

## Dice rolling

Roll buttons show a "not available yet" notice instead of rolling.

- [ ] Implement `startRoll` / `finishRoll` in `public/js/roll20-worker.js` (today `startRoll` never resolves).
- [ ] Parse Roll20 inline rolls (`[[3d6]]`, `[[1d6+2]]`, ...) and `?{Prompt|default}` queries.
- [ ] Resolve `@{attribute}` references in roll text, including row-relative ones in repeating sections.
- [ ] Handle `type="roll"` buttons (macro in `value`) as well as the sheet's `startRoll`-based action buttons.
- [ ] Render the sheet's roll templates (`skillRoll`, `columnlayout`, `macro`, `addToTracker`) in a roll log. `sheet-loader.js` strips them from the markup today.
- [ ] Decide whether the roll log is per browser or shared with the group (shared needs server-side state).

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
