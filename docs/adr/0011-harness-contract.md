# The harness is a contract, not a product: a fixture-pinned subset of the opencode server API is Harness Contract v1

Status: accepted (2026-08-27) · amended with vNext session-contract surfaces (2026-09-05, see vNext)

Amicode runs on switchable chat harnesses. The default is canonical opencode; the
proprietary telaio harness (subscription) arrives with Telaio.jl's serve daemon; a
third party may bring their own. This record fixes what "a harness" means to the
product so the swap is configuration, not a rewrite.

**The decision — compat-first.** Harness Contract v1 IS the subset of the canonical
opencode server API and serving behavior that the product actually consumes, pinned
by golden fixtures recorded against canonical releases — the same technique that
moved the 31 `/amicode/*` routes onto the extension-host service (#451): fixtures
recorded from the running incumbent, replayed against any candidate. A harness that
serves the contract — process lifecycle, auth, the event bus, the session/turn API,
a chat web app at the origin root — slots in with zero extension changes.

**Why not a neutral protocol.** The product's investment rides the existing surface
unchanged: the app bundle (the M2 overlay on the canonical app) talks to the server
through `@opencode-ai/sdk`, the deck panes and chat panel iframe the server origin
with the `?auth_token=` bootstrap, and the extension host spawns `serve` and reads
`/event`. A new protocol would strand the app bundle, re-plumb every consumer, and
put telaio's arrival behind a protocol-design project — while buying nothing the
fixture-pinned subset doesn't already give: the contract is what the product
consumes, pinned by evidence, versioned by fixture refresh. If a second harness
family one day shows the subset is the wrong shape, a neutral protocol is a v2
question, recorded here as a consequence rather than a blocker.

**The contract surface (v1), by consumer:**

| Surface | Consumer | Evidence | Harness obligation |
|---|---|---|---|
| Process lifecycle — spawn `serve --port=N`, health probe (2xx/3xx on `/`, Basic auth), SIGTERM stop | extension host (`server_manager.ts`) | migration manifest §1 gates (b), (e) | same serve contract + health + stop |
| Per-boot Basic auth (`OPENCODE_SERVER_PASSWORD` mint), `?auth_token=` iframe bootstrap | `server_auth.ts`, `chat_panel.ts` | #163; migration §1 gate (b) | same mint, same header, same param |
| Chat web app at the origin root, honoring `?auth_token=`, `colorScheme`, feature params | `chat_panel.ts`, `deck_panel.ts` + `deck/shell.ts` (path-only tab URLs against the boot origin) | M2 app bundle + manifest | serve the app bundle (or a UI that speaks the bridge envelopes) |
| `/event` SSE — `data: {"type":..., "properties":...}` envelopes (session lifecycle, tool execution, custom plugin events) | `sse_client.ts` (status bar, Run Inspector) | verified wire format, opencode 1.3.x–1.18.x | same envelope shapes on the same path |
| Session/turn API — the SDK paths the app bundle exercises, plus POST `/session`, GET `/command` | app bundle (`@opencode-ai/sdk`), `bug_report.ts` | M2 `server_coupled_port_inventory` (35 files) is the typed-risk worklist | the consumed routes and shapes, fixtures first |
| Injection channels — AGENTS.md/instructions and skills as FILES in the project dir; config authored per-harness (today `OPENCODE_CONFIG_CONTENT`: instructions merge, permissions, plugin path, `default_agent`) | `opencode_config.ts`, the staging launcher | migration §1 bonus finding (the transform hook is canonical) | read the same files; config authorship belongs to the adapter |
| The `amicode_*` tool surface + the live context splice | `opencode-plugin/amicode_tools.ts`, `amicode_context.ts` | ADR-0003 skill surfaces; the entity rail | MCP floor (A3) or native equivalent |

**The tool surface is product-owned, not harness-owned.** The `amicode_*` tools are
the studio's interview rail, not any harness's feature. Their portable carrier is an
MCP server owned by the extension host (A3, seeded in the campaign queue);
harnesses may implement them natively where they are stronger — Telaio.jl holds the
entities natively — but the product must never require one harness to have them.
The opencode plugin remains the implementation for the default harness until A3
lands.

**The adapter seam.** One place in the extension owns harness selection: a
descriptor (id, launcher, health probe, capabilities) behind today's ServerManager
spawn, selected by settings. Harness identity lives in settings and product copy —
never in wire protocol strings, per `protocol-blocklist.json` (generic phrasing on
the wire; the proprietary name is a product fact, not a protocol fact).

**What is explicitly NOT in v1.** The full opencode API — only the consumed subset
is contract; the rest is implementation detail the fixtures ignore. The fork's
server-coupled app features — the M2 manifest's 35-file
`server_coupled_port_inventory` is the port-upstream / extension-service / drop
worklist, already recorded, not silently absorbed here. The TUI — ADR-0010's XDG
sharing stays a property of the opencode harness.

**Enforcement.** The contract is what the fixtures pin. Golden fixtures recorded
from canonical opencode at each release pin, replayed in CI alongside the drift
gates; a harness passes the contract by passing the fixtures. A fixture refresh is
a contract version bump and reviews like any API change.

**Consequence.** Telaio.jl's `serve` daemon implements the subset — its event spine
becomes the `/event` bus, its question tool the human channel, its policy engine
the model routing the server-side config only hints at. Third-party harnesses get
two doors into the same contract: implement the subset (a server swap behind the
adapter seam), or serve a chat UI into the deck's iframe seam and speak the bridge
envelopes (a UI swap). Either way the studio — vaults, runs, catalog, skills,
widgets, the extension service — never moves.

Implementation: harmoniqs/amicode#621 (this record). The implementing campaign
(`harness-agnostic`, personal-vault ledger `sessions/session-20260827-harness-agnostic.md`)
queues T4 (Telaio.jl serve), T1b (the effort knob), T3 (the battery/bakeoff
apparatus), and A3 (the MCP floor).

## vNext (2026-09-05): session-contract fields beyond v1 — optional richer surfaces + the per-harness conformance suite

Design of record: spec-20260905-045114-session-device-lifecycle (§ Placement under
harness-agnostic, the post-approval amendment). Everything above stands: the base
contract remains fully implementable by a harness serving only today's canonical
API. This section declares what harnesses MAY serve beyond that subset — each
surface OPTIONAL, with the client-side fallback that keeps the product fully
functional when none are served — and one new MUST for every harness: the
conformance suite.

**The richer session surfaces (all OPTIONAL).** Three surfaces, born from the
session & device lifecycle spec's founding incidents, enter the contract rather
than staying product behavior so every backend can serve them:

- **Server-computed list currency.** A currency field on session-list responses:
  `list-generation = (count, max time_updated, sum of time_updated)` over the rows
  the default list returns, plus the server build id — computed on every list
  response, never hand-bumped, so same-tick touches, archive churn, and
  out-of-band writes advance it by construction. *Fallback:* the client derives
  the same token over the projection it fetches (count, max, sum + a
  server-version stamp read from the API responses) and checks it against the
  boot-time fetch-before-render — no server field needed; a stale persisted
  snapshot dies exactly as dead.

- **Server-side project resolution with first-class non-git homes.** Any directory
  a session opens, creates, or boots in resolves to a project row (worktree = the
  directory, vcs = none), auto-created at boot with a backfill over the existing
  session table, re-keyed if a non-git home later becomes a git repo. *Fallback:*
  project grouping is client-side over `directory`/`projectID` — data the global
  list already returns — so non-git homes render as their own groups with no
  server rows, no backfill, no junk lint.

- **Boot parity records (three outcomes).** Build parity asserted at boot with a
  recorded outcome — `parity-ok | parity-drift | channel-unreachable` — where an
  unreachable channel fails OPEN but is never rendered as ok. *Fallback:* parity
  is checked client-side against the release channel using the server-reported
  version.

**The conformance suite (MUST, per harness).** The query semantics of every
session-list endpoint — scoping keys, filter fields, defaults, v1 and v2 routes —
are declared surface. Every harness (opencode canonical, Telaio.jl, future) is
validated against the declared session-list semantics fixture set, and a build
that changes what a query *means* without a companion fixture update fails that
harness's conformance run. Additive optional fields with base defaults are
permitted; semantic changes are not — premium needs ride that rule like anyone
else's. This generalizes the fork-only drift gate the spec originally specified
(H5): the client's expectations of session-list semantics are declared and tested
per harness, which is stronger than gating one incumbent.

**Contract, not premium.** The richer surfaces live in the public contract so
every backend can serve them — the public base is complete without any overlay
(the boundary amicissimo ADR-0002/0003 established, transposed to the session &
device plane). Premium adds no contract fields: fleet-driven additions to public
APIs land as additive optional fields with base defaults, never requirements, and
the overlay may never fork the base session contract. Upstream contribution of
the currency field, project resolution, and parity record to anomalyco/opencode
is RECOMMENDED, not required — nothing blocks on it; the held fork PRs (#296/#298)
are the reference deltas.
