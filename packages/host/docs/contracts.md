# Upstream contracts — what the host depends on, derived not declared (#2064, H1d)

Upstream opencode gives **no stability promise** and has broken public contracts in minor releases (2.1.0
SDK/event/plugin, 2.2.0 `@opencode/ai` root, 2.2.1 provider removals, 2.2.3 TUI plugins). The only defence is a
test that names *exactly* what we use. That list must not be a hand-kept document, so it is **derived from the
host's own sources**, and the suite refuses to pass when a derived item has no contract.

Everything lives in `packages/host`:

| Path | Role |
|---|---|
| `scripts/contract-scan.ts` | The scanner. Parses `src/**` and `bin/**` with the TypeScript compiler API → the **inventory**; compares it with the registry → **coverage**. |
| `test/contract/registry.ts` | The registry: one entry per upstream `(specifier, symbol[, member])`, with the shape the host relies on. Plain data. |
| `test/contract/probe.ts`, `behaviours.ts` | Run in a sandboxed child: import every registered specifier from the **published** package and assert each entry; run the small behavioural scenarios. |
| `test/contract/modules.test.ts` | One `describe("contract: <specifier>")` per specifier; one test per symbol and per used member; plus "resolves from the published package (a `node_modules` copy at the pinned version, not a workspace link)". |
| `test/contract/coverage.test.ts` | The gate: scan the real sources, fail on any uncovered pair. It runs inside the default `bun test`, so it cannot be skipped. |
| `test/contract/http.test.ts`, `client.test.ts`, `plugin.test.ts` | The HTTP, client and plugin contracts, against a real host process / the published packages. |
| `test/contract/scan.test.ts` | Pins the scanner itself: every import form it must understand. |
| `test/contract/types.contract.ts`, `types.test.ts`, `typecheck.ts` | The type-only gate (see below). |
| `test/contract/loader.test.ts`, `fixtures/` | The plugin-loader contract that stands in for the two acknowledged dynamic imports. |
| `test/contract/drill.test.ts`, `shim.ts` | The planted-break drill. |

## How the inventory is derived

`bun scripts/contract-scan.ts` (add `--json` for stable JSON, `--inventory` to skip the coverage check,
`--root <dir>` to scan elsewhere). It walks `src/` and `bin/` and records, for every specifier that is `effect`,
`effect/*` or `@opencode/*`:

- static `import … from`, `import type`, inline `type` modifiers, `import x = require()`, `require()`;
- `export … from` / `export * from` (symbol `*`);
- dynamic `import("…")` with a **string literal**, including the shapes in use: `const { a, b: c } = await
  import("x")`, `const m = await import("x"); m.a`, `(await import("x")).a`, `.then(({ a }) => …)`;
- `import("x").Sym` in type positions; side-effect imports (symbol `(module)`);
- **members**: property/element accesses on the imported name (`Effect.runPromise`, `SessionRestart.Service`),
  type-position qualified names (`Effect.Effect<…>`, kind `type`) and destructuring (`const { runPromise } = Effect`).

Aliases are attributed to the *exported* name. Same pair from several files merges. Output is sorted.

Each inventory item demands a **contract id**: `specifier`, `specifier#symbol`, and `specifier#symbol.member`.
The scan exits **1** listing every id the registry does not name, and also every symbol the host uses at
runtime but whose contract says `type` (compile-time only).

Current inventory (host `src/` on the combined H1b + H1d tree, plus the two acknowledged dynamic imports below):

```
SPECIFIER                                 SYMBOL              MEMBERS
@opencode/core/plugin/sdk                 SdkPlugins          Service
@opencode/core/session/execution/restart  SessionRestart      Service
@opencode/plugin                          Plugin              Context(type), Plugin(type)      [type-only]
@opencode/plugin/promise/adapter          fromPromise
@opencode/server/routes                   createRoutes
effect                                    Context             get
effect                                    Effect              Effect(type), gen, runFork, runPromise, scope, sync
effect                                    Exit                void
effect                                    Layer               buildWithScope, provide
effect                                    Scope               addFinalizer, close, make
effect/http                               HttpEffect          toWebHandlerWith
effect/http                               HttpMiddleware      make
effect/http                               HttpRouter          HttpRouter
effect/http                               HttpServer          layerServices
effect/http                               HttpServerResponse  HttpServerResponse(type)
```

(`bun scripts/contract-scan.ts` prints the live table, with a covered / UNCOVERED column.)

## Adding a contract

When the host starts importing something new, the gate (`coverage.test.ts`) goes red and names the id. Fix it
in `test/contract/registry.ts`:

```ts
"@opencode/core/plugin/sdk": {
  SdkPlugins: { is: "object", members: { Service: { is: "function", check: tag } } },
},
```

- `is`: the `typeof` the host relies on (`function`, `object`, `defined`) or `type` for compile-time-only
  exports (`tsc` is their gate; the scan refuses `type` for something used at runtime).
- `arity`: `{ max }` / `{ min }` bounds on `.length` for functions. These are *tripwires*: an upstream that grows
  a required parameter fails here and is reviewed, rather than discovered in production.
- `check`: optional extra assertion over the live value.
- Behaviour the host leans on beyond "it exists" (finalizer ordering, a plugin effect running at Location boot, an
  event frame shape) goes in `behaviours.ts` or the HTTP/plugin/client tests.
- `anticipated: true` for entry points that are about to be used (checked, but not demanded by the scan). Remove it
  when `src/` imports them.

The scan also prints registry entries nothing in the sources demands (informational): those are candidates
for deletion after a refactor.

## The HTTP, client, event and plugin contracts

Run against a **real host process** (`bin/amicode-host.mjs`) in a sandbox on loopback ports **52200–52299**:

- `GET /api/info` — `version`, `pid`, `hostname`, `urls`, `paths`, `capabilities.persistentPty`.
- `POST /api/session` → `{ data: Session }` (id `ses_…`, `projectID`, `cost`, `tokens`, `time`, `title`,
  `location`); `GET /api/session` → `{ data: Session[], cursor: { previous, next } }`; `GET /api/session/:id/message`.
- `GET /api/plugin` → `{ location, data: [] }`.
- `GET /api/event` — `text/event-stream`; the first data frame is `{ id: "evt_…", type: "server.connected", data: {} }`;
  keepalives are the SSE **comment** `: heartbeat` (never a data frame), two of them 10–25 s apart (15 s cadence);
  a created session shows up as `session.created`; aborting the request releases the server-side stream.
- The published **`@opencode/client`** (resolved through the pinned `@opencode/sdk`, which is what the SDK and so the
  extension speak): `server.info()`, `session.create/list`, `plugin.list()`, `event.subscribe()` yielding
  `server.connected` first, and that a wrong password is rejected at the front.
- **Plugin registration**: `SdkPlugins.Service.register(plugin)` adds one generation, and the plugin's `effect`
  runs when a Location boots (any Location-scoped request).

## Type-only symbols

Some upstream symbols are used only as types (`Plugin.Plugin`, `Plugin.Context`, `Effect.Effect`,
`HttpServerResponse.HttpServerResponse`): there is nothing to assert at runtime, so their registry entries are
`{ is: "type" }` and their gate is the compiler. `types.contract.ts` is a small program that uses each of them the way
`src/plugins/**` and the seam do (the whole hook surface the plugin set registers on, `Plugin.Plugin` as
`{ id, setup }`, handing a plugin to `fromPromise`). `types.test.ts` compiles it with the TypeScript API — so a bare
`bun test` catches a renamed or reshaped type without a separate `tsc` run — and asserts that **every** `type`
entry in the registry is mentioned in that file. `typeCheck(file, overrides)` (`typecheck.ts`) can swap in-memory
replacements for the published `.d.ts` files, which is how the drill plants a type break.

## Underivable dynamic imports

A dynamic `import(<expression>)` whose specifier is computed cannot be tied to a package, so the scan cannot derive a
contract for it. Policy, enforced:

1. Each such site must be **acknowledged** in `DYNAMIC_IMPORTS` (`test/contract/registry.ts`): file, the expression
   text, a reason (at least a sentence), and the test that stands in for it. A site is matched by file and expression
   text, not line number, so an unrelated edit above it does not break the match (`line` is informational).
2. The scan **exits 1** and names `file:line` for any non-literal dynamic import that is not acknowledged, and
   `coverage.test.ts` fails with it. A NEW one therefore stops the build until a person acknowledges it.
   Allowances that match no site are reported as stale (informational).
3. What an acknowledgement promises is a *behavioural* contract: `loader.test.ts` runs a real host with (a) a user
   plugin file named in `AMICODE_HOST_PLUGIN_CONFIG.modules` — loaded through `plugins/index.ts`'s `import(file)` — and
   (b) an extension directory of context builders — loaded through `plugins/context.ts`'s
   `import(path.join(directory, file))`. It proves the loaded plugin registers (through `fromPromise` →
   `SdkPlugins.register`), that its `context` and `permission.evaluate` hooks fire during a real model turn (a loopback
   model on ports 52200–52299, no credentials), that its output reaches the model request, that the host's own
   permission plugin refuses a shell command by default, that cleanup runs on shutdown, and that a file that is not a
   plugin refuses the start.

Acknowledged today:

| Site | Why it is dynamic | Stand-in contract |
|---|---|---|
| `plugins/index.ts` `import(file)` (~l.84) | operator-supplied plugin module paths | `loader.test.ts` |
| `plugins/context.ts` `import(path.join(directory, file))` (~l.126) | v1 context builders from the extension directory | `loader.test.ts` |

## The planted-break drill

`drill.test.ts` runs in the default `bun test` and proves the suite can fail:

1. **Scanner drill.** Copies `src/`, plants `import { definitelyNotThere } from "@opencode/server/routes"` (plus an
   unknown specifier, an unknown `Effect` member and an unknown dynamic-import binding). The scan on the untouched
   copy exits 0; on the planted copy it exits 1 and *names* those pairs, and does not name `createRoutes`.
2. **Suite drill.** `shim.ts` builds a copy of the package with its own `node_modules`: every package is a symlink
   to the real installed one except the broken package, whose files are symlinks except the one module file the
   specifier resolves to, which becomes a shim re-exporting the real module (by absolute path) minus the broken name.
   Nothing in the real install or the shared pnpm store is touched, and the engine's own imports are unchanged:
   only the host's view of the upstream changes. The real contract suite then runs in the copy in a child `bun test`:
   - `createRoutes` removed → the `createRoutes` contract fails, the plugin probe fails, and the real host process
     cannot start (so HTTP/event/client suites fail in setup, with `createRoutes is not a function` on record), while
     the `effect` and `SessionRestart` contracts stay green;
   - `effect#Scope.close` removed → the member contract *and* the finalizer-ordering behaviour fail;
   - control: removing an unused sibling export (`createEmbeddedRoutes`) leaves the module contracts green.

3. **Plugin symbols (on the combined tree).**
   - `@opencode/plugin/promise/adapter#fromPromise` removed → its contract fails, and the real host cannot start
     (`fromPromise is not a function`), so `loader.test.ts` fails in setup; the `@opencode/server/routes` contracts stay green.
   - Type-only: `export * as Plugin` removed from the published `@opencode/plugin` declarations, or `Plugin.setup`
     renamed, in memory → `types.contract.ts` stops compiling and the diagnostics name `Plugin` / `setup`.
4. **New unacknowledged non-literal import.** A planted `import(name)` in a copy of `src/` makes the scan exit 1 naming
   `sneaky.ts:1`; the untouched copy exits 0.

To try your own: `plantBreak("pkg/specifier#symbol[.member]")` from `test/contract/shim.ts` returns `{ copy, cleanup }`;
run `bun test test/contract/modules.test.ts` with `cwd = copy`.

## How the bump bot (S1, not built yet) uses this

The bot bumps the pinned peer set (`@opencode/*` and `effect`, exact versions), installs, and runs
`bun test test/contract` plus `bun scripts/contract-scan.ts`. Green ⇒ every export, member, arity, behaviour and HTTP/event
shape the host uses survived the bump, and the PR may auto-merge to the staging lane. Red ⇒ the failing test names the
pair or endpoint that broke, which is the PR description. The scan output (`--json`) is a stable artefact to diff
between versions; the contract suite is the part that decides.

## What is deliberately NOT covered

- Anything the host does not import or call. The inventory is the host's *use*, not the upstream's surface; a break in
  an API only the engine uses internally is caught (or not) by the engine's own tests and by the end-to-end suites.
- Type-only exports are checked by `pnpm run typecheck`, not at runtime. (A bump that renames a type fails `tsc`.)
- Dynamic imports with a computed specifier have no *package* contract (see "Underivable dynamic imports"): they are
  acknowledged one by one, and what they load is proven by `loader.test.ts`, not by an export check.
- Same-named locals shadowed across scopes in one file are conflated (member accesses are attributed to every binding
  of that local name). It can only over-demand, never under-demand.
- The shape of every HTTP route: only the ones the host and the extension use (above). Ticketed WebSockets (pty, MCP),
  pairing, and the model-calling paths (no credentials exist in these tests; `OPENCODE_DISABLE_FREE_MODELS=1`).
- Performance, memory and the 15 s heartbeat *jitter* beyond the 10–25 s window.
- Behaviour of the host's own code (front, lock, registration, config): that is `test/*.test.ts`, not a contract.

## Safety envelope of the suite

Every process the suite starts runs with temp `XDG_{STATE,DATA,CONFIG,CACHE}_HOME` and `HOME`, a fresh database file,
a random password, `OPENCODE_DISABLE_FREE_MODELS=1`, loopback only on ports 52200–52299, and never the machine service
(`49374/49375`), the hub, or `~/.amico`, `~/.config/systemd`, `~/.local/share/opencode`. Break copies live under
`/tmp/opencode/h1d-break-*` and are removed afterwards.
