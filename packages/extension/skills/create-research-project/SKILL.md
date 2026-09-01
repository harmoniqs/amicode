---
name: create-research-project
description: Scaffold a new research project — guided interview for research-project.toml fields, then delegate to `amico project create`. Auto-invoked by the sidebar's "+ New Project" button.
agents: []
surface: public
---

# Create Research Project

Scaffold a new research project from the sidebar's "+ New Project" button.
The button has already added the directory to the workspace; this skill
interviews the user for the `research-project.toml` fields and delegates to
`amico project create` to write the manifest, scaffold the directory tree,
and run `git init`.

## When to invoke

- Auto-invoked when the sidebar's "+ New Project" button launches a session
  with `/create-research-project --path "<dir>"`
- User says "create a research project," "scaffold a project," or similar

## Arguments

The session prompt carries:

- `--path "<dir>"` — the absolute path to the project directory (already
  selected or created in Finder and added to the workspace)

Parse this from the prompt. If missing, ask once via the `question` tool.

## Interview (one question at a time)

Use the `question` tool for every question. ONE question per turn.

### Stage 1: project name (required)

Ask: "What should I call this project?"

`kind: "text"`, `options: []`, `default` pre-filled from the directory
basename prettified (e.g. `quantum-sim` → `"Quantum Sim"`). The user can
accept or edit. This becomes the `name` field in `research-project.toml`.

### Stage 2: research question (required)

Ask: "What's the core research question for this project?"

`kind: "text"`, `options: []`. This becomes the `question` field in
`research-project.toml` — the one-liner that frames every experiment.

### Stage 3: venue (optional)

Ask: "Is this for a specific venue? (conference, journal, internal milestone — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. If not "skip" or empty,
record as `--venue`.

### Stage 4: deadline (conditional on venue)

If the user provided a venue, ask: "What's the submission deadline? (YYYY-MM-DD or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. Record as `--deadline`.

### Stage 5: collaborators (optional)

Ask: "Any collaborators? (comma-separated names, or skip)"

`kind: "text"`, `options: []`, `default: "skip"`.

### Stage 6: tags (optional)

Ask: "Tags for this project? (comma-separated, e.g. transmon, CZ, robustness — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`.

### Stage 7: domain pack (optional)

Ask: "Which domain pack? This determines the default experiment templates."

Choice question with options:
- "Quantum control (recommended)" — transmon, atoms, fluxonium, ions, bosonic
- "General" — no domain-specific templates
- "Skip" — decide later

Record as `--domain` (`quantum-control` or `general`).

## Execution

After the interview, build the CLI command and run it:

```bash
amico project create "<name>" \
  --path "<dir>" \
  --question "<question>" \
  [--venue "<venue>"] \
  [--deadline "<deadline>"] \
  [--author "<lead>"] \
  [--domain "<pack>"]
```

The `--author` flag is auto-populated from the user's profile
(`~/.amico/profile.json` `name` field) when available — do not ask for it.

The CLI is idempotent: if `research-project.toml` already exists in the
directory, it returns `created: false` and does not overwrite. In that case,
tell the user the project already has a manifest and offer to open it.

## After execution

1. Confirm success: "Project scaffolded — `research-project.toml` written,
   directories created, git initialized."
2. The sidebar's filesystem watcher will automatically re-detect the project
   as "research" type once the toml appears.
3. Offer the user a choice via `question`:
   - "Design a pulse" — invoke the `design-a-pulse` skill
   - "Set up an experiment" — open the experiment scripts directory
   - "Just explore" — no further action

## Edge cases

- **Manifest already exists:** Do not overwrite. Tell the user and offer to
  open the existing `research-project.toml`.
- **User cancels mid-interview:** Whatever was collected so far is lost (no
  partial writes). The directory remains as a "dev" project until re-run.
