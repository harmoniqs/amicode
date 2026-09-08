---
name: create-research-environment
description: Scaffold a new research environment — guided interview for research-environment.toml fields, then delegate to `amico env create`. Auto-invoked by the Command Palette's "New Environment" command.
agents: []
surface: public
---

# Create Research Environment

Scaffold a new research environment from the Command Palette ("Amicode: New
Environment") or from a chained session spawned by the `create-research-project`
or `migrate-research-project` skills. The command has already added the
directory to the workspace; this skill interviews the user for the
`research-environment.toml` fields and delegates to `amico env create` to write
the manifest, scaffold the directory tree, and run `git init`.

## When to invoke

- Auto-invoked when the Command Palette's "New Environment" command launches a
  session with `/create-research-environment --path "<dir>"`
- Chained from `create-research-project` Stage 8 or `migrate-research-project`
  Phase 6 when the user selects "Create new" environment
- User says "create an environment," "scaffold an environment," or similar

## Arguments

The session prompt carries:

- `--path "<dir>"` — the absolute path to the environment directory (already
  selected or created in Finder and added to the workspace)
- `--bind-project "<project-dir>"` (optional) — when chained from a project
  skill, the project directory to auto-bind after creation

Parse these from the prompt. If `--path` is missing, ask once via the
`question` tool.

## Interview (one question at a time)

Use the `question` tool for every question. ONE question per turn.

### Stage 1: environment name (required)

Ask: "What should I call this environment?"

`kind: "text"`, `options: []`, `default` pre-filled from the directory
basename prettified (e.g. `quantum-control-env` → `"Quantum Control Env"`).
The user can accept or edit. This becomes the `name` field in
`research-environment.toml`.

### Stage 2: system/domain (optional, free text)

Ask: "What system or domain does this environment cover? (e.g. transmon qubits, protein folding, DFT calculations — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. Environments are
domain-agnostic — this is free text, not constrained to quantum platforms.
Record as `--platform` if provided.

### Stage 3: research field (optional)

Ask: "What research field? (e.g. quantum-control, materials-science, bioinformatics — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. Record as `--field`.

### Stage 4: description (optional)

Ask: "A one-line description for this environment? (or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. This is written to the
`description` field in `research-environment.toml`.

### Stage 5: tags (optional)

Ask: "Tags for this environment? (comma-separated, e.g. shared, transmon, optimal-control — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`.

### Stage 6: GitHub remote (optional)

Ask: "GitHub remote URL for this environment? (e.g. git@github.com:org/env.git — or skip)"

`kind: "text"`, `options: []`, `default: "skip"`. If provided, run
`git remote add origin "<url>"` in the environment directory after creation.

## Execution

After the interview, build the CLI command and run it:

```bash
amico env create "<name>" \
  --path "<dir>" \
  [--platform "<system>"] \
  [--field "<field>"] \
  [--author "<lead>"]
```

The `--author` flag is auto-populated from the user's profile
(`~/.amico/profile.json` `name` field) when available — do not ask for it.

The CLI is idempotent: if `research-environment.toml` already exists in the
directory, it returns `created: false, idempotent: true` and does not
overwrite. In that case, tell the user the environment already has a manifest
and offer to open it.

If a GitHub remote was provided and creation succeeded, run:

```bash
git remote add origin "<url>"
```

in the environment directory (cwd = `<dir>`). If `origin` already exists, skip
silently.

If tags were provided, write them to `research-environment.toml` after creation
by reading the file, adding the `tags` array, and writing it back.

If a description was provided, append it to `research-environment.toml` after
creation by reading the file and adding the `description` field.

## After execution

### Standalone post-creation (default)

1. Confirm success: "Environment scaffolded — `research-environment.toml`
   written, directories created, git initialized, registered in
   `~/.amico/environments.toml`."
2. Scan the workspace for research projects that do NOT have an
   `[environment]` section in their `research-project.toml`. If any exist,
   offer multi-select binding:

   Use the `question` tool with `multiple: true`:
   "These projects in the workspace have no environment — want to bind them?"

   Options: one per unbound project (label = project name, description = path).
   Plus a "Skip" option.

   For each selected project, run:
   ```bash
   amico env bind "<slug>" --path "<project-dir>"
   ```

3. If no unbound projects exist, say "All set — the environment is ready."

### Chained post-creation (from project skill)

When `--bind-project "<project-dir>"` was passed in the prompt:

1. Confirm success (same as standalone).
2. Bind the triggering project directly:
   ```bash
   amico env bind "<slug>" --path "<project-dir>"
   ```
3. Tell the user: "Bound — switch back to the project tab and you're set."

## Edge cases

- **Manifest already exists:** Do not overwrite. Tell the user and offer to
  open the existing `research-environment.toml`.
- **User cancels mid-interview:** Whatever was collected so far is lost (no
  partial writes). The directory remains as-is until re-run.
- **`amico env create` fails:** Surface the error message from the CLI's JSON
  output and offer to retry.
- **Nesting guard:** If the target directory is inside a project or another
  environment, `amico env create` will fail with a nesting error. Surface it
  clearly: "Environments and projects must be separate repos — pick a
  directory outside any existing project or environment."
