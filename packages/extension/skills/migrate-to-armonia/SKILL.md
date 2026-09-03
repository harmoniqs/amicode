---
name: migrate-to-armonia
description: Walk a user through the full armonia migration — assess current state, run bootstrap or migrate, verify symlinks, and optionally rewrite VS Code settings. Use when the user wants to migrate to armonia, set up their workspace, or fix a broken migration.
agents: [researcher, experimenter, engineer]
surface: public
scenarios: [fresh-machine, existing-user-migrate, re-run-idempotent, partial-fix]
---

Guide the user through migrating their Amicode state from `~/.amico/` into the canonical `~/armonia/` layout. This is a one-time operation (idempotent, safe to re-run).

## Usage

`/migrate-to-armonia` — full guided walkthrough.

`/migrate-to-armonia check` — assess current state without changing anything.

`/migrate-to-armonia fix` — re-run on a partially migrated system.

The argument is: $ARGUMENTS

## Instructions

This skill orchestrates the three migration scripts (`tools/bootstrap-armonia.sh`,
`tools/migrate-to-armonia.sh`, `tools/retire-amico-symlinks.sh`) with human checkpoints
between each phase. Never run all three unattended — the user confirms each step.

### Phase overview

| Phase | Script | What it does | When to use |
|-------|--------|-------------|-------------|
| **A. Bootstrap** | `tools/bootstrap-armonia.sh --minimal` | Creates `~/armonia/` skeleton + symlink farm from `~/.amico/` | Fresh machine (no `~/armonia/` yet) |
| **B. Migrate** | `tools/migrate-to-armonia.sh` | Moves real dirs from `~/.amico/` into armonia, replaces with symlinks, copies config, scans VS Code settings | Existing user with state under `~/.amico/` |
| **C. Retire** | `tools/retire-amico-symlinks.sh` | Removes symlink farm, makes `data/config/` authoritative | Only after ArmoniaService is live (gated on marker) |

Phase C is **blocked** until `~/armonia/.armonia-active` exists (written by ArmoniaService).
The script refuses to run without it — never bypass this gate manually.

---

## Procedure

### Step 0: Assess current state

Before doing anything, run diagnostics:

```bash
echo "--- armonia ---"
[[ -d ~/armonia ]] && echo "exists" || echo "NOT FOUND"
[[ -d ~/armonia/data ]] && echo "  data/ exists" || echo "  data/ NOT FOUND"

echo "--- ~/.amico ---"
[[ -d ~/.amico ]] && echo "exists" || echo "NOT FOUND"
ls -la ~/.amico/ 2>/dev/null | head -20

echo "--- marker ---"
[[ -f ~/armonia/.armonia-active ]] && echo "ArmoniaService active" || echo "ArmoniaService NOT active (phase C blocked)"
```

Report findings to the user. Then route:

- **No `~/armonia/`** → start at Step 1 (bootstrap)
- **`~/armonia/` exists but `~/.amico/` has real dirs (not symlinks)** → start at Step 2 (migrate)
- **Both exist, `~/.amico/` is all symlinks** → already migrated; offer Step 3 check or Step 4 (retire, if marker present)
- **User said "check" or "fix"** → report state and offer the appropriate next step

### Step 1: Bootstrap (fresh machine)

Confirm with the user, then run:

```bash
bash ~/armonia/repos/amicode/tools/bootstrap-armonia.sh --minimal
```

Or if the repo isn't cloned yet (the script is curl-able):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/harmoniqs/amicode/main/tools/bootstrap-armonia.sh) --minimal
```

After completion, verify:
- `~/armonia/data/` has all expected subdirs (config, env/julia, problems, runs, vaults, library, fleet, ledger, devices, authoring, amicode)
- `~/.amico/` exists with symlinks pointing into armonia

Report the result. If the user also has existing state to migrate (repos under `~/harmoniqs/` etc.), proceed to Step 2.

### Step 2: Migrate (existing user)

**Pre-flight:** show what will happen — "This moves your real directories from `~/.amico/` into `~/armonia/data/` and replaces them with symlinks. Your config files (profile.json, cloud.json, etc.) stay in place but get copied to `data/config/` for visibility."

Confirm with the user, then run:

```bash
bash ~/armonia/repos/amicode/tools/migrate-to-armonia.sh
```

The script will:
1. Move repos from `~/harmoniqs/`, `~/_dev/harmoniqs/`, etc. into `~/armonia/repos/`
2. Move data dirs from `~/.amico/` into `~/armonia/data/`, replace with symlinks
3. Handle `ops/fleet` specially (real `ops/` dir, `fleet` symlink inside)
4. Copy config files to `data/config/`
5. **Scan VS Code settings** — it will show stale paths and prompt. Let the user decide.
6. Run a diagnostic pass — warn about unknown entries

After completion, verify:

```bash
# All should be symlinks now
file ~/.amico/julia ~/.amico/problems ~/.amico/runs ~/.amico/vaults ~/.amico/library ~/.amico/ledger ~/.amico/devices ~/.amico/authoring ~/.amico/amicode ~/.amico/ops/fleet
```

Report any warnings from the diagnostic pass. If unknown entries were flagged, explain what they are (the script never moves them — the user decides).

### Step 3: Verify

Run this to confirm everything resolves correctly:

```bash
echo "--- symlink verification ---"
for d in julia problems runs vaults library ledger devices authoring amicode; do
  if [[ -L ~/.amico/$d ]]; then
    target=$(readlink ~/.amico/$d)
    [[ -d "$target" ]] && echo "OK  ~/.amico/$d → $target" || echo "BROKEN  ~/.amico/$d → $target (target missing!)"
  elif [[ -d ~/.amico/$d ]]; then
    echo "REAL DIR  ~/.amico/$d (not migrated)"
  else
    echo "MISSING  ~/.amico/$d"
  fi
done

# ops/fleet
if [[ -L ~/.amico/ops/fleet ]]; then
  target=$(readlink ~/.amico/ops/fleet)
  [[ -d "$target" ]] && echo "OK  ~/.amico/ops/fleet → $target" || echo "BROKEN  ~/.amico/ops/fleet → $target"
else
  echo "MISSING  ~/.amico/ops/fleet"
fi

echo ""
echo "--- config files ---"
for f in profile.json cloud.json pasqal.json connections.json lab.toml mounts.toml; do
  [[ -f ~/.amico/$f ]] && echo "OK  ~/.amico/$f (real file)" || echo "(absent) ~/.amico/$f"
  [[ -f ~/armonia/data/config/$f ]] && echo "OK  data/config/$f (copy)" || echo "(absent) data/config/$f"
done
```

Report results. Any BROKEN or REAL DIR entries need fixing (re-run migrate).

### Step 4: Retire (phase C — gated)

Only offer this step if `~/armonia/.armonia-active` exists. If it does not exist, explain:

> "The retirement script can only run once ArmoniaService is live (it writes a marker file at `~/armonia/.armonia-active` on boot). This is phase C — you don't need to do anything until that ships."

If the marker is present:

```bash
bash ~/armonia/repos/amicode/tools/retire-amico-symlinks.sh
```

This removes all symlinks, moves config files from `~/.amico/` to `data/config/` (making it authoritative), and removes `~/.amico/` if empty.

### Step 5: VS Code settings

After migration, stale paths in VS Code settings will silently break skill loading,
the dev asset pipeline, or the opencode binary resolution. This step is **required**.

Read the user's settings file:

```bash
# macOS
cat ~/Library/Application\ Support/Code/User/settings.json | grep -i "amicode\|armonia\|harmoniqs"
# Linux
# cat ~/.config/Code/User/settings.json | grep -i "amicode\|armonia\|harmoniqs"
```

Check each of these keys (if present):

| Key | Old value (stale) | Correct value |
|-----|-------------------|---------------|
| `amicode.opencodeBinary` | `~/harmoniqs/amicode/…` or `~/_dev/harmoniqs/amicode/…` | `~/armonia/repos/amicode/…` (same relative suffix) |
| `amicode.devAssetRoot` | `~/harmoniqs/amicode/packages/extension` | `~/armonia/repos/amicode/packages/extension` |
| `amicode.skillRoots` | `~/harmoniqs/packages` | **Remove the key entirely** — the code default is now `~/armonia/repos/packages/`. Only set it explicitly if the user has a non-standard layout. |

For each stale entry found:
1. Show the user the current value and what it should be
2. Ask for confirmation before rewriting
3. Apply the edit (or removal) only after explicit go-ahead

If no Amicode-related keys exist in settings, report "no overrides found — code defaults are correct" and move on.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "command not found: amico-run" after migration | Binary path moved | Update `amicode.opencodeBinary` in VS Code settings |
| Skills not loading | `skillRoots` points at old `~/harmoniqs/packages` | Remove the explicit setting (code default now correct) or update to `~/armonia/repos/packages/` |
| Broken symlink under `~/.amico/` | Target dir missing in armonia | Re-run bootstrap (`--minimal`) to recreate missing dirs |
| "real dir, not empty" warning on bootstrap | Existing state not yet migrated | Run the migrate script instead |
| Unknown entries warning | Files/dirs that predate the migration scheme | Inspect manually; safe to leave or move by hand |

## Related

- **ADR 0008** (`docs/adr/0008-armonia-subsumes-amico-state.md`) — the architectural decision
- **#326** — ArmoniaService (writes the `.armonia-active` marker, enabling phase C)
- **#386** — the implementation issue for the scripts themselves
