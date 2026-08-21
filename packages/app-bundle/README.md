# @amicode/app-bundle — the fork-owned app overlay (M2, #451)

The M2 artifact: the Amicode app surface, carried as an **overlay** on a
pinned **canonical opencode** base — the mechanism that retires the fork at
cutover while keeping every Amicode surface.

## Slice (b) — the complete app-graph delta — SHIPPED

**Scope (corrected mid-slice)**: the complete fork-vs-base delta of the
app's build graph — `packages/{app,ui,session-ui,schema,core,sdk}` — 422
files (per-package: app 94A/105M/1D, ui 142A/22M, session-ui 8A/16M,
schema 2A/5M, core 3A/23M, sdk 0A/2M).

The planned additive-only scope **does not typecheck** — the finding that
drove the correction: ~10 additive app files depend on symbol-level
additions in modified files (`settings.developer`, `tabs.openPath`,
`model.pin`, `QuestionInfo.kind` — the typed question cards spanning
schema/core/sdk), and the fork's debug-bar deletion forces `layout.tsx`
into the overlay (base layout imports the deleted module). The fork delta
is a cross-cutting FEATURE delta, not an app-layer delta.

**The M3 cutover port inventory is machine-derived** (manifest:
`server_coupled_port_inventory`, 35 files in schema/core/sdk): every app
feature whose types or runtime live in the fork's server-side packages.
At cutover the canonical server ships NONE of these — the bundle will hit
exactly these gaps — so each is a port-upstream / extension-service /
drop decision. Recorded, not resolved.

**The true overlays** (big M-files upstream still evolves: home.tsx,
session-header, message-part, timeline, …) ride wholesale — correct for
the one-push cutover. The compose-vs-fork decomposition is deliberate
POST-cutover maintenance (`manifest.true_overlays` is the worklist).

### Proofs (all green, 2026-08-21)

1. **Equivalence** — every overlay file byte-identical to the fork's at the
   pin (round-trip verified at extraction; manifest hash-verified at
   materialization). Symlink-aware (`app/public/amico.svg` → ui asset).
2. **Composition** — `bun install` (4,695 pkgs) → `schema` typecheck →
   `session-ui` typecheck + `ui` tsc build → `app` `tsgo -b` typecheck →
   `app` **vite production build** (14.3s, 1,587 assets, Amicode surfaces
   present in the emitted bundle) → **103/103 session-ui unit tests**.

## Slice (a) — the complete `packages/ui` delta — SHIPPED

**Scope**: every file under `packages/ui` the fork changed vs the upstream
base — 164 files (142 added, 22 modified; machine-derived, see
`manifest.json`). Not a hand-picked list: `materialize(base, overlay)` is
byte-identical to the fork's `packages/ui` at the pin.

**The base correction**: the fork's true upstream base is `v1.18.12~1`
(`b0b114923`) — the 2026-08-04 merge landed upstream up to just-before the
v1.18.12 tag (whose final commit only bumps version strings). The overlay
therefore materializes onto the **v1.18.12 release tarball**; the only
base-vs-fork differences in files the overlay doesn't own are version-string
bumps in files the overlay DOES own (`package.json`). Earlier diffs taken
against v1.18.10 overcounted by folding in upstream's own 1.18.10→1.18.12
changes.

### The two proofs (both green, 2026-08-21)

1. **Equivalence** — `materialize(upstream v1.18.12, overlay)` produces a
   `packages/ui` byte-identical to the fork's at `v1.18.10-amicode.14`
   (`diff -r`: zero lines).
2. **Composition** — the materialized tree installs (`bun install`, 4,695
   packages) and builds (`tsc -p tsconfig.build.json`) cleanly, emitting 220
   files including `dist/amicode/*`.

### Usage

```sh
# re-extract the overlay from the fork at the pin (updates manifest.json)
pnpm --filter @amicode/app-bundle extract [--fork <path>] [--tag <tag>]

# materialize a full source tree: canonical base + overlay
node scripts/materialize.mjs --out <dir> [--tag v1.18.12] [--repo anomalyco/opencode]
```

The extractor reads files via `git archive` AT the tag (never the working
tree) and round-trip-verifies every file against `git show TAG:<path>` — the
manifest hashes are the contract. The materializer fetches the canonical
tarball once per tag (`.cache/`, gitignored), applies the overlay
(adds/overwrites), applies manifest deletions, and verifies every overlay
file's hash in the output.

### Later slices (docs/m2-app-extraction-inventory.md)

- (b) `packages/app` + `packages/session-ui` additive files
- (c) the true overlays (home, session-header, message-part, timeline) —
  decomposed from whole-file ownership into composable extensions where
  upstream evolution demands it
- (d) i18n tables, the debug-bar deletion, e2e port
- the consumer flip: the amicode service serves the built bundle; deck panes
  point at the service origin (CSP/`?auth_token=` wiring)
