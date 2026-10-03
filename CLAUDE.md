# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A vacation planner: a draggable hour grid per trip, served by a single Go binary (standard library only, no third-party modules). The page in `web/` uses native ES modules with no bundler and no build step. There is no database: each trip is a JSON file on disk. The README, code comments, server error messages, test names and UI strings are in **European Portuguese**. Keep new comments and messages in Portuguese, and add any user-facing text in both languages (see i18n below).

## Commands

```sh
# Run locally (DATA_DIR defaults to ./data, which is gitignored). The password must be at least 10 characters.
PLANNER_USER=eu PLANNER_PASSWORD=uma-palavra-passe go run .
# PowerShell: $env:PLANNER_USER='eu'; $env:PLANNER_PASSWORD='uma-palavra-passe'; go run .

go test ./...                          # server tests (main_test.go)
go test -run TestTripLifecycle ./...   # one Go test
node --test tests/*.test.mjs           # page tests (Node 22+, no npm install)
node --test --test-name-pattern="PT e EN" tests/*.test.mjs   # one page test (a bare tests/ path fails)
gofmt -l . && go vet ./...             # CI fails if gofmt -l prints anything

docker compose up -d --build           # production container
```

- Environment variables:
  - `PLANNER_USER` and `PLANNER_PASSWORD` are required.
  - `DATA_DIR` defaults to `./data` (`/data` in the image) and `PORT` to `8080`.
  - `PLANNER_HOME_TZ` is optional and sets the default second time zone.
- `web/` is embedded with `//go:embed` and loaded into memory once at startup (`loadStatic`). **Restart `go run .` after editing any file in `web/`.** A browser reload alone won't show the change.
- CI (`.github/workflows/ci.yml`) runs on every PR and must pass before merging. It runs all of the above plus `go test -race`, a `go mod tidy` diff check, `staticcheck`, `govulncheck`, `hadolint`, and a smoke test that starts the real Docker image read-only and checks login, `PUT` and `GET`.
- `docker.yml` publishes multi-arch images to `ghcr.io` on pushes to `master` and on `v*` tags.
- The PR template asks you to run both test suites and to try the page in both PT and EN when it changes.
- Go versions differ: `go.mod` declares 1.22, CI uses 1.26 and the Dockerfile 1.27. Dependabot bumps actions, Go and the base image weekly.
- `.gitattributes` forces LF line endings.

## Architecture

### Server (`*.go`, one `main` package)
- `main.go` holds config and startup, `routes.go` the routing (`ServeHTTP`, `api()`, CSP and other security headers), `auth.go` login, sessions and rate limiting, `trips.go` trip files and backups, and `static.go` the embedded page.
- **CSP:** scripts may load only from `'self'` and `cdnjs.cloudflare.com`, and fonts only from Google Fonts. Add any new external resource to the CSP string in `routes.go`, or the browser will block it. Inline `<script>` is blocked; inline styles are allowed.
- API: `POST /api/login`, `POST /api/logout`, `GET /api/trips` (returns `{user, trips, homeTz}`), `PUT /api/trips/{id}`, `DELETE /api/trips/{id}`. Every non-GET request must send `X-Requested-With: planner` (CSRF guard). Trip IDs must match `^[A-Za-z0-9_-]{1,64}$`, and the import code in `web/js/ui/files.js` repeats this regex.
- **The server doesn't know the trip schema.** It stores `trip` as `json.RawMessage` and checks only that `trip.id` matches the URL. New trip fields need no server change.
- On disk, `DATA_DIR/trips/<id>.json` holds `{rev, updatedAt, trip}`. Writes are atomic (temp file, then rename) and serialized by `s.mu`.
- **Optimistic concurrency:** a `PUT` sends `{baseRev, trip}`. If `baseRev` differs from the stored `rev`, the server returns 409 with the current record. If the file is gone but `baseRev != 0`, it returns 409 `{deleted:true}`.
- Nothing is ever hard-deleted. `DELETE` moves the file to `backups/<id>/apagada-<timestamp>.json`. Before the first write of each UTC day, the server copies the previous version to `backups/<id>/YYYY-MM-DD.json` and keeps the last 30.
- Sessions use a stateless HMAC cookie `<expiryUnix>.<sig>`. The signing key is `sha256(.session-secret + user + password)`, so changing the password invalidates every session. The cookie lasts 30 days and slides: it is re-issued at most once a day on authenticated API calls. Failed logins are rate-limited to 8 per IP and 40 overall per 10 minutes. The client IP comes from `X-Forwarded-For`, because the app is meant to run behind Caddy.
- `-healthcheck` flag: the binary calls its own `/healthz`. The Docker `HEALTHCHECK` needs this because the image is `FROM scratch` and has no shell or curl.
- Tests build a `server` directly with `newTestServer(t)`, which uses a temp `DATA_DIR`. Requests go through `call()` / `authedCall()` against `ServeHTTP` with `httptest`; no real listener is involved.

### Page (`web/`)
- `index.html` holds all the markup: the board, the bottom "por agendar" tray, side sheets (`#editor`, `#daysheet`, `#tripsheet`, `#costsheet`, `#warnings`), plus the login and offline screens. It loads `css/app.css` and the single entry point `<script type="module" src="js/main.js">`. The web tests check both paths, and the CI Docker smoke test checks for `js/main.js`. If you rename either file, update `index.html`, `tests/web.test.mjs` and `ci.yml` together.
- **`js/main.js` lists what every module does.** Logic without UI lives in `js/`; UI lives in `js/ui/`. Each `ui/` module wires its own event listeners when it is first imported. `main.js` simply imports all of them and calls `boot()` from `sync.js`.
- **Shared mutable state lives in `S`** (`state.js`), because an ES module can't reassign a `let` imported from another module. `T()` returns the active trip.
- Modules import each other in cycles (for example `sync.js` ↔ `ui/board.js`, and between the sheets). Top-level code may use the modules outside the cycle: `util`, `state`, `i18n`, `tz`, `trip`, `costs` and `warnings`. Call anything from `sync.js` or `ui/` only inside functions or event handlers, because it may not be initialised yet when a module first runs.
- **Mutation pattern:** call `pushHistory()` (an undo snapshot of the whole store, capped at 60), mutate `T()` in place, then call `commit()` from `sync.js`. `commit()` marks the store dirty, debounces a save (1.2 s) and calls `render()` (`ui/board.js`). Use `dropHistory()` when it turns out nothing changed. Editors that fire on every keystroke use a `snap` flag so they push history only once per edit session.
- `render()` rebuilds the board, tray and stats from state, recomputes `computeWarnings()` (`warnings.js`) and refreshes any open sheet without stomping the focused input.
- **Sync (`sync.js`):** the private maps `synced[id]` (the JSON string last confirmed by the server) and `revs[id]` (its revision) drive dirty detection. A trip that appears in `synced` but not in the store is sent as a `DELETE`. On a 409 the client discards its local copy, takes the server version, clears undo history and shows a toast. A 413 (bodies over 2 MB) is marked synced so it doesn't retry forever. The page also refetches when the tab becomes visible, and saves when the tab is hidden.
- **Times** are minutes from midnight of the block's `date` column and can exceed 1440 when the board crosses midnight. `view(t)` (`span.js`, re-exported by `trip.js`) derives `T0`, `span` and `T1` from `dayStart` and `dayEnd` (hours; `dayEnd < dayStart` means the day ends after midnight). The grid snaps to 15 minutes.
- **The board hours only control what is shown.** A block may start at any hour and last several days. `span.js` (pure, tested in `tests/span.test.mjs`) works in absolute minutes from the trip's first midnight: `segments()` cuts a block into the visible piece of each column (`cutTop`/`cutBot` mark where it continues, drawn as a zig-zag edge), and `hiddenEdge()` places a marker (`.hid-chip`) at the nearest column edge for a block with no visible part. `boardLayout()` (`trip.js`) applies both to the whole trip. Overlap warnings compare absolute times, so they catch overlaps across days. Costs and the day sheet still belong to the block's own `date`.
- **Time zones (`tz.js`):** `trip.tz` is an optional IANA zone, and board times are always the trip's local time. Times are never converted when `tz` changes. An extra hour column shows a second zone. That zone comes from the device's choice (`localStorage` `ferias-home-tz`), else the server's `PLANNER_HOME_TZ` (sent as `homeTz`), else the browser's zone. `secondTz(t)` computes **one offset per trip**, taken at noon UTC on `t.start`.
- **Trip shape** (defaults are filled in by `normTrip`, so old data keeps loading):
  - Basic fields: `id, name, start, end` (ISO dates), `dayStart, dayEnd, tz?, people, currency, budget?`.
  - `places[{id,name,c}]` and `dayPlaces{date:[placeId, placeId2?]}`.
  - `blocks[]` (scheduled activities) and `tray[]` (the same objects without `date` or `start`).
  - `costs[{id,label,amount,per:'total'|'pp',cat?,date?,paid?}]` (a cost with no `date` is a general cost).
  - Optional `costCats`. When it is absent, translated defaults are used, and `ownCats()` copies them onto the trip the first time they are edited.
- Enum IDs that are persisted are Portuguese: status `ideia/reservar/reservado/pago` and cost categories `alojamento, transporte, …`. These are stored data, so never rename them. Only their labels are translated.
- Excel export loads SheetJS from cdnjs lazily, only when the user clicks it. Backup and import use the format `{version:2, trips}`. Import merges trips by `id`.
- `localStorage` keys: `ferias-lang`, `ferias-active-trip`, `ferias-hide-sleep`, `ferias-home-tz`. Trip data never lives in `localStorage`. The server is the only store.

### i18n (`web/js/i18n.js`) and the page tests
- `pt` and `en` dictionaries, with `pt` as the fallback. A value can be a string with `{placeholders}`, an array or object, or a function (used for plurals and word-order differences). In code, call `tr(key, params)`. In static HTML, use the `data-i18n`, `data-i18n-ph`, `data-i18n-title` and `data-i18n-aria` attributes. Switching language re-applies the attributes and calls `render()`.
- `tests/web.test.mjs` checks several things:
  - PT and EN have the same keys, with matching types, list lengths and `{placeholders}`.
  - Every key used via `tr('…')` or a `data-i18n*` attribute exists.
  - Every module parses.
  - Every import resolves to a real export.
- The test parses the source with regexes, so keep to these forms:
  - **Single-quoted literal keys** inside `tr(...)`.
  - **Single-line `import { a, b } from '…'`** statements.
  - Exports declared as `export function`, `export const` or `export { … }` at the start of a line.

## Build and deploy notes
- The Dockerfile copies only `go.mod`, the root `*.go` files and `web/`. A Go subpackage or a `go.sum` (if a dependency is ever added) would need its own `COPY` line.
- The runtime image is `FROM scratch` and runs as UID 65532 with a read-only root filesystem, no capabilities and a 64 MB memory limit. Data lives in the `/data` volume.
