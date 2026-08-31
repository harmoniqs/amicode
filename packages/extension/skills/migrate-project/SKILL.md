---
name: migrate-project
description: Convert an existing research repo into a Research Project — scan, infer, interview, scaffold, verify. Use when a user opens a bare git repo and wants to adopt the prescribed layout without losing existing work.
agents: []
surface: public
---

# Migrate Project

Convert an existing research repository into a Research Project. The agent
drives the entire migration — reading files, classifying content, building a
plan, and executing approved moves. No CLI middleman for the interactive path.

## When to invoke

- User says "import this as a research project," "convert this repo,"
  "migrate this to the project layout," or similar
- User opens a git repo with research artifacts but no `research-project.toml`
- The onset router detects a repo with optimization scripts but no manifest

## Prescribed layout (target state)

```
<project>/
  research-project.toml    # manifest (schema_version, name, slug, question, status, created)
  README.md
  .gitignore
  scripts/                 # experiment scripts
    testbed/               # scratch work
  data/
    raw/                   # optimization output, raw results
    processed/             # post-processed data
    plots/                 # generated figures
  analysis/                # methodology notes, post-processing notebooks
  paper/                   # manuscript (outline.md → main.tex)
    outline.md
    main.tex
    references.bib
    figures/
    supplementary/
  ledger/
    hypotheses/            # open questions, future directions
    observations/          # experiment records, results summaries
    literature/            # reading notes
    campaigns/             # autoresearch campaign ledgers
  reports/
    weekly/                # weekly updates (template.md provided)
    presentations/         # slide decks
    milestones/            # quarterly / grant reports
  config/                  # system model, lab config, hardware reference
  skills/                  # project-specific Amico skills
```

## The procedure

### Phase 1 — Scan and classify

Read the directory tree (depth 3 max). For every file and directory, read
the first 20–30 lines and classify it using the heuristics below. Build an
internal inventory before saying anything.

#### Classification heuristics

Read the file content — do not classify by filename alone.

**Observations / results** — destination: `ledger/observations/`
- Contains fidelity numbers (`F =`, `1 - F`, `infidelity`, specific numeric results)
- Contains data tables, benchmarks, comparison tables
- Heading includes "results", "summary", "verification"
- Reports what happened in past tense ("achieved", "measured", "verified")

**Hypotheses / future work** — destination: `ledger/hypotheses/`
- Contains "future", "deferred", "open question", "TODO", "next steps"
- Lists ideas that haven't been tested yet
- Uses speculative language ("could", "might", "worth trying", "if we")
- References work not yet done

**Methodology / analysis** — destination: `analysis/`
- Contains "what worked", "guide", "optimization", "approach"
- Documents parameter choices and their rationale
- Compares approaches ("we tried X, but Y worked better")
- Has lessons-learned character ("the key insight was")

**System reference / hardware** — destination: `config/`
- Contains Hamiltonian definitions (`$H$`, `\hat H`, `H =`)
- Lists hardware parameters (frequencies, anharmonicities, coupling strengths)
- Defines the physical model, units, conventions
- Reference material that doesn't change between experiments

**Experiment scripts** — destination: `scripts/`
- `.jl` files with `using Piccolo`, `QuantumCollocation`, `Piccolissimo`
- Contains `solve!`, `UnitarySmoothPulseProblem`, trajectory definitions
- Already in `scripts/` → stays

**Raw data / run output** — destination: `data/raw/`
- `.jld2`, `.hdf5`, `.h5` files
- Directories containing `result.toml`, `run.toml`, iteration logs
- Named with timestamps or run IDs (e.g., `yang_sqrtx_20260825_103713/`)

**Plots and figures** — destination: `data/plots/` or `paper/figures/`
- `.png`, `.svg`, `.pdf` images
- If inside a `paper/` or `report/` context → `paper/figures/`
- If standalone or in a `data/` context → `data/plots/`

**Reports** — destination: `reports/`
- Progress reports, weekly updates, preliminary reports
- Contains dated summaries aimed at an audience (team, PI, collaborators)
- Distinct from observations (observations record data; reports communicate it)

**Literature** — stays or → `papers/` (no prescribed move)
- PDFs of referenced papers
- Already in `papers/` or `references/` → leave as-is

**Source code** — stays as-is
- `src/`, `lib/` with Julia modules, utility functions
- Not part of the prescribed layout — the project may have its own package

**Unclassifiable** — stays as-is
- When in doubt, do NOT propose a move
- Flag it in the plan as "unclassified — kept in place"

#### Ambiguity rules

- A file that fits two categories equally: pick the more specific one and
  note the ambiguity in the Reason column
- A directory with mixed content (e.g., `docs/` with both results and
  methodology): propose per-file moves, not a directory-level move
- A file you cannot classify after reading 30 lines: mark it "stays" with
  reason "unclassified"

### Phase 2 — Infer metadata

Read these sources for manifest fields — do NOT ask for what you can read:

**Name** (required):
1. First `# heading` in `README.md`
2. Else: directory basename, title-cased

**Research question** (required):
1. Look for a line starting with "question:", "research question:", or
   a sentence ending with `?` in the first 20 lines of `README.md`
2. Look in `PLAN.md` for an objective or question statement
3. If not found: you MUST ask (this is the one field that cannot be guessed)

**Status** (required — infer, then confirm):
- Only scripts exist, no data → `"designing"`
- Has data/results but no analysis → `"running"`
- Has analysis, methodology docs → `"analyzing"`
- Has paper draft or outline → `"writing"`
- Has completed, submitted, or published paper → `"complete"`
- Ambiguous → pick the furthest stage that has evidence, present your
  reasoning, let the researcher correct

**Domain pack** (optional — infer silently):
- `using Piccolo` or `using Piccolissimo` → `quantum-control`
- Otherwise: omit (no default)

**Author** (optional — infer silently):
- `git config user.name` in the repo, or omit

### Phase 3 — Present the migration plan

Present a single markdown table covering **every** file and directory you
found, plus every scaffold entry that will be created. This is the plan the
researcher reviews.

Format:

```markdown
## Migration Plan for [name]

**Inferred metadata:**
- **Name:** [inferred]
- **Question:** [inferred or "I need to ask"]
- **Status:** [inferred] — [one sentence of reasoning]

| # | Current path | → Destination | Action | Reason |
|---|-------------|---------------|--------|--------|
| 1 | `scripts/single_qubit/` | `scripts/single_qubit/` | stays | already in the right place |
| 2 | `data/x_gate/` | `data/raw/x_gate/` | move | raw optimization output (.jld2 files) |
| 3 | `docs/results_summary.md` | `ledger/observations/results_summary.md` | move | fidelity numbers, verification results |
| 4 | `docs/future_directions.md` | `ledger/hypotheses/future_directions.md` | move | deferred ideas, speculative language |
| 5 | `docs/optimization_guide.md` | `analysis/optimization_guide.md` | move | methodology notes, "what worked" |
| 6 | `docs/system_model.md` | `config/system_model.md` | move | Hamiltonian, hardware params |
| 7 | `report/` | `reports/` | rename | singular → plural to match layout |
| 8 | `src/` | `src/` | stays | Julia modules, outside prescribed layout |
| 9 | `papers/yang_2020.pdf` | `papers/yang_2020.pdf` | stays | literature, keep as-is |
| 10 | `Project.toml` | `Project.toml` | stays | Julia package manifest |
| — | `analysis/` | — | scaffold | empty, new directory |
| — | `paper/outline.md` | — | scaffold | template with inferred question |
| — | `paper/main.tex` | — | scaffold | minimal article template |
| — | `ledger/campaigns/` | — | scaffold | empty, for autoresearch |
| — | `reports/weekly/template.md` | — | scaffold | weekly update template |
| — | `config/system.toml` | — | scaffold | stub |
| — | `research-project.toml` | — | scaffold | manifest |
```

Then ask ONE question:

> "Here's my migration plan. Review the table — tell me which moves to
> change, skip, or redirect, and I'll adjust. Or say 'looks good' to
> proceed."

If the researcher requests changes, **update the plan table and re-present
it** — do not execute a partial plan. Iterate until they approve.

### Phase 4 — Execute

Once the researcher approves the plan, execute it in this order:

1. **Create scaffold directories** — `mkdir -p` for every "scaffold" row
2. **Move files** — for each "move" row:
   - `mkdir -p` the destination's parent directory
   - If the file is git-tracked: `git mv <src> <dst>`
   - If untracked: `mv <src> <dst>`
3. **Rename directories** — for each "rename" row:
   - If git-tracked: `git mv <old> <new>`
   - If untracked: `mv <old> <new>`
4. **Write scaffold files** — write `research-project.toml`, `README.md`
   (only if none exists), `paper/outline.md`, `paper/main.tex`,
   `reports/weekly/template.md`, config stubs, `.gitignore` files.
   **Never overwrite an existing file.**
5. **Write `research-project.toml`** directly — use the schema from the
   entity slice:
   ```toml
   schema_version = 1
   name = "<from plan>"
   slug = "<kebab-case of name>"
   question = "<from plan>"
   status = "<from plan>"
   created = "<today YYYY-MM-DD>"
   ```
6. **Commit** — one commit with a descriptive message:
   ```
   feat: migrate to research project layout

   Moved:
   - docs/results_summary.md → ledger/observations/
   - docs/future_directions.md → ledger/hypotheses/
   - ...
   Scaffolded: analysis/, paper/, ledger/, reports/, config/, skills/
   ```

### Phase 5 — Verify and orient

After execution, show the researcher:

1. **What moved** — list each move with old → new path
2. **What was created** — list scaffolded directories and files
3. **What stayed** — confirm nothing was overwritten or lost
4. **Empty directories cleaned** — if a directory (e.g., `docs/`) is now
   empty after all its files were moved out, note it: "docs/ is now empty —
   you can remove it or keep it"
5. **Next steps** — suggest 1–2 concrete actions:
   - "Review `paper/outline.md` — fill in your outline sections and the
     paper-writer skill can help format it"
   - "Your weekly report template is at `reports/weekly/template.md`"
   - "Add this folder to your VS Code workspace to get project-aware skills"

## Edge cases

**Already a Research Project** (`research-project.toml` exists):
Say so. Offer to re-scan and scaffold any missing directories, or to
re-classify content that's in the wrong place.

**Monorepo / multi-project directory:**
If the root has multiple independent research directories, ask which one to
migrate. Do not migrate the root.

**No git:**
Warn the researcher. Offer to `git init` before migrating (so moves get
history). If they decline, use plain `mv` for everything.

**Mixed-content directories:**
When a directory like `docs/` has files that belong in different places,
propose per-file moves in the plan table — never move the whole directory.

**Name collision on move:**
If a destination file already exists (e.g., the researcher already has
`analysis/optimization_guide.md`), flag it in the plan: "destination exists
— skip or overwrite?" Default: skip.

**Large data directories:**
Don't read inside directories with 50+ files — classify by the directory
name and a sample of 3 filenames. Note: "sampled, not fully read."

## What this skill is NOT

- Not for greenfield projects (use `amico project create` for new work)
- Not a data migration tool (no cross-machine, no format conversion)
- Not the paper-writer (invoke that after migration if the researcher wants
  to start writing)
- Not a renaming enforcer — if the researcher says "keep `docs/` as is,"
  respect that unconditionally
