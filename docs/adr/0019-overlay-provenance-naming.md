# The overlay manifest's provenance keys are named overlay_*, not fork_*

Status: accepted (2026-09-14)

After the opencode fork was absorbed (#1091) the app-bundle manifest is the
overlay's own provenance record, not a pointer at a fork. Yet three of its keys
were still named for the fork — `fork_ref`, `fork_tag`, `fork_sha` — and the
`scope` string described a "fork-vs-base delta". A reader now asks, correctly,
"which fork?" — there isn't one. This ADR records renaming those keys to
`overlay_*` and bumping the manifest schema.

**The rename.** `fork_ref → overlay_ref`, `fork_tag → overlay_tag`,
`fork_sha → overlay_sha`, and `scope` is reworded to describe the overlay's
delta against its upstream base without the word "fork". `overlay_sha` is the
load-bearing one: `build_binary.mjs` and `build_app_bundle.mjs` key the
`.materialized` cache-invalidation stamp on it, `build_binary.mjs` also writes
it into the vendored binary's `.source` sidecar as `overlay <sha>`, and
`refresh_manifest.mjs`, both `repo-sync.sh` copies, and `rebuild_amicode_check.sh`
read it. All readers are updated in the same change; a missed one would silently
corrupt the cache stamp or the `.source`/`rebuild_amicode_check` coupling.

**Schema bump, no alias.** The manifest `schema` goes 5→6 to mark the rename.
No aliasing or deprecation cycle is provided because the manifest has no
out-of-tree consumers — every reader is in this repo, verified. An alias would
be dead machinery, exactly the kind of vestige this sweep removes.

**Alternatives considered.** Renaming only `fork_sha` (the one the issue names)
was rejected — it leaves `fork_ref`/`fork_tag` behind and a half-renamed
manifest that reads worse than either extreme. Keeping `fork_sha` and
redefining "fork" in a comment was rejected: it preserves a fork-named key that
CONTEXT.md's archived-fork stance and #1091's closure criterion both argue
against. An `overlay_sha` alias with a one-cycle deprecation was rejected as
YAGNI given no external consumers.

**Consequence.** This is naming/provenance hygiene only; it changes no build
behavior. It is part of the #1118 sweep that also excises the dead fork-fetch
branch in `fetch_opencode.mjs` and corrects two stale comments — the final
closure of #1091's "no source references harmoniqs/opencode" criterion.

Implementation: harmoniqs/amicode#1118
