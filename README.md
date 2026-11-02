# GURPS Sheet

A self-hosted GURPS 4th Edition character builder for a gaming group. It runs the
[Roll20 GURPS character sheet](https://github.com/Roll20/roll20-character-sheets/tree/master/GURPS)
unmodified, without the rest of Roll20.

- Characters are saved in each player's browser (IndexedDB). Optionally the server keeps a
  [shared character library](#shared-character-library) in a Google Drive folder, so the whole group
  sees the same characters, and every save is kept as a version. With the library, the server is
  also an [MCP server](#claude-mcp), so each player's Claude can read the characters.
- **Export** / **Import** move characters between browsers or devices as JSON. **Export all** makes a backup.
- All of the sheet's own logic runs: derived stats, skill and spell levels, point totals, and the
  built-in GCA/GCS importers (gear tab → Import).
- Translations come from the sheet. The language picker lists the languages that are actually translated.
- Roll buttons don't roll dice. They give you the Roll20 chat command, with the sheet's numbers and
  modifiers filled in, and copy it to paste into your Roll20 game: Broadsword-11 at -2 becomes
  `/roll {3d6[Broadsword],0d0+99}<9`. The `0d0+99` makes Roll20 compare the total, so it shows
  "1 success" on 9 or less.
- **Books**: each player can add the GURPS PDFs they own, which stay in their browser and are never
  uploaded. A Ref on the sheet, like `B243` or `M23, PU2:126`, then opens its page in a new tab.

Known limitations and planned work are in [TODO.md](TODO.md).

## Run it

Requires Node 18 or newer. Running the app needs no dependencies.

```sh
npm start        # http://localhost:8080
```

`PORT` and `HOST` environment variables change where it listens. The server has no login, so put it
behind a reverse proxy or a VPN (e.g. Tailscale) if it shouldn't be public. Without the shared
library, characters live in the browsers and there is no shared data on the server, but anyone who
can reach it can use it.

`make` lists shortcuts for the commands in this README.

## Run it with Docker

```sh
docker compose up -d     # or `make up`; http://localhost:8080
```

This builds the image from the checkout. After a `git pull`, run the same command again to rebuild.
`GURPS_PORT=3000 docker compose up -d` (or `GURPS_PORT` in a `.env` file) changes the port.

There are no volumes: characters live in the players' browsers, or in Google Drive with the shared
library, so the container has nothing to back up. It runs as a non-root user on a read-only filesystem with no Linux capabilities, has a health
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

## Shared character library

With a library configured, the server keeps the group's characters in one place and serves them at
`/api/characters`. A save never overwrites anything: it adds a file named after the character and the
time, such as `sir-testalot--2026-10-31T21-04-05-123Z.json`. The newest file of a character is its
current version and the older files are its history. Deleting adds a `...--deleted.json` file. Each
file is a normal export, so any version can be downloaded and imported by hand, and exports dropped
into the folder (one character per file) show up too.

The app then lists the library's characters, and new and imported characters go to it. Each browser
still saves a copy of the characters it opens, and sends changes to the library once editing pauses
for 20 seconds, at least every minute while it goes on, and when you leave the sheet or switch tabs.
The bar shows whether the open character is in the library. If someone else (another player, or
Claude) saved it in the meantime, the app asks whether to keep your version or load theirs; either
way, the other one stays in the history. Characters saved in a browser before the server had a
library show as "only in this browser", with a button to upload them.

There is no login: anyone who can reach the server can read and change every character in the
library. Because nothing is overwritten, every change can be undone from the history. Requests are
capped at 1 MB and the server takes at most 60 saves a minute. Run a single instance, since it checks
for conflicting saves in memory.

| API | |
| --- | --- |
| `GET /api/library` | `{ enabled, ready }`: whether the server has a library. Always 200, so the app can check without an error. |
| `GET /api/characters` | The current version of every character, and the ids of deleted ones |
| `GET /api/characters/:id` | `{ version, savedAt, character }` |
| `GET /api/characters/:id/versions` | The history, newest first; `/versions/:version` gets one |
| `POST /api/characters/:id` | `{ character, baseVersion }` saves a new version. If `baseVersion` isn't the current version any more, nothing is saved and the answer is 409 with the current one. |
| `DELETE /api/characters/:id` | `{ baseVersion }` marks the character deleted |

To try it locally, keep the library in a directory:

```sh
STORAGE_DIR=./library npm start
```

### Google Drive

The server signs in to Drive as a Google account that can edit the folder, with an OAuth refresh
token. (A service account can't create files in a personal Drive folder.) One-time setup:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the
   **Google Drive API** for it.
2. Under **Google Auth Platform**, set up the consent screen with audience **External**, add the
   scope `https://www.googleapis.com/auth/drive`, and **publish** the app so its status is **In
   production**. In "Testing", refresh tokens stop working after 7 days. The app doesn't need
   Google's verification; the sign-in page warns that it is unverified, and you continue anyway.
3. Create an OAuth client of type **Desktop app** and note its client ID and secret. "Desktop" is
   only about the one-time sign-in in the next step, which runs on your computer; after that the
   server saves the files itself.
4. Download the client's JSON file. On a computer with a browser, run the script below, open the
   link it prints, sign in as the account that can edit the folder and allow access. It checks that
   the account can add files to the folder and writes the server's four settings to the env file
   (without `--save-to` it prints them). The folder ID is the last part of the folder's URL.

   ```sh
   DRIVE_FOLDER_ID=... node scripts/drive-auth.mjs client_secret_....json --save-to .env.library
   ```

5. Start the server with `DRIVE_FOLDER_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `GOOGLE_REFRESH_TOKEN`, e.g. `node --env-file=.env.library server.mjs` (Node 20.6+). It serves
   the app right away and loads the library in the background, retrying if Drive can't be reached;
   `/api/` answers 503 until then.

## Claude (MCP)

With a library, the server is also a remote [MCP](https://modelcontextprotocol.io) server at `/mcp`, so
anyone in the group can ask their Claude about the characters, have it build or change them, and get
the Roll20 commands for their rolls. It uses the same library as the app:

| Tool | |
| --- | --- |
| `list_characters` | The characters in the library |
| `get_character` | A summary with the levels the sheet computes: points, attributes, traits, skills, techniques, spells, attacks, defenses, equipment. `detail: "attributes"` gives the raw sheet attributes. |
| `get_character_history`, `get_character_version` | Every saved version, and any one of them |
| `sheet_fields` | The sheet's fields: names, types, choices and defaults |
| `roll_command` | The Roll20 chat command for a skill, spell, attack, damage, defense, attribute or check, exactly as the app's roll buttons give it |
| `create_character`, `edit_character` | Create a character, or change one (set attribute points, add, change or remove skills, traits, spells, equipment...) |
| `import_character` | Create a character from a GCS or GCA export, with the sheet's own importer |
| `search_rules`, `read_rules` | With [rulebooks](#rulebooks): search the books' text, and read pages by ref (`B243`, `M23-24`) |

Edits and imports run the sheet itself in Node, as if a player typed them in: Claude sets what a player
sets, and the sheet computes levels, point totals and derived values. Each one is saved as a new version,
so the history keeps what was there before. One sheet runs at a time, for up to two minutes; with four
requests waiting, or 60 run in the last minute, others are turned away until it has caught up.

Add it in Claude Code with `claude mcp add --transport http gurps https://gurps.example.com/mcp`, or
in claude.ai under Settings → Connectors → Add custom connector. It answers only POST requests with
JSON (no event stream or sessions), and refuses requests from web pages (those carry an `Origin`
header, which MCP clients like Claude don't send).

### Rulebooks

The MCP server can also hold the text of the group's rulebooks, so Claude answers rules questions from
the books and gives the pages (`B243`), which the app opens from a sheet's Ref field. Turn each PDF into
Markdown with the [converter](#rules-text), then put the `.md` files in a folder the server reads:

- `RULES_FOLDER_ID`: a Google Drive folder, read with the library's Google credentials
  (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`). Share it with the account the
  server signs in as.
- `RULES_DIR`: a directory, e.g. for development. Not inside `public/` or `GURPS/`, which anyone can
  download: the server refuses to start then.

The server reads the folder again every 10 minutes, so new books show up without a restart. A file whose pages another file already has (the same book twice, or the Basic Set whole and split) is left out, with a message in the log. The text
is the books' own, so it is only loaded with an [`MCP_TOKEN`](#token): without one the server logs that
and leaves the rules out. With rules and no character library, `/mcp` has just the two rules tools.
`search_rules` ranks sections (a heading and the text under it) by the words of the question, the one
named like the question first; `read_rules` gives up to five pages, or a range like `B243-245`.

### Token

Like the app, `/mcp` is open to anyone who can reach it, unless `MCP_TOKEN` is set. Then only clients
with the token get in, so share it with the group only. Make one with
`node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"`; it takes letters, digits, `-`
and `_`, at least 16. Several tokens separated by commas also work, e.g. one per player, so one can be
taken back without changing the others'. Clients send it either way:

- at the end of the URL, for claude.ai, whose connectors only take a URL:
  `https://gurps.example.com/mcp/<token>`
- as a header, in Claude Code:
  `claude mcp add --transport http gurps https://gurps.example.com/mcp --header "Authorization: Bearer <token>"`

The token covers only `/mcp`: the app and its `/api/` stay open, as before.

### Moving to a new address

Browsers keep saved data per address (scheme, host and port). If the app moves, for example from
`http://localhost:8080` to `https://gurps.example.com`, players see an empty character list at the new
address. Have everyone use **Export all** at the old address and **Import** at the new one.

## Books

**Books** in the top bar takes the GURPS PDFs you own. For each one, set:

- its **book code**, the letters a Ref starts with: `B` for the Basic Set, `M` for Magic, `MA` for
  Martial Arts, `PU2` for Power-Ups 2... Known titles are filled in from the file name.
- a **printed page** and the **PDF page** it is on, since covers and front matter shift the
  numbering. **Open** shows that page, to check.
- a **first and last page** only for a book that comes in several PDFs, like the Basic Set's
  Characters (1–336) and Campaigns (337–575).

Hovering or clicking a Ref field then shows a button per reference (the down arrow reaches them from
the keyboard), which opens the PDF at that page in Chrome's PDF viewer (one tab per book). The PDFs are kept in the browser's IndexedDB, apart from the
characters, and never reach the server or the group library.

Refs follow the English books' page numbers, as GCS writes them. Translations may differ: the
Portuguese Basic Set keeps the chapters on the same pages but sorts advantages, skills and spells by
their Portuguese names, so those land on the wrong page.

### Rules text

`scripts/book-to-markdown.mjs` turns a GURPS PDF with a text layer into Markdown, so Claude can look
rules up: one file per PDF, every printed page starting with a marker in the sheet's Ref format
(`<a id="M23"></a>**[M23]**`), headings from the font sizes, paragraphs put back together across
lines and columns, and page references like "p. 14" or "p. B184" turned into links to those markers.
It reads the PDF with macOS's PDFKit (`scripts/pdf-lines.swift`), so it runs on a Mac with nothing to
install:

```sh
node scripts/book-to-markdown.mjs "GURPS Magic.pdf" --code M --title "GURPS Magic" --out ~/rules
```

The printed page numbers are found in the footers; `--offset` (PDF page index from 0, minus the
printed page) sets them by hand. A scan without a text layer is refused: it needs OCR first. Tables come out one row
per line, and a box in the middle of a page may cut the paragraph around it in two.

The Markdown is the book's text: keep it private. Never add it to this repository or the image, both
of which are public (`rules/` is in `.gitignore` in case it lands here).

## Repository layout

| Path | What it is |
| --- | --- |
| `GURPS/` | Unmodified copy of the `GURPS` folder from [Roll20/roll20-character-sheets](https://github.com/Roll20/roll20-character-sheets). Two files are added: `LICENSE` (Roll20's MIT license) and `UPSTREAM.json` (the upstream commit and sheet version it was copied from). Served at `/sheet/`. |
| `public/` | The app: `index.html`, `app.css` and the JavaScript in `public/js/`. |
| `server.mjs` | Dependency-free server: static files with gzip and a strict Content Security Policy, plus the library API and the MCP server when a library is configured. |
| `lib/` | The shared character library: `storage.mjs` (versions and history), `drive.mjs` (Google Drive), `api.mjs` (HTTP API). The MCP server: `mcp.mjs` (protocol), `mcp-tools.mjs` (tools), `rules.mjs` (the rulebooks' text and its search), `character-summary.mjs`, `character-edit.mjs`, `rolls.mjs`, `sheet-html.mjs` (reads the sheet's fields, buttons and defaults from `GURPS/` without a browser), and `sheet-runtime.mjs` / `sheet-thread.mjs`, which run the sheet in Node. |
| `scripts/` | `sync-sheet.mjs` replaces `GURPS/` with a fresh copy from an upstream checkout. `drive-auth.mjs` gets the Google Drive refresh token. `book-to-markdown.mjs` and `pdf-lines.swift` turn a PDF into rules Markdown. `test-docker.sh` and `publish.sh` back `make test-docker` and `make publish`. |
| `Makefile` | Shortcuts for the common commands. `make` lists them. |
| `tests/` | End-to-end tests that drive the app in headless Chrome, and unit tests of the server parts. `fixtures/` has a character made with the sheet's GCS importer. |
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

`TEST_URL=http://localhost:8080/ npm test` runs them against a server that is already running instead
(the library API, MCP and library browser tests need a server of their own, so they are skipped then).
`make test-docker` builds the image, starts it locked down like `compose.yaml` and runs the tests
against it. CI does the same for every pull request.

Unit tests cover the PDF-to-Markdown converter (on made-up pages), the rulebook search (on a made-up book), the shared library (on a directory, and against a fake Drive API), its HTTP API, the
MCP server, the server's reading of the sheet markup, and the sheet running in Node (browser tests check
that both match the app: the same field defaults, the same character from the same edits or GCS import,
and the same roll commands). Browser tests run the app with a library as two players (sharing,
conflicts, uploading, deleting).
The browser tests cover the sheet's own calculations (derived stats, skill levels, point totals), tab switching,
repeating rows (add, reorder, delete), saving across reloads, export/import, language switching, the
sheet's built-in GCS importer, the Roll20 commands of the roll buttons, and opening a Ref's page in a PDF. Every test also fails on any console error or
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
| `public/js/autocalc.js`, `public/js/attributes.js` | Evaluate Roll20 auto-calc formulas such as `round(2 * @{basic_lift})` without `eval`, and read attributes the way the sheet shows them (stored value, else the field default; `@{field}` in a row means that row's field). Shared with the server. |
| `public/js/roll20.js`, `public/js/roll-ui.js` | Turn a roll button's macro into Roll20 chat commands: fill in `@{attributes}`, ask its `?{prompts}`, work out the target number, and list the commands to copy. |
| `public/js/app.js`, `public/js/store.js`, `public/js/library.js` | Character list, saving, import/export, language, and syncing with the shared library. |
| `public/js/books.js`, `public/js/page-refs.js` | The player's PDFs (the Books dialog), reading page references like `M23, B243`, and opening them at the right page. |
| `public/js/characters.js` | The export format and the clean-up of characters from files or the network, shared with the server. |
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
