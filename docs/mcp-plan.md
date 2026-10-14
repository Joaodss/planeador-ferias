# MCP server: design and status

Status: **implemented** (first version). The user-facing guide is the "Assistente de IA (MCP)" section of the README (in Portuguese, like the rest of the docs); the conventions for contributors are in CLAUDE.md. This file records the design decisions and what is left.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Where it runs | Inside the existing Go binary, at `POST /mcp` | The binary already owns `DATA_DIR`, `s.tripsMu`, the cache and the backups. No new process, no third-party modules. |
| Transport | MCP Streamable HTTP, stateless: one JSON-RPC message per POST and one `application/json` reply. No SSE, no `Mcp-Session-Id`; `GET /mcp` answers 405. | The smallest part of the spec that clients accept. |
| Auth | `PLANNER_MCP_TOKEN` (≥ 32 characters) as `Authorization: Bearer`. Without it, `/mcp` answers 404. Failures count towards the login rate limit. | A bearer token isn't an ambient browser credential, so `/mcp` skips `csrfGuard`. Separate from the password, so it can be revoked on its own. |
| Read-only mode | `PLANNER_MCP_MODE=read` hides and refuses the tools that write. | For "look and suggest" use. |
| Tool granularity | Small, intent-level tools; each one is a single read-modify-write under `s.tripsMu` (`editTrip`). | The model never sends back a whole trip, and tool calls can't overwrite each other. |
| Schema | `tripedit.go` mirrors the rules of `clean.js`/`trip.js`/`tripform.js` on a `map[string]any`, so fields it doesn't know survive. | The page still runs `cleanTrip` on load. A golden file and `tests/mcp.test.mjs` fail if the two sides drift apart. |

## Guardrails against AI mistakes

Instead of a pull-request style review queue, the AI is limited in what it can do, what it changes is marked, and a copy is kept before every change:

1. **No delete tools.** Taking an activity out of the plan means moving it to "por agendar" (`move_activity` with `to_tray`). Trips, places and costs can't be deleted through MCP.
2. **Protected data.** The AI can't change activities that are locked, `reservado` or `pago`, paid costs, or trips that the user made read-only (`readOnly`) or archived (`archived`). Shortening a trip's dates fails if it would move a protected activity off the board. Only the user sets `readOnly`/`archived`, in the page.
3. **Marks.** Everything the AI adds or changes gets `ai` (the time of the change): ✨ on the board, a "✨ n da IA" button and a panel listing the unseen changes, with "Visto" and "Marcar tudo como visto". Editing an activity in the editor also counts as seen.
4. **Undo.** Before every write the server keeps the previous version (`backups/<id>/ia-….json`, the last 20). `undo_last_ai_change` (MCP) and the panel's "Desfazer a última alteração da IA" (`POST /api/trips/{id}/undo-ai`) restore it, one step at a time, as long as the trip hasn't changed since. Marking changes as seen doesn't count as a change.
5. **The client's own approval.** Claude Code and Claude Desktop ask before each tool call that writes (the write tools carry `destructiveHint` when they change existing data).

## Tools

| Tool | Writes | Notes |
| --- | --- | --- |
| `list_trips` | — | Archived trips only with `include_archived`. |
| `get_trip` | — | Everything, with `HH:MM` times, place names and `protected` on the activities the AI can't change. |
| `get_day` | — | One day's places, activities and costs. |
| `create_trip` | yes | Same checks as the trip form (dates, at most 60 days, IANA zone, currency). |
| `update_trip` | yes | Like `applyTripEdit`: shortened dates move activities to the tray and day costs to general costs. |
| `add_activities` | yes | A list of up to 200, in one atomic call; without `date`/`start` they go to the tray. A new place name creates the place. |
| `update_activity` | yes | Only the fields sent; `""` or `0` clears a field. |
| `move_activity` | yes | `date` + `start`, or `to_tray`. |
| `add_place` | yes | Returns the existing place if the name is already there. |
| `set_day_places` | yes | [first, …stops, last], at most 12. |
| `add_cost`, `update_cost` | yes | Costs that aren't part of an activity. |
| `undo_last_ai_change` | yes | See guardrails. |

## How it fits with the page

- AI writes go through the same `storeTrip` as the page's `PUT` (daily backup, `rev + 1`, atomic write, cache).
- An open page sees AI changes when the tab regains focus (the existing ETag refresh). If it has unsaved edits to that trip, its next `PUT` gets a 409 and the server version wins, as between two devices.

## OAuth (done)

`PLANNER_PUBLIC_URL` turns on a small OAuth 2.1 authorization server in the binary (`oauth.go`), so the planner can be added as a claude.ai custom connector (which also shows up in the Claude phone apps). PKCE S256, stateless dynamic client registration (the `client_id` is the signed client), protected resource metadata, and stateless HMAC tokens signed with the session key, so changing the password revokes every connection. The static `PLANNER_MCP_TOKEN` keeps working for Claude Code.

## Possible next steps

- `get_costs` (totals per category and per day, as in the costs sheet) and `find_overlaps` (the most useful warning for an AI planner).
- A light refresh in the page while it's visible and has nothing to save, so AI changes show up without switching tabs.
- An MCP check in the Docker smoke test in CI.
