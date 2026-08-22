# Armonia subsumes ~/.amico — symlink farm now, ArmoniaService retirement later

Status: accepted (2026-08-14)

All amicode product state migrates from `~/.amico/` into `~/armonia/data/`. The
`~/.amico/` directory becomes a backward-compatible symlink farm (phase B) that is
retired by a user-run cleanup script once ArmoniaService resolves paths directly
(phase C). Opencode's XDG paths (`~/.config/opencode/`, `~/.local/share/opencode/`)
are untouched — they belong to the engine, not the product.

**Why:** `~/.amico/` accumulated ~15 distinct paths organically. Issue #326 (Armonia
as default workspace) needs a single tree it can browse, watch, and resolve against.
Leaving state scattered across two roots (`~/armonia/` for repos+artifacts,
`~/.amico/` for everything else) means the sidebar can never show the full picture
and the session cwd story has a permanent asterisk. Subsuming everything under
armonia gives one tree, one backup target, one mental model.

**Why a symlink farm (not a code refactor first):** the codebase has ~30 call sites
that resolve `homedir() + ".amico" + X`. Rewriting them all requires ArmoniaService
(#326) which is a substantial PR. The symlink farm makes the filesystem migration
zero-breakage today — every existing path resolves transparently — while the code
catches up at its own pace.

**Why config files stay as real files at `~/.amico/` (not symlinked):** file-level
symlinks break if the target is deleted and recreated (the symlink becomes dangling
and a new real file appears at the original path). Credential files like `cloud.json`
are written atomically (delete + rename) by multiple code paths. Directory symlinks
do not have this problem — `readdir` follows them transparently.

**Considered:**

- **(A) `~/.amico/` stays canonical, armonia is browse-only** — rejected: perpetuates
  two roots, the sidebar is a projection of reality rather than reality itself, and
  "where does X live?" remains a question with two answers.
- **(B) Single symlink `~/.amico → ~/armonia/data`** — rejected: forces a flat layout
  inside `data/` that matches `~/.amico/`'s structure exactly, blocking any
  reorganization (e.g. `data/config/`, `data/env/julia/`).
- **(C) Immediate code refactor (no symlink phase)** — rejected: blocks the migration
  on #326 and a ~30-site refactor; users cannot benefit until both land.

**Chosen: (D) symlink farm now, retirement script gated on ArmoniaService.** The
retirement script (`tools/retire-amico-symlinks.sh`) ships in the same PR and checks
for a marker file (`~/armonia/.armonia-active`) written by ArmoniaService on boot
before it will run. This ensures the user cannot accidentally retire the symlinks
while the code still reads through them.

**Layout after migration:**

```
~/armonia/data/
  config/       profile.json, cloud.json, pasqal.json, connections.json, lab.toml, mounts.toml
  env/julia/    the provisioned Julia project
  problems/     problem workspaces
  runs/         run output
  vaults/       mounted vaults
  library/      uploaded papers
  fleet/        fleet registry + tunnel state
  ledger/       runs.jsonl, claims.jsonl, approvals/
  devices/      calibration state
  authoring/    authoring.json
  amicode/      entitlements, solver mode
```

**Exit condition (phase C):** all `homedir() + ".amico" + X` callers migrated to
`ArmoniaService.resolve()`, ArmoniaService writes `~/armonia/.armonia-active` on
boot, the retirement script passes its gate check, and the user runs it. Phase C is
a separate issue gated on #326 with the `hitl` label.
