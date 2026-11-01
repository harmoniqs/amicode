# ADR 0039 — Amicode is an SDK-embedded opencode v2 distribution (the amicode-host)

- **Status:** proposed — pending adversarial review (`deliberate`); nothing below is implemented
- **Date:** 2026-11-01
- **Context refs:** ADR 0005 (managed fleet), 0019 (overlay provenance naming), 0020 (detached standalone
  server), 0027 / 0029 (peer fleet studios, `serving` capability), 0031 / 0033 (Fleet Studio in-window
  sessions, SSE fan-out), 0032 / 0034 (peer trust, observe/control), 0037 (trust boundaries); amicissimo
  ADR 0002 (public/premium split)
- **Supersedes:** ADR 0020 in full. ADR 0005's server-lifecycle machinery (the canonical launchd/systemd
  server, tunnel choreography), while keeping its **never-fork guard** as an invariant. The *implementation
  homes* (not the behaviours) of ADRs 0031 and 0033.
- **Amends:** ADR 0027 §8 — gives Horizon 2 (compute federation) a concrete mechanism.

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
**amicode-host**, embeds `@opencode/sdk` in-process and serves the standard protocol. Upstream is a
*versioned dependency*, upgraded like any other, gated by contract tests (D8). The overlay materializer
is retired when the cutover completes.

**D2 — Extension seams, in strict order of preference.** (1) a plugin hook, (2) plugin RPC, (3) a host route
(the host fronts the SDK's `fetch` and answers its own paths first), (4) an upstream PR, (5) a source patch.
A source patch is a last resort and is recorded in a **patch queue** with an owner, a reason, and the
upstream PR that retires it; CI fails if a patch stops applying cleanly. The one seam v2 does not offer
is an HTTP-route hook for plugins — which is exactly why (3) exists.

**D3 — One host per machine, as a managed service.** Singleton per machine and profile, registered the way
v2's service is (a registration file plus a fixed port), replacing the handshake / adopt / grace-exit
machinery of ADR 0020. A VS Code reload, a second window, or a browser all attach to the same host.

**D4 — Scientific compute lives outside the host.** Every `amico run` is its own transient unit
(`systemd-run --user` on Linux; a launchd job on macOS), the solver writes `run.log` directly, and a
per-run supervisor owns `FINISHED` and writes a `run.lock` (unit, pid, host, spec hash). Any host, old or
new, reattaches by reading files; `dead` is distinguished from `stalled`. This is **sequenced first and
ships on the v1 engine** — it does not wait for the port. It is necessary even on v2, because v2 cancels
background *shell* jobs on restart (only background *subagents* and PTY terminals survive).

**D5 — Restarts rely on v2's durable execution.** Turns resume at boot from their execution claim
(at-least-once, capped at 10 attempts). Because resume can repeat side effects, expensive or non-idempotent
turns stay **drain-gated** (the `lane-roll.sh` idle-check idea, kept) and must be idempotent where
practical. A host binary change therefore costs a drained restart, not lost work; plugin, skill and config
changes hot-reload with no restart at all.

**D6 — The fleet keeps its shape and changes its home.**
- *Studios and `serving` capability* (ADRs 0027/0029) are unchanged as a model.
- *Per-session owner routing and SSE fan-in* (0031/0033) and *peer trust* (0032/0034) move into the host in
  TypeScript, replacing the Python frontdoor and the extension glue. Their **behavioural decisions are
  retained** (single-origin, composite cursors, accept-set, observe/control grants, fleet-of-one
  byte-identity).
- *v2 pairing is a bootstrap only.* A paired client has full API access with no scopes, revocable only by
  rotating the password; per-peer revocation and the accept-set stay ours, in host middleware.
- *Compute federation* (ADR 0027 §8, Horizon 2) is built on v2's `WorkspaceProvider` /
  `EnvironmentDriver`: a peer machine or a cloud runner provides remote **tool execution and files** while
  the session, model loop and database stay on the originating machine. This needs an SDK host (the stock
  CLI ships an empty provider registry), which D1 provides.

**D7 — The Amicode UI is its own app, not a patch of upstream's.** Built on the published
`@opencode/client` (its `/solid` `createData` store — the same one the upstream TUI uses) and
`@opencode/ui` (primitives, theme). `@opencode/session-ui` is `private` and unpublished, so it is
**vendored** (subtree) and gains one export — its internal `ToolRegistry` — so Amicode can register the
Run Inspector, widget and question renderers. We stop patching `packages/app` (~140k lines), whose routing,
multi-server orchestration and desktop plugin host do not serve a VS Code webview.

**D8 — Staying current is a loop, not a quarterly ordeal.** A bump bot opens a PR per upstream release,
rebases the patch queue, runs the contract suite against `@opencode/client`, `@opencode/plugin` and the SSE
events we consume, and reads upstream's changelog for patches it now obsoletes. Patch-level + green is
eligible for autonomous merge under the charter; a minor bump or a failing contract escalates. Upstream
contributions are drafted and opened by the agent identity per the contribution policy; the first two are
*publish `@opencode/session-ui`* and *export `ToolRegistry`*.

**D9 — Strangler migration, not a big bang.** A v2 host runs on a canary alongside the v1 engine; features
are ported behind contract tests, sessions are brought across with upstream's V1→V2 importer, and traffic
moves over when a parity checklist is green. After 0.4.0 the v1 overlay is **maintenance-only**
(`lane/0.4.1`, fixes) and feature work waits for the host and the new app.

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
- **Defaults that differ and affect safety.** v2 allows `external_directory` by default (we set our
  permission policy explicitly), discovers only `AGENTS.md` (no `CLAUDE.md` fallback), and renamed
  permission keys (`bash`→`shell`, `task`→`subagent`, `write`/`patch`→`edit`). v1 plugins do not run on v2;
  the server API and clients are entirely new.
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
`systemctl show` on the live hub. These are inputs to the review round, not conclusions of it.
