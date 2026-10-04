# GURPS Sheet

A self-hosted GURPS 4th Edition character builder for a gaming group. It runs the
[Roll20 GURPS character sheet](https://github.com/Roll20/roll20-character-sheets/tree/master/GURPS)
unmodified, without the rest of Roll20.

- Characters are saved in each player's browser (IndexedDB). The server only serves files.
- **Export** / **Import** move characters between browsers or devices as JSON. **Export all** makes a backup.
- All of the sheet's own logic runs: derived stats, skill and spell levels, point totals, and the
  built-in GCA/GCS importers (gear tab → Import).
- Translations come from the sheet. The language picker lists the languages that are actually translated.

Known limitations and planned work are in [TODO.md](TODO.md). The main one: no dice rolling yet.

## Run it

Requires Node 18 or newer. Running the app needs no dependencies.

```sh
npm start        # http://localhost:8080
```

`PORT` and `HOST` environment variables change where it listens. The server has no login, so put it
behind a reverse proxy or a VPN (e.g. Tailscale) if it shouldn't be public. Characters live in the
browsers, so there is no shared data on the server, but anyone who can reach it can use it.

## Repository layout

| Path | What it is |
| --- | --- |
| `GURPS/` | Unmodified copy of the `GURPS` folder from [Roll20/roll20-character-sheets](https://github.com/Roll20/roll20-character-sheets). Two files are added: `LICENSE` (Roll20's MIT license) and `UPSTREAM.json` (the upstream commit and sheet version it was copied from). Served at `/sheet/`. |
| `public/` | The app: `index.html`, `app.css` and the JavaScript in `public/js/`. |
| `server.mjs` | Dependency-free static server with gzip and a strict Content Security Policy. |
| `scripts/sync-sheet.mjs` | Replaces `GURPS/` with a fresh copy from an upstream checkout. |
| `tests/` | End-to-end tests that drive the app in headless Chrome. |
| `TODO.md` | Known limitations and planned work. |

### Updating the sheet

Don't edit `GURPS/` by hand. Pull upstream and copy it over:

```sh
git -C ../roll20-character-sheets pull
npm run sync     # copies ../roll20-character-sheets/GURPS into GURPS/
```

Set `SHEET_SRC=/path/to/roll20-character-sheets/GURPS` if the checkout is somewhere else. Run the
tests, then commit the result together with the updated `GURPS/UPSTREAM.json`.

## Tests

The tests start the server on a free port and drive the real sheet in headless Chrome with
[puppeteer-core](https://pptr.dev). They need Chrome or Chromium installed; set `CHROME_PATH` if it
isn't in a standard location.

```sh
npm install      # dev dependency: puppeteer-core
npm test
```

They cover the sheet's own calculations (derived stats, skill levels, point totals), tab switching,
repeating rows (add, reorder, delete), saving across reloads, export/import, language switching, the
sheet's built-in GCS importer, and the dice notice. Every test also fails on any console error or
warning, including ones from the sheet worker.

## How it works

Roll20 sheets are an HTML fragment plus a "sheet worker" script that only talks to Roll20 through a
handful of functions (`on`, `getAttrs`, `setAttrs`, `getSectionIDs`, ...). This project provides those
functions, so the sheet's code runs as-is.

| File | Role |
| --- | --- |
| `public/js/roll20-worker.js` | Stand-in for Roll20's sheet-worker runtime. Runs in a Web Worker, owns the attribute store, implements the Roll20 API and event behaviour, then loads the sheet's worker code with `importScripts()`. |
| `public/js/sheet-loader.js` | Loads `gurps.html` / `gurps.css`, splits out the worker code, and prepares the markup the way Roll20's legacy pipeline does: `sheet-` class prefixes, translations, field defaults and icon-font stand-ins. It also closes a few unclosed `<b>` tags that would otherwise make inactive tabs show. |
| `public/js/sheet-view.js` | Mounts the sheet for one character, binds every `attr_*` field, builds repeating sections (add, modify, delete, drag to reorder), computes auto-calculated fields, and passes edits and button clicks to the worker. |
| `public/js/autocalc.js` | Evaluates Roll20 auto-calc formulas such as `round(2 * @{basic_lift})` without `eval`. |
| `public/js/app.js`, `public/js/store.js` | Character list, saving, import/export and language. |
| `public/app.css` | App chrome, plus the base styles Roll20 gives every sheet (zero specificity, so the sheet's CSS wins). |

## License

The code in this repository is MIT licensed (see [LICENSE](LICENSE)), except `GURPS/`, which keeps its
own license below.

## Credits

The character sheet in `GURPS/` is by Ken Foubert, Mike Wilson, SᵃᵛᵃGᵉ, Tame Flame and contributors,
MIT licensed by Roll20 (see `GURPS/LICENSE`).

GURPS is a trademark of Steve Jackson Games, and its rules and art are copyrighted by Steve Jackson
Games. All rights are reserved by Steve Jackson Games. This game aid is released for free
distribution, and not for resale, under the permissions granted in the Steve Jackson Games Online
Policy.
