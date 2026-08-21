# M2 app-bundle extraction inventory

Program of record: [harmoniqs/amicode#451](https://github.com/harmoniqs/amicode/issues/451) ·
migration manifest: `docs/migration-canonical-opencode.md`.

Baseline diff: **upstream `v1.18.10` → shipped pin `v1.18.10-amicode.11`** (the vendored
binary's app surface), packages `app` / `ui` / `session-ui`:

**411 files, +40,526 / −2,249 — 235 added · 172 modified · 4 deleted.**

Generated 2026-08-20 (`git diff --name-status v1.18.10 v1.18.10-amicode.11` in
the fork; upstream tag fetched from `anomalyco/opencode`).

## Bucket A — added files (235): move as-is

| Where | Count | Notes |
|---|---|---|
| `packages/ui/src/amicode/**` | 108 | The pure-additive Amicode component library — the natural first slice |
| `packages/app/src/components/**` | 27 | App-side components (vault-browser, split-frame, status-popover-body, settings-v2/permissions, …) |
| `packages/app/src/pages/**` | 18 | Amicode pages + timeline ports |
| `packages/app/src/utils/**` | 19 | global-clipboard (+tests), amicode utils |
| `packages/session-ui/src/components/**` | 7 | message-part groups + skill parts |
| `packages/app/src/context/**` | 4 | app context additions |
| `packages/app/e2e/regression/**` | 6 | regression specs (the ported e2e suite's seed) |
| `packages/app/docs/adr/**` | 4 | the fork's ADRs — move to the amicode repo's docs |
| assets / types / misc | 8 | |

Strategy: these move into the amicode repo's app bundle unchanged. Their
imports reference sibling upstream modules — that coupling is what the bundle's
peer-dep on `@opencode-ai/*` packages resolves at build time.

## Bucket M — modified upstream files (172): the overlay pressure points

The 16 largest (the rest are small-name/import-level touches):

| File | Delta | Nature |
|---|---|---|
| `app/src/pages/home.tsx` | +2,233/−39 | the Amicode home (widget grid) grafted onto upstream's home |
| `app/src/components/session/session-header.tsx` | +671/−34 | header chrome + entity-rail dispatch |
| `session-ui/src/components/message-part.tsx` | +651/−210 | part rendering (ask cards, skill parts) |
| `app/src/pages/session/timeline/message-timeline.tsx` | +385/−23 | entity rail + AmicoSpinner mounts |
| `app/src/components/status-popover-body.tsx` | +351/−6 | solver-mode toggle + connections state |
| `app/src/components/session/session-context-tab.tsx` | +271/−3 | context tab (vault tree) |
| `app/src/utils/global-clipboard.test.ts` | +698/−0 | tests for the added clipboard util |
| `app/src/pages/session/composer/session-bug-dock.tsx` | +492/−0 | bug dock (file is added upstream-empty; content ours) |
| `app/src/components/amicode-defaults-capsule.tsx` | +475/−0 | ditto |
| `app/src/components/session/session-preview-tab.tsx` | +428/−0 | ditto |
| `app/src/components/split-frame.tsx` | +412/−0 | ditto |

A large fraction of "M" is upstream files that EXIST but whose content is
substantially ours (the +N/−0 shape) — effectively bucket-A files living at
upstream paths. The true behavioral overlays (home, session-header,
message-part, timeline, status-popover) are the files needing a compose/re-export
strategy: the bundle re-exports the upstream module with Amicode extensions
applied, rather than forking the file wholesale.

## Bucket D — deleted (4): re-delete at build

`debug-bar.tsx` (deliberate fork deletion, per AMICODE-PATCHES policy),
`link.tsx`, `notification-click.ts` (+test). The bundle's build applies these
deletions over the pinned upstream tree.

## i18n

The 72 amicode-era English keys (filled into 17 locales as EN fallbacks —
AMICODE-PATCHES 2026-08-01) live in the `language.tsx` modifications. They move
into the bundle's own locale tables, ending the upstream parity-test coupling.

## Overlay architecture (the decision this inventory implies)

1. The amicode repo gains `packages/app-bundle/` holding bucket A verbatim +
   overlay modules for the true-M files + the i18n tables + bucket-D deletions.
2. A pinned upstream checkout (canonical release tag, from
   `anomalyco/opencode`) provides the base; the bundle builds against it via
   the workspace's package graph (`@opencode-ai/ui`, `@opencode-ai/app`
   internals as peer deps).
3. CI pins the bundle to a canonical release (the same pin the updater
   manages) and fails on API drift — the recurring post-cutover cost, made
   loud at build time instead of silent at runtime.
4. Extraction order (each slice independently shippable):
   a. `ui/src/amicode/**` (108 files, zero upstream-file edits)
   b. app components with the +N/−0 shape (effectively additive)
   c. the true overlays (home, session-header, message-part, timeline,
      status-popover) — the files where compose-vs-fork judgment is needed
   d. i18n tables + deletions + e2e port

## Honest scoping note (2026-08-20, night session)

This inventory is the M2 INPUT, not the extraction. The 411-file move is the
plan's declared long pole; the slices above are estimable now that the buckets
are counted. What is NOT done tonight: the bundle itself, its build, the
consumer flip (deck panes pointing at the service origin), and the CSP/origin
wiring — all tracked as the remaining M2 scope. M3 (cutover + ≥7-day dogfood
soak) and M5 (the one-push release) are gated on M2 by design.
