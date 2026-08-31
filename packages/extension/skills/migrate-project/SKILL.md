---
name: migrate-project
description: Convert an existing research repo into a Research Project — scan, infer, interview, scaffold, verify. Use when a user opens a bare git repo and wants to adopt the prescribed layout without losing existing work.
agents: []
surface: public
---

# Migrate Project

Convert an existing research repository into a Research Project. The goal is
to adopt the prescribed layout (`scripts/`, `data/`, `analysis/`, `paper/`,
`ledger/`, `reports/`, `config/`, `skills/`) without breaking or hiding
anything already there.

## When to invoke

- User says "import this as a research project," "convert this repo," or
  "migrate this to the project layout"
- User opens a git repo that has research artifacts (Julia scripts, data
  directories, reports) but no `research-project.toml`
- The onset router detects a repo with optimization scripts but no manifest

## The procedure (4 phases)

### Phase 1 — Scan

Read the directory tree (max depth 3) and classify what exists:

| Look for | Maps to |
|----------|---------|
| `*.jl` scripts (especially with `using Piccolo`, `QuantumCollocation`) | `scripts/` |
| `data/`, `results/`, `output/`, `runs/` | `data/` |
| `report/`, `reports/`, `docs/`, `notes/` | `reports/` or `analysis/` |
| `paper/`, `manuscript/`, `tex/`, `*.tex` files | `paper/` |
| `*.pdf` in a papers/ or references/ folder | existing literature |
| `src/`, `lib/` (Julia modules) | source code (stays as-is) |
| `README.md`, `PLAN.md`, `TODO.md` | metadata sources for inference |
| `Project.toml` / `Manifest.toml` | Julia project (leave alone) |
| `.git/` | already version-controlled (good) |
| `figures/`, `plots/`, `images/` | `data/plots/` or `paper/figures/` |

Report what you find in a concise summary before asking questions.

### Phase 2 — Infer + interview

**Infer** from what's on disk — do not ask for information you can read:

- **Name**: from `README.md` heading, or the directory basename
- **Question**: from `README.md` body, `PLAN.md`, or doc summaries
- **Status**: from what artifacts exist:
  - Has only scripts → `"designing"`
  - Has data/results → `"running"` or `"analyzing"`
  - Has a paper draft → `"writing"`
  - Has a completed paper → `"complete"`
- **Domain pack**: from imports (`using Piccolo` → `quantum-control`)

**Ask** (one card, multiple questions) only about what you could NOT infer:

1. Research question (if README didn't have one) — `kind: "text"`
2. Status confirmation — present your inference, let them correct it
3. Any naming ambiguities — e.g., "You have `report/` (singular). The
   prescribed layout uses `reports/`. Options:"
   - Rename `report/` → `reports/` (recommended if it only has reports)
   - Keep both — `report/` stays, `reports/` is scaffolded empty
   - Symlink `reports/` → `report/`

**Do NOT ask about** things that have safe defaults:
- Tags (default: empty)
- Authors (default: from git config)
- Venue (default: none)
- Domain pack (inferred or omitted)

### Phase 3 — Scaffold

Run the CLI command with the collected information:

```bash
amico project import <dir> \
  --name "<inferred or asked>" \
  --question "<inferred or asked>" \
  --status "<inferred or confirmed>"
```

Then handle any approved renames:

```bash
# Example: user approved renaming report/ → reports/
git mv report reports   # if git-tracked
mv report reports       # if untracked
```

**Never move or rename without explicit approval.** The import command itself
is non-destructive (scaffolds missing directories, never overwrites), but
renames are destructive and require consent.

### Phase 4 — Verify + orient

After scaffolding, show the user what changed:

1. **New files created**: list them (the CLI's `scaffolded` output)
2. **Existing files untouched**: confirm nothing was overwritten
3. **Mapping summary**: "Your existing `scripts/single_qubit/` is exactly
   where it should be. Your `report/` was renamed to `reports/` as approved."
4. **Next steps**: suggest 1–2 things they can do now:
   - "Review `paper/outline.md` — I scaffolded a template; fill in your
     outline and we can start formatting the paper"
   - "Your weekly report template is at `reports/weekly/template.md`"
   - "Add this folder to your VS Code workspace to enable project skills"

## Edge cases

- **Already a Research Project** (`research-project.toml` exists): say so,
  offer to validate and fill in any missing scaffold directories
- **Monorepo with multiple projects**: ask which subdirectory to migrate;
  don't migrate the root
- **No git**: warn that `amico project create` would `git init`, but import
  does not. Suggest `git init` if they want version control
- **Conflicting names**: if a directory named `analysis/` exists but contains
  scripts (not analysis), ask before mapping it

## What this skill is NOT

- Not a project creation flow (use `amico project create` for greenfield)
- Not a data migration tool (it never moves data between machines or formats)
- Not a paper-writer (that's a separate skill, invoked after migration)
