# MCP server: tools and implementation plan

Status: proposal, nothing implemented yet. Once it ships, the user-facing part moves into the README (in Portuguese, like the rest of the docs).

## Goal

Let an AI assistant (Claude Code, Claude Desktop or any MCP client) read and edit the trips with the same rules as the page: list trips, build an itinerary, move activities, add costs and day places. It must stay lightweight: no new process, no third-party Go modules, no build step, and nothing the page depends on changes.

## Key decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where it runs | **Inside the existing Go binary**, as one endpoint `POST /mcp` | The binary already owns `DATA_DIR`, `s.tripsMu`, the cache and the backups. A separate process would need its own lock or would have to go through the HTTP API with the password. |
| Transport | MCP **Streamable HTTP**, stateless: each `POST` carries one JSON-RPC message and gets one `application/json` reply. No SSE, no `Mcp-Session-Id`. `GET /mcp` answers 405. | That is the smallest piece of the spec that clients accept. It needs only `encoding/json` and `net/http`. |
| Auth | New optional env var `PLANNER_MCP_TOKEN` (≥ 32 characters). If it is missing, `/mcp` answers 404 and the feature is off. Clients send `Authorization: Bearer <token>`. | A bearer token isn't an ambient credential, so `/mcp` can skip `csrfGuard` safely. It is separate from the password, so it can be revoked without logging out every browser. |
| Tool granularity | **Small, intent-level tools** (`add_activity`, `move_activity`, …), not "replace the whole trip JSON" | The model never has to send back a 1 MB trip. Each tool is one atomic read-modify-write under `s.tripsMu`, so tool calls can't overwrite each other's changes. |
| Schema | The server learns **just enough of the trip schema** to edit it safely, in a new `tripedit.go` that mirrors the rules of `clean.js`. Trips are decoded into `map[string]any`, so fields the Go code doesn't know about survive the round trip. | The page still runs `cleanTrip` on everything it loads, so it remains the final guard. The Go side only needs to avoid writing anything the page would have to repair. |
| Times on the wire | Dates as `YYYY-MM-DD`, start times as `"HH:MM"` (snapped to 15 min), durations in minutes. Responses show both `"09:30"` and the raw minutes. | Models handle clock strings much better than "minutes from midnight". |
| Language | Tool names are English `snake_case`. Descriptions, error messages and test names are Portuguese, like the rest of the server. | Matches CLAUDE.md. Models understand both. |

## MCP tools

All tools return `structuredContent` (JSON) plus the same JSON as a `text` block, for clients that only read text. Every write tool returns the new `rev` and the changed object, so the model doesn't have to re-read the trip. Errors come back as `isError: true` with a Portuguese message (for example `atividade a12 não existe`), not as a JSON-RPC error, so the model can correct itself.

Each tool sets the MCP `annotations`: `readOnlyHint` on reads, `destructiveHint` on deletes, `idempotentHint` where it applies.

### Read

| Tool | Input | Output |
| --- | --- | --- |
| `list_trips` | — | `[{id, name, start, end, tz?, people, currency, rev, updatedAt, activities, unscheduled}]` |
| `get_trip` | `trip_id` | The full trip, with every block's `start`/`end` also as `"HH:MM"`, place names next to place ids, plus `rev`. |
| `get_day` | `trip_id`, `date` | That day's activities sorted by start, its places (first, stops, last), its costs and the day's total per person. Lets the model work on a long trip without loading all of it. |
| `get_costs` | `trip_id` | Totals per category, per day, general costs, paid vs. unpaid, the total per person and for the group, and the budget left. It mirrors `costSummary` (`costs.js`) for the parts that don't depend on the page language. |

### Trips

| Tool | Input | Notes |
| --- | --- | --- |
| `create_trip` | `name`, `start`, `end`, `tz?`, `people?` (1), `currency?` (€), `budget?`, `day_start?` (7), `day_end?` (1) | Same checks as `validateTrip` (name, date order, at most `MAX_DAYS` = 60 days, a valid IANA zone). Returns the new `id`. |
| `update_trip` | `trip_id` + any of the fields above | Same behaviour as `applyTripEdit`: when the dates shrink, activities outside them go to the tray, their day costs become general costs and their day places are dropped. The reply says how many activities moved. |
| `delete_trip` | `trip_id` | Same as `DELETE /api/trips/{id}`: the file moves to `backups/<id>/apagada-…json`. `destructiveHint: true`. |

### Activities (blocks)

| Tool | Input | Notes |
| --- | --- | --- |
| `add_activities` | `trip_id`, `activities: [{title, date?, start?, duration?, kind?, status?, place?, cost_pp?, cost_total?, cost_category?, tz?, address?, link?, ref?, note?, weekdays?}]` | Takes a list, so a whole itinerary costs one call. Without `date`/`start` the activity goes to the tray ("por agendar"). The defaults are those of `newBlock`: 60 min, `tour`, `ideia`. `place` accepts a place id or a name; an unknown name creates the place (as `addPlace` does). Returns the new ids. |
| `update_activity` | `trip_id`, `activity_id` + any field from `add_activities` (use `null` to clear one) | Refuses to move a `locked` activity unless `unlock: true` is passed. |
| `move_activity` | `trip_id`, `activity_id`, `date` + `start`, or `to_tray: true` | A shortcut for the most common edit. It respects `locked`. |
| `duplicate_activity` | `trip_id`, `activity_id` | The copy goes right after the original, like `duplicateBlock`. |
| `delete_activity` | `trip_id`, `activity_id` | `destructiveHint: true` (the daily backup still holds the previous version). |

### Places

| Tool | Input | Notes |
| --- | --- | --- |
| `add_place` | `trip_id`, `name` | Picks the next colour, as `addPlace` does. Returns the place, or the existing one if the name is already there. |
| `set_day_places` | `trip_id`, `date`, `places: [id or name, …]` | Sets [first, …stops, last] for the day. At most `MAX_DAY_PLACES` = 12 and no place twice in a row, as `setDayPlaces` requires. An empty list clears the day. |
| `remove_place` | `trip_id`, `place_id` | Same as `removePlace`: removes it from the days and the activities too. |

### Costs (outside activities)

| Tool | Input | Notes |
| --- | --- | --- |
| `add_cost` | `trip_id`, `label`, `amount`, `per` (`total`/`pp`), `category?`, `date?`, `paid?` | Without `date` it is a general cost. |
| `update_cost` | `trip_id`, `cost_id` + fields | |
| `delete_cost` | `trip_id`, `cost_id` | |

That makes 18 tools in total. Two things stay out of the first version on purpose:

- **Warnings** (`computeWarnings`) use the layout code in `span.js` and the translated texts. Porting them to Go means keeping two copies of the rules in step. Phase 3 adds only a `find_overlaps` tool (overlapping activities, which is the warning that matters most when an AI edits).
- **Cost categories** (`costCats`), the board view settings and the second time zone are page and device settings, not planning data.

The tool inputs use the trip's own enum ids, which the descriptions list: `kind` ∈ `tour, party, transport, food, rest, sleep`, `status` ∈ `ideia, reservar, reservado, pago`, `cost_category` ∈ the trip's `costCats` or the default ids (`alojamento, transporte, alimentacao, atividades, festas, compras, outros`).

## How it fits with the page

- Every write goes through the same path as `PUT`: daily backup, `rev + 1`, `updatedAt`, atomic write and a cache update. The page notices the change through its existing ETag check.
- **If the page is open with unsaved edits** while the AI writes, the page's next `PUT` gets a 409. It then keeps the server version, the one with the AI's change, and drops its own unsaved edits with the toast it already has. That is the current behaviour between two devices. The tool descriptions say "the change shows in the page after a reload or when the tab regains focus".
- Phase 3 adds an optional light poll to the page: a `GET /api/trips` with `If-None-Match` every 30 s while the tab is visible and nothing is dirty. It costs a 304 when nothing changed, and AI edits then show up live.
- **Undo:** server-side edits aren't in the page's undo history. The daily backups are the safety net. Phase 3 can add `list_backups`/`restore_backup` tools if they turn out to be needed.

## Implementation plan

Everything stays in the root `main` package (the Dockerfile copies only the root `*.go` files), with no new modules.

### Phase 1: transport, auth and read tools

1. **Refactor `trips.go`.** Extract the body of `putTrip` (after decoding) into
   `s.writeTrip(id string, baseRev int64, trip []byte) (rev int64, conflict []byte, err error)`, and add
   `s.editTrip(id string, fn func(t map[string]any) error) (rev int64, t map[string]any, err error)`:
   load, decode, `fn`, encode and `writeTrip` with the current rev, all under one `s.tripsMu` lock. `putTrip` and `deleteTrip` keep their behaviour, and the existing tests must pass unchanged.
2. **Config (`main.go`).** `loadConfig` reads `PLANNER_MCP_TOKEN`: empty means off, fewer than 32 characters is a startup error. Update the tests in `main_test.go`, `.env.example` and the README table.
3. **`mcp.go`.** The JSON-RPC 2.0 handler for `POST /mcp`:
   - methods `initialize` (negotiates `protocolVersion`, announces `capabilities.tools`, `serverInfo`), `notifications/initialized` (202, no body), `ping`, `tools/list` and `tools/call`; anything else answers `-32601`;
   - the bearer token is compared with `constantTimeEqual`, and failures count towards the existing login rate limit (`noteFailure`/`tooManyFailures`) to block guessing;
   - if an `Origin` header is present it must match the `Host` (the spec's DNS-rebinding guard);
   - the body is capped with `http.MaxBytesReader` (`maxTripBytes`);
   - in `routes.go`: `mux.Handle("POST /mcp", …)`, exempted from `csrfGuard` by path, with `secHeaders` still applied.
4. **`mcptools.go`.** A table of tools `{name, description, inputSchema, annotations, handler}`, so `tools/list` is generated from the same table that `tools/call` uses. Start with `list_trips`, `get_trip` and `get_day`.
5. **Tests (`mcp_test.go`)** use `newTestServer` + `call()`, as the other tests do: no token (404), a wrong token (401, then rate-limited), a bad Origin, malformed JSON-RPC, an unknown method, `initialize` → `tools/list` → `tools/call`, and a notification returning 202.

### Phase 2: write tools

6. **`tripedit.go`** holds pure functions over `map[string]any`, with no I/O, and is tested in `tripedit_test.go`:
   `parseClock("09:30") → 570`, `clockLabel`, `newID(prefix)` (the same format as `newId` in `util.js`, `ID`-safe), `validateTripFields`, `addBlocks`, `moveBlock`, `toTray`, `duplicateBlock`, `applyTripEdit`, `setDayPlaces`, `removePlace`, cost CRUD, and a `cleanBlockInput` that applies the same limits as `cleanBlock` (len ≥ 15, enums, `pp`/`total` > 0, weekdays 0–6 and never all 7, `tz` checked with `time.LoadLocation`).
   Each rule carries a comment naming the `clean.js`/`trip.js` function it mirrors, so a change on one side points to the other.
7. Register the write tools in `mcptools.go`, each a thin `s.editTrip(id, func(t) { … })`.
8. **Cross-check test.** A new `tests/mcp.test.mjs` (Node) loads trips that the Go tests write to `testdata/` and runs them through `cleanTrip` (`clean.js`). It checks that `cleanTrip` changes nothing, so the Go side never writes data that the page would have to repair. This is the guard against the two schemas drifting apart.
9. Raise the coverage minimums in `ci.yml` to the new rounded-down values, as CLAUDE.md requires.

### Phase 3: polish (optional, separate PRs)

10. `get_costs` and `find_overlaps`.
11. The page's light 30 s refetch while visible and not dirty (`sync.js`, tested with `mock.timers` in `tests/sync.test.mjs`).
12. `list_backups` / `restore_backup`.
13. **Docs.** A README section (PT) on how to connect:
    - Claude Code: `claude mcp add --transport http ferias https://ferias.example/mcp --header "Authorization: Bearer $PLANNER_MCP_TOKEN"`
    - Claude Desktop: the same URL and header through its remote-server config.
    - The claude.ai web connectors need OAuth, which is out of scope here. Supporting them would need a minimal OAuth authorization server. That should be its own proposal.
14. **CI smoke test.** In the Docker job, `curl` `initialize` and `tools/call list_trips` against the read-only container.

### Rough size

| File | Lines (approx.) |
| --- | --- |
| `mcp.go` (transport and auth) | ~200 |
| `mcptools.go` (tool table and handlers) | ~400 |
| `tripedit.go` (rules) | ~350 |
| Go tests | ~600 |
| `tests/mcp.test.mjs` | ~60 |
| `trips.go` refactor | net ~0 |

## Risks

- **Two copies of the rules.** Mitigated by keeping the Go rules to editing only, by the comments pointing to their JS counterpart, by the cross-check test, and by the page still running `cleanTrip` on load.
- **Lost page edits on a 409.** This already happens between devices today. The poll in phase 3 makes it rarer.
- **A leaked token** gives full read and write access. Nothing is ever hard-deleted, the backups remain, and rotating the env var and restarting revokes it.
- **Memory (64 MB limit).** `editTrip` decodes one trip at a time, at most 2 MB. That fits next to the existing cache.
