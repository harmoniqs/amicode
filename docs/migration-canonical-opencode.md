# Migration manifest — ship canonical opencode, retire the fork binary

Program of record: [harmoniqs/amicode#451](https://github.com/harmoniqs/amicode/issues/451) ·
vault spec `amicode/specs/spec-20260820-044920-ship-canonical-opencode.md` ·
plan `amicode/plans/plan-20260820-044920-ship-canonical-opencode.md`.

Upstream (canonical) = **`anomalyco/opencode`** (post-rename; `sst/opencode` is a stale alias).
The fork = `harmoniqs/opencode`, branch `local/amicode`. Vocabulary per spec D4: never
user-facing "fork"; the shipped server is "canonical opencode", our ported surface is "the
Amicode service".

This manifest is the M0 deliverable: feasibility-gate evidence, the full route × consumer
inventory, the app-surface extraction inventory, and the frozen e2e quarantine list.

---

## 1. Feasibility gates — all five answered with evidence (2026-08-20)

Evidence was gathered against **stock canonical `v1.18.19`** (upstream latest, released
2026-08-20) — a binary downloaded from the public release, sha256-verified, booted in an
isolated HOME. Not source spelunking: live probes.

| Gate | Question | Verdict | Evidence |
|---|---|---|---|
| (a) | Plugin API custom server routes? | **No — M1 targets the extension-host HTTP service** | Upstream plugin surface is `Hooks` from `@opencode-ai/plugin` (tools + hooks only, loaded via `PluginLoader`); the server mounts routes exclusively through its internal Effect `HttpRouter`. The single-export legacy plugin contract we use is still supported (`getLegacyPlugins` throws on non-function exports — same constraint `amicode_tools.ts` documents). |
| (b) | Per-boot route-auth parity on a stock binary? | **Yes, natively** | Upstream `packages/opencode/src/server/auth.ts` reads `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`. Live probe: no-auth `GET /` and `/doc` → **401**; with `-u opencode:<pw>` → **200** on `/`, `/doc`, `/config`. The extension's `server_auth.ts` flow (mint password → env → Basic header) works against stock canonical unmodified. |
| (c) | Verifiable release digests? | **Yes** | The GitHub releases API carries a `digest` field (`sha256:…`) per asset. Verified: downloaded `opencode-darwin-arm64.zip` hashes to exactly the API's `sha256:0026326b…`. All three required platform assets exist (`darwin-arm64.zip`, `linux-arm64.tar.gz`, `linux-x64.tar.gz`; sizes 46–60 MB). electron-builder `latest-*.yml` files exist as a secondary digest source. |
| (d) | Iframe origin model vs extension-host service? | **Workable — one-line CSP widening + per-frame origin tracking** | The deck webview CSP is built at `deck_panel.ts` as `frame-src ${opencodeUrl.origin}` — a single-origin allowlist; adding the service origin is additive. The shell's postMessage lane checks `e.origin` against the single server origin (`deck/shell.ts`) — M1/M2 must track origin per pane once the app bundle moves. No structural blocker. |
| (e) | Adopt-gate signals on stock canonical? | **Yes — all four** | (1) `--version` → `1.18.19`. (2) Boot liveness: stderr line `opencode server listening on http://127.0.0.1:<port>` + HTTP 200 on `/doc` (authed). (3) **Plugin-load assert: a single-export legacy plugin with a module-level stamp write was imported at `serve` boot on the stock binary** — the stamp mechanism is our adopt-gate plugin check, no fork feature needed. (4) DB-compat probe rides the same boot against a DB copy (sqlite backup API), observable via (2). |

Bonus finding: the `experimental.chat.system.transform` hook — the basis of the in-flight
`amicode_context` plugin (uncommitted WIP in `extension.ts` / `opencode_config.ts`) — **exists
in stock canonical** (`packages/plugin/src/index.ts`, consumed in `agent.ts` and
`session/llm/request.ts`, covered by `test/plugin/trigger.test.ts`). The WIP is portable; it
is NOT dead code and is left untouched.

## 2. Route inventory — fork `httpapi/server.ts`, 31 routes × 18 modules

All fork Amicode routes mount in one file:
`packages/opencode/src/server/routes/instance/httpapi/server.ts` (imports at lines 72–82;
`router.add` calls). Consumers: **ext** = VS Code extension (`packages/extension/src`),
**widgets** = home-dashboard widgets (`server/amicode/widgets-src`, same-origin `amico.fetch`),
**app** = fork app UI (`packages/ui/src/amicode/*`).

| Module | Routes | Consumers | Destination |
|---|---|---|---|
| `vaults` | GET/POST `/amicode/vaults`, GET `/amicode/vault-files`, GET `/amicode/vault-file` | app (vault panel), ext | extension-host service |
| `warrants` | GET `/amicode/warrants`, POST `/amicode/approve` | app, ext | extension-host service |
| `file-resolve` | GET `/amicode/resolve-file` | app (file cards), ext | extension-host service |
| `problems` | GET `/amicode/problems`, `/amicode/problem`, `/amicode/run-status`, `/amicode/run-series`, `/amicode/run-cards` | app (entity rail, home cards, run window), ext (run inspector), widgets (now-solving, jump-back-in) | extension-host service |
| `widgets` + `widget-manifest` + `widget-runtime` + `widget-frame-html` | GET `/amicode/widgets`, `/amicode/widget-code`, `/amicode/widget-frame`; POST `/amicode/widget-fork` | app (widget grid), ext | extension-host service (serves widget frames + runtime) |
| `dashboard` | GET/POST `/amicode/dashboard` | widgets | extension-host service |
| `library` | GET/POST `/amicode/library` | widgets (library), ext | extension-host service |
| `profile` | GET/POST `/amicode/profile` | widgets (about-you, pulse-bank), ext | extension-host service |
| `connections` + `credentials` + `pasqal-secret` | GET `/amicode/connections`, `/amicode/connections/catalog`; POST `/amicode/connections/{auth,credential,revalidate,disconnect,remove,choose-project,add-custom}` | app (connections panel), ext (chat bridge) | extension-host service (credentials vault stays in the extension host — it already owns key storage) |
| `project` | POST `/amicode/project`, GET `/amicode/projects` | app (project picker) | extension-host service |
| `run-terminal` | (no dedicated amicode route — rides the PTY/httpapi surface) | ext (run controls) | extension-host service or canonical PTY API — decide in M1 |
| `solver-mode` | (no HTTP route — injected per-session via transform) | app (solver toggle) | already portable: rides the `amicode_context`-style plugin hook (confirmed on canonical) |
| `toml-lite` | (supporting lib — TOML parsing for the above) | — | ports with its consumers |

Widget sources (7, served via `/amicode/widget-frame` + `widget-code`): `about-you`,
`jump-back-in`, `library`, `meet-amico`, `now-solving`, `pulse-bank`, `showcase` — all become
extension-service assets in M1.

## 3. App-surface extraction inventory (M2)

- **`packages/ui/src/amicode/*`** in the fork — the complete Amicode UI component set:
  entity-rail, home-cards, connections (+test), widget-grid, widget-frame, widget-preview,
  widget-allowlist (+schema/bridge tests), run-series, run-window, problem, card,
  wave-geometry, and more. Extraction = move this directory into the amicode repo's app
  bundle + adapt imports to canonical's public client SDK (`@opencode-ai/sdk`).
- **Patch-stack deltas** (per `AMICODE-PATCHES.md`, the authoritative log): branding/fonts/
  accents, KaTeX macros, AmicoSpinner sites, titlebar inline tab strip, ask-card/entity-rail
  card dispatch, prompt-agnostic cassette matcher, markdown polish (~75 lines), the 72
  amicode-era i18n keys (move into our bundle — ends the upstream parity-test fight),
  deletions (side panel, `debug-bar.tsx`), `OPENCODE_CHANNEL=dev` build gate.
- **Serving**: the app bundle is served for the deck's iframes by the extension-host service
  (M1), composing upstream app components; CI pins it against canonical releases.

## 4. Frozen e2e quarantine list (frozen here — M0; per spec, additions require replanning)

1. `httpapi-v2-pty` — "serves location-wrapped PTY routes", ~1-in-3 timeout on clean upstream.
2. `project-picker-recent-search` — drives upstream's home-projects surface the fork doesn't
   render (per AMICODE-PATCHES.md 2026-08-04 entry).

Known-red-on-fork suites are NOT quarantined — they are the ported surfaces and get the
golden-fixture treatment per the spec (contract tests judged against fixtures recorded from
the running fork server): pasqal connections (8 reds), amicode widgets (15 reds).

## 5. Touch-up revision (spec amendment, honest record)

The spec's M0 item "remove the dead `amicode_context.ts` config reference" is **void**: the
reference is live WIP (the `experimental.chat.system.transform` hook plugin), the hook is
confirmed present in stock canonical, and the uncommitted `extension.ts`/`opencode_config.ts`
changes belong to it. Nothing removed. The one machine-level wrinkle — the server-bundle
config references `amicode_context.ts` while no installed VSIX ships it yet — resolves itself
when that WIP lands; not touched here.

The stale-alias touch-up lands in the same branch: `sst/opencode` → `anomalyco/opencode` in
the vendoring script defaults (`fetch_opencode.mjs`, `opencode_dev.mjs`), the test that pins
those defaults, the README links, and the report-a-bug skill's upstream-check repo identity.

## 6. Open items for M1 (carried, not blockers)

- Per-pane origin tracking in the deck shell once panes can come from two origins.
- Auth story for the extension-host service: mint a per-boot token alongside the canonical
  password (the service binds localhost; origin checks in the shell cover the iframe lane, but
  the HTTP surface wants its own 401 path).
- Port allocation + lifecycle (server-manager owns it, like the canonical server today).
- `run-terminal` destination decision (service vs canonical PTY API).
