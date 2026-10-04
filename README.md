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

`make` lists shortcuts for the commands in this README.

## Run it with Docker

```sh
docker compose up -d     # or `make up`; http://localhost:8080
```

This builds the image from the checkout. After a `git pull`, run the same command again to rebuild.
`GURPS_PORT=3000 docker compose up -d` (or `GURPS_PORT` in a `.env` file) changes the port.

There are no volumes: characters live in the players' browsers, so the container has nothing to back
up. It runs as a non-root user on a read-only filesystem with no Linux capabilities, has a health
check, and stops right away on `docker compose down`.

### Prebuilt image

Each push to `main` publishes `ghcr.io/rkist/gurps-sheet` for amd64 and arm64, tagged `latest` and
`sha-<commit>`. Releases add version tags such as `0.2.1` and `0.2`. `latest` is also rebuilt every
week to pick up security fixes in the Node base image.

```sh
docker run -d --name gurps-sheet --restart unless-stopped -p 8080:8080 ghcr.io/rkist/gurps-sheet
```

To use it from Compose instead of building, replace the `build`, `image` and `pull_policy` lines in
`compose.yaml` with `image: ghcr.io/rkist/gurps-sheet`. Update with
`docker compose pull && docker compose up -d`.

### Releasing

```sh
make publish                  # the next patch version, e.g. v0.2.0 -> v0.2.1
make publish VERSION=1.0.0
```

It shows the version and the `main` commit it will release and asks to confirm. Then it pushes the
tag, waits while CI tests the image and publishes it as `1.0.0` and `1.0`, and creates the GitHub
release with generated notes. If CI fails, nothing is published and no release is created. The first
release uses the version in `package.json`. Needs the [GitHub CLI](https://cli.github.com), logged in.

### Moving to a new address

Browsers keep saved data per address (scheme, host and port). If the app moves, for example from
`http://localhost:8080` to `https://gurps.example.com`, players see an empty character list at the new
address. Have everyone use **Export all** at the old address and **Import** at the new one.

## Repository layout

| Path | What it is |
| --- | --- |
| `GURPS/` | Unmodified copy of the `GURPS` folder from [Roll20/roll20-character-sheets](https://github.com/Roll20/roll20-character-sheets). Two files are added: `LICENSE` (Roll20's MIT license) and `UPSTREAM.json` (the upstream commit and sheet version it was copied from). Served at `/sheet/`. |
| `public/` | The app: `index.html`, `app.css` and the JavaScript in `public/js/`. |
| `server.mjs` | Dependency-free static server with gzip and a strict Content Security Policy. |
| `scripts/` | `sync-sheet.mjs` replaces `GURPS/` with a fresh copy from an upstream checkout. `test-docker.sh` and `publish.sh` back `make test-docker` and `make publish`. |
| `Makefile` | Shortcuts for the common commands. `make` lists them. |
| `tests/` | End-to-end tests that drive the app in headless Chrome. |
| `Dockerfile`, `compose.yaml` | The container image, and a Compose file that builds and runs it. |
| `.github/` | CI that builds the image, runs the tests against it and publishes it to GHCR, plus Dependabot for the base image and actions. |
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

`TEST_URL=http://localhost:8080/ npm test` runs them against a server that is already running instead.
`make test-docker` builds the image, starts it locked down like `compose.yaml` and runs the tests
against it. CI does the same for every pull request.

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
