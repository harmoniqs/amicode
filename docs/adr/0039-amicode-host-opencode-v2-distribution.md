# ADR 0039 — Amicode is an opencode v2 distribution (the amicode-host)

- **Status:** proposed — pending adversarial review (`deliberate`); nothing below is implemented
- **Date:** 2026-11-01
- **Context refs:** ADR 0005 (managed fleet), 0019 (overlay provenance naming), 0020 (detached standalone
  server), 0027 / 0029 (peer fleet studios, `serving` capability), 0031 / 0033 (Fleet Studio in-window
  sessions, SSE fan-out), 0032 / 0034 (peer trust, observe/control), 0037 (trust boundaries); amicissimo
  ADR 0002 (public/premium split)
- **Supersedes:** ADR 0020 in full (its accepted cost, a per-boot password at rest in a 0600 file, is replaced
  by v2's registration file, which also holds the password at 0600). From ADR 0005, only the server-lifecycle
  machinery (the canonical launchd/systemd server, tunnel choreography). The *implementation homes* (not the
  behaviours) of ADRs 0031 and 0033.
- **Per-item disposition of the rest of ADR 0005** (decided in H4, not here): the **never-fork guard is
  retained** as an invariant; the *rejoin merge* and its golden fixtures are keyed to the v1 `event` table that
  the V1→V2 importer wipes, the *identity handshake / fleet token* and *local fallback* are open, and ADR 0005's
  own flip condition ("native remote-attach with identity and auth upstream") must be checked against v2 pairing.
- **Amends:** ADR 0027 §8 — gives Horizon 2 (compute federation) a concrete mechanism.
- **Companion:** the program spec `spec-20261101-170000-amicode-host-v2-port` (round 2 after a three-critic review).

## Context

Amicode's engine is **a fork kept as whole files**. `packages/app-bundle/overlay/` holds ~1,075 files laid
over a pinned upstream (`anomalyco/opencode` @ `3104c142`, v1.18.30): 423 of them *replace* upstream files
outright, and the materializer's whole conflict policy is "copy over". Nothing detects that upstream changed
a file underneath a replaced copy, so a base bump silently discards upstream's fixes unless someone merges
by hand. We have done that four times since July; the most recent sync was reported at ~480 manual
conflicts.

Upstream has meanwhile **rewritten the product**. opencode 2.0.0 shipped 2026-09-11, two days after our
pin; it is at 2.2.5 (2026-10-30), **6,077 commits** past our base. `packages/opencode`, `packages/llm`
and `packages/sdk/js` — the packages our overlay patches — no longer exist there. v2 is organised as
Schema → Core/Protocol → Server, with a typed `@opencode/client`, a plugin API ("nearly every v2 feature
is implemented as an internal plugin; 80+"), hot reload of plugins/config/skills, a managed per-machine
background service, durable execution claims with resume at boot, and `@opencode/sdk`, which "is the exact
same code that powers our CLI" and lets you "make your own flavor of OpenCode… that speaks the standard
OpenCode server protocol".

A large part of our **fleet machinery exists to work around v1's runtime**:

- ADR 0020 (detached server, handshake file, adopt-on-activate, 30 s grace self-exit) exists because a v1
  turn lives in process memory.
- The three-shard pool, the 2,716-line `hub-frontdoor.py`, the RSS watchdog and `lane-roll.sh` exist
  because one v1 event loop saturated under parallel load (nine restarts on 2026-10-04/05 killed every
  in-flight session on the shard).
- Restarts lose in-flight turns: busy state is in-memory only (`session/status.ts`), and "durable
  continuation recovery" is explicitly a future slice in the v1 V2-session-core.

Separately — and **independent of v2** — local solves are not decoupled from the engine. `amico run`
starts Julia detached from the *process tree*, but inside the engine's systemd *cgroup*; the hub units use
`KillMode=control-group`, so restarting a shard kills every solve it launched. Julia's output reaches
`run.log` and `FINISHED` only through a pipe into the `amico run` Node process, and there is no pid or
unit record, so nothing can reattach.

## Decision

**D1 — Amicode is a distribution of opencode, not a fork.** A single TypeScript process, the
**amicode-host**, runs the opencode v2 server in-process and serves the standard protocol. Upstream is a
*versioned dependency*, upgraded like any other, gated by contract tests (D8). The overlay materializer
is retired when the cutover completes. **How the host obtains the server is not yet settled:** the published
`@opencode/sdk` entries (`.`, `./effect`, `./workerd`) return a client, not the server's `fetch` — that handler
exists only inside the unexported `internal/host.ts`. Candidate seams, decided by spike H0c: (a) an upstream PR
exporting the handler, (b) `@opencode/server`'s published `createRoutes` (it honours a password, and our routes
are added in-router), (c) proxying a stock service (which loses in-process plugins and workspace providers).

**D2 — Extension seams, in strict order of preference.** (1) a plugin hook, (2) plugin RPC, (3) a host route
(the host fronts the SDK's `fetch` and answers its own paths first), (4) an upstream PR, (5) a source patch.
A source patch is a last resort and is recorded in a **patch queue** with an owner, a reason, and the
upstream PR that retires it; CI fails if a patch stops applying cleanly. **No retained patch may add or alter
a table in the v2 database.** The one seam v2 does not offer is an HTTP-route hook for plugins — which is why
(3) exists, subject to D1's open question.

**D3 — One host per (machine, database), as a managed service.** Registered the way v2's service is (a
registration file plus a fixed port), replacing the handshake / adopt / grace-exit machinery of ADR 0020, but
with a **distinct registration path and port**: v2's client will terminate or replace whatever the default
registration names on a version mismatch, so a stock `opencode` client must never be able to kill the host or
spawn a second server on its database. The host runs on **Bun** (the V1→V2 importer is a no-op under Node),
sets `database.path` explicitly (the embedded default is `:memory:`), and takes an **exclusive lock before
creating the server** and waits for the previous pid to exit: the embedded host runs the restart sweep
unconditionally, and v2's guarantee that an orphaned claim's owner is dead lives in its CLI service layer, not
in the SDK. A VS Code reload, a second window, or a browser all attach to the same host.

**D4 — Scientific compute lives outside the host.** Every `amico run` becomes a transient unit
(`systemd-run --user` on Linux; a launchd job on macOS) whose `ExecStart` is the *existing* orchestrator, so
the iteration classifier, the ledger stanza the warrant counts, free-tier verification and the stdout contract
are unchanged; the invoking command becomes a thin client that **detaches** (never aborts the solve) on
`SIGTERM`/`SIGHUP`. A `run.lock` records {unit, pid, host, spec hash, protection, cloud run id} and is touched
by a heartbeat, so `dead` versus `stalled` is decidable from files alone, and a run that could not be placed in
a unit says so and blocks restart gates. This ships on the v1 engine **before** the port, preceded by **step A0**:
the restart paths that exist today (`lane-roll.sh`, `hub-restart.sh`, the RSS watchdog) restart a shard on
session idleness alone and never check for solves, so they violate the invariant this ADR relies on. It remains
necessary on v2, because v2 cancels background *shell* jobs on restart (only background *subagents* and PTY
terminals survive).

**D5 — Restarts rely on v2's durable execution.** Turns resume at boot from their execution claim
(at-least-once, capped at 10 attempts). Because resume can repeat side effects, expensive or non-idempotent
turns stay **drain-gated** (the `lane-roll.sh` idle-check idea, kept) and must be idempotent where
practical. A host binary change therefore costs a drained restart, not lost work; plugin, skill and config
changes hot-reload with no restart at all. The cap is 10 resumes; the 11th terminalises the turn. A resumed
turn that re-ran `amico run` would start a duplicate solve, so `run.lock`'s spec hash makes a second launch of
the same spec refuse. Behaviour of a turn with a *pending permission or question* across a graceful restart is
unverified and is a contract test.

**D6 — The fleet keeps its shape and changes its home.**
- *Studios and `serving` capability* (ADRs 0027/0029) are unchanged as a model.
- *Per-session owner routing and SSE fan-in* (0031/0033) and *peer trust* (0032/0034) are already TypeScript
  in the extension service; they **move into the host with their tests**. The Python frontdoor does other work
  (sticky and least-loaded placement, lossless resume, the gateway secret, a heartbeat canary, dead-shard
  handling, dial ceilings, a snapshot cache, Jev placement); each behaviour is dispositioned (keep, supplied by
  v2, drop with evidence) once H0 reports.
- **Event semantics are host-invented, not inherited.** v2's `/api/event` is *volatile by contract*: no `id:`
  line, a 4,096-slot dropping queue that fails a slow consumer, no resume. ADR 0033's composite cursors, replay and
  byte-identity therefore become new host code over a volatile stream — or are dropped in favour of the store's
  refetch on reconnect. The acceptance test is frame parity with zero peers and a consistent store after a drop.
  Pausing the local arm to apply backpressure, as ADR 0033 amendment 2 does, would overflow that queue.
- *v2 pairing is a bootstrap only.* A paired client has full API access with no scopes, revocable only by
  rotating the password; per-peer revocation and the accept-set stay ours, in host middleware.
- *Compute federation* (ADR 0027 §8, Horizon 2) is built on v2's `WorkspaceProvider` /
  `EnvironmentDriver`: a peer machine or a cloud runner provides remote **tool execution and files** while
  the session, model loop and database stay on the originating machine. This needs an embedder (the stock
  CLI ships an empty provider registry) using the **Effect** SDK entry — the Promise entry omits
  `workspaceProviders`. A driver is an Effect `ChildProcessSpawner` plus file overrides, so a streaming remote
  spawner over SSH or HTTP is a real spike, not a configuration. Solves started through a remote workspace are
  units on the remote machine, independent of the workspace's 20-minute idle suspend.

**D7 — The Amicode UI is its own app, not a patch of upstream's.** Built on the published
`@opencode/client` (its `/solid` `createData` store — the same one the upstream TUI uses) and
`@opencode/ui` (primitives, theme). `@opencode/session-ui` is `private` and unpublished, so it is
**vendored** (subtree, with upstream's licence text and a NOTICE). Its `ToolRegistry` is reachable by import
path in the vendored tree, so Amicode can register the Run Inspector, widget and question renderers with no
patch; the upstream contribution is an exports-map entry. session-ui reads its own `useData` context, so an
adapter fed from `createData` is part of the work. We stop patching `packages/app` (~140k lines), whose routing,
multi-server orchestration and desktop plugin host do not serve a VS Code webview.

**D8 — Staying current is a loop, not a quarterly ordeal.** A bump bot opens a PR per upstream release,
rebases the patch queue, runs the contract suite against `@opencode/client`, `@opencode/plugin` and the SSE
events we consume, and reads upstream's changelog for patches it now obsoletes. Bump PRs are **human-merged** at first; patch-level and green becomes eligible for autonomous merge only
after the charter exists (D10). A minor bump or a failing contract escalates. Upstream
contributions are drafted and opened by the agent identity per the contribution policy; the first two are
*export the server handler from `@opencode/sdk`* (if H0c chooses it) and *publish `@opencode/session-ui`*.

**D9 — Strangler migration, not a big bang.** A v2 host runs on a canary alongside the v1 engine; features
are ported behind contract tests, sessions are brought across with upstream's V1→V2 importer, and traffic
moves over when a parity checklist is green. After 0.4.0 the v1 overlay is **maintenance-only**
(`lane/0.4.1`, fixes) and feature work waits for the host and the new app.

**D10 — Autonomy is a ladder, and each rung is earned by error correction.** Public intake and automated releases
follow the Amicode loop (propose → trusted gate → independent corrector → stage → human promote), with the
human step moving outward only as the corrector's own tests stay green. The deterministic floor (author trust tier,
class path allowlist, deny-list on title and body, protected paths) applies whatever any model says; agents never
write protected paths, never hold or reach publish secrets, and never edit the files that gate their own merges.
A rung (alpha cut, stable promote) is handed to an agent only by a charter amendment signed off the hub, and is
revoked automatically on a revert, a canary rollback, a failed audit, or a missed planted-adversary drill. The
design of record is spec sections D, E and J; it was reviewed adversarially and **several claims in the first
draft were wrong about the engine it reuses** (the existing critic does see the issue; the token mint sends no
scope body; release secrets are repo-level with no protected environment; `promote.yml` accepts a SHA with zero
check runs and does not require ancestry from `main`). Those facts are now work items, not assumptions.

## Not decided here

- **One host vs one database per shard.** v2 evicts idle Locations after 60 minutes (it may cure the
  single-loop saturation that created the shard pool), but several managed services on one database is
  *unsupported* (the restart sweep assumes a single owner). A load spike (H0) decides; until then the
  design must work for both.
- **Disposition of the session-engine overlay** (receipts, lineage, mutation ledger, external-diff
  reservations, 7 DB migrations, run-state). Each needs an explicit v2 home — `ctx.storage` plus events, an
  upstream proposal, or a retained patch. **We must not fork v2's schema.** Produced by the contract
  inventory, reviewed per feature.
- **Public/premium placement** of each piece — governed by amicissimo ADR 0002 ("need it before paying →
  amicode; tuned advantage → amicissimo"); this ADR is placement-neutral.
- **Jev's role in autonomy decisions (section J).** Jev is a proposer. Whether it may ever *relax* a decision, and
  what calibration and evaluation would earn that, is a separate ADR. Until it is accepted, Jev may reorder and
  escalate toward human review and may never relax a check — which also keeps the signed rd-system-v2.1 doctrine
  intact.
- **Automatic stable promotion.** Staged behind the prerequisites in spec section E (protected environment,
  ancestry and named-check enforcement in `promote.yml`, a signed soak receipt, an out-of-band denylist, and a
  charter amendment signed off the hub). Marketplace versions are immutable, so rollback is only roll-forward.
- **A native desktop shell.** v2's GUI plugin API is desktop-only for third-party plugins and explicitly
  experimental; VS Code remains the host target.

## Consequences

**Gains.** Upstream bumps become dependency upgrades with a failing test when a contract moves, instead of
re-merging 423 replaced files. Plugin, skill and config edits are live in the next turn — a develop session
can improve Amicode in place. Interrupted turns resume without bespoke recovery code. Solves survive any
host restart. Federation gets a real mechanism. The handshake file, adopt gate, frontdoor, shard wrappers
and most of the lane-roll logic are deleted or shrink.

**Costs and risks.**
- **No stability promise upstream.** Minor releases have broken public contracts (2.1.0 SDK/event/plugin;
  2.2.0 `@opencode/ai` root; 2.2.1 provider removals; 2.2.3 TUI plugins and `integration.use`). The contract
  suite (D8) is the mitigation, and it is load-bearing, not optional.
- **Vendored session-ui** (~21.5k lines, needs `@opencode/patchmark` and `@pierre/diffs`) is the one large
  remaining copy of upstream code until upstream publishes it.
- **Defaults that differ and affect safety.** A v2 agent's default permission set is **allow-all** (`*`/`*`/allow,
  with `.env` reads asking), not merely `external_directory`; we ship an explicit default-deny policy and test it.
  The embedded server applies **no authentication** at all, so the host must authenticate deny-by-default over the
  whole fetch (fail-open otherwise). v2 discovers only `AGENTS.md` (no `CLAUDE.md` fallback) and renamed permission
  keys (`bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`), which can silently weaken the `deny` rules on
  our read-only role cards unless parity is tested. v1 plugins do not run on v2; the server API and clients are
  entirely new.
- **The V1→V2 importer is a one-way door.** It runs as a boot migration against the database it opens, deletes the
  `event` table, skips parts it does not recognise, and does not know our custom tables (receipts, lineage,
  mutation ledger). The canary uses a copy; cutover takes a snapshot; the fleet's version-skew gate (which refuses
  a `major.minor` mismatch) needs an explicit policy for the strangler window.
- **At-least-once resume** can repeat a side effect; see D5.
- **Our extension surface is wider than "a plugin."** The overlay adds 36 raw `/amicode/*` routes, a
  gateway-secret middleware, and session-engine tables; each is re-homed or retired, none is assumed free.

## Verification of the claims above

Facts about v2 were read from `upstream/dev` @ `12f7e1b59a` (packages at 2.2.5), npm, and
`opencode.ai/v2` docs source; the hosted `/v2/docs/{service,server,sdk,schedules}` pages returned 404, so
service-election, registration and pairing details come from source
(`cli/src/services/service-*.ts`, `client/src/effect/service*.ts`, `server/src/{pairing,auth}.ts`,
`core/src/session/execution/restart.ts`, `core/src/workspace*`, `sdk/src/internal/host.ts`). Overlay
figures are from a diff against the cached base tree. Cgroup behaviour was confirmed with
`systemctl show` on the live hub. A three-critic adversarial review (threat model, v2 feasibility, operations and falsifiability) produced 34
obligations; the director verified eight load-bearing claims against primary sources before acting on them. The
review's reading of v2 came from raw source at the pinned commit; several items remain unverified and are marked
as such in the spec (idle Location eviction, pending-permission behaviour across restart, `/global/health`
version field on v2, persistent-terminal survival mechanics). These are inputs to the next review round, not
conclusions of it.
