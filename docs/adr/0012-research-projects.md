# ADR 0012: Research Projects as a structured flavor of Project

**Status:** proposed

**Date:** 2026-08-31

## Context

"Project" in Amicode means "a directory registered with amicode" — a workstation root (canonical default: `~/armonia/`). Researchers using Amicode organically create git repos for investigations (`diraq-esr-demo`, `fluxonium-demo`) but these lack prescribed structure, manifests, or autoresearch integration. Problem workspaces (`~/.amico/problems/`) are domain-pack-specific (pulse design only) and nearly unused in practice; the autoresearch loop operates through vault session ledgers, completely disconnected from any project structure. The project selector UI (`PromptProjectSelector`, 595 lines) is fully implemented but hidden in the Amicode webview behind an `!inAmicode()` gate. External users have no concept of armonia.

## Decision

Introduce "Research Project" as a structured flavor of the existing Project concept. A Research Project is a self-contained, git-backed directory identified by `project.toml`, with a prescribed layout (`scripts/`, `data/`, `analysis/`, `paper/`, `ledger/`, `config/`, `skills/`) and a linear lifecycle (proposing → designing → running → analyzing → writing → complete). The existing git-repo model continues as "Dev Project."

### Alternatives considered

- **(B) Full redefine** — make "Project" mean only the research entity; rename the old concept to "Workspace." Rejected: breaks the glossary across CONTEXT.md, 4+ ADRs, the entire opencode session model, and the app UI. Migration cost outweighs the cleaner naming.
- **(C) New "Study" entity** — add a separate entity alongside the existing Project. Rejected: researchers think in "projects," not "studies." Two overlapping concepts creates permanent confusion.

### Key structural decisions

- **Workspace-backed selector.** The project selector is un-gated in the Amicode webview, shows workspace folders typed by `project.toml` presence, and grouped into Research and Development sections. Adding a project adds it to the VS Code workspace. Add-only; removal uses VS Code's native UI.
- **Project-specific skills.** Each research project can ship a `skills/` directory. On workspace folder changes, the extension scans for `project.toml` and adds each project's `skills/` as a skill source, triggering a `prepareOpencodeProject()` re-run. Merge priority: project > custom > workspace > shipped.
- **Gated paper-writing.** A shipped `paper-writer` skill enforces an outline-first gate: the agent refuses to write paper content until `paper/outline.md` is finalized by the user. Formatting proceeds section-by-section with user approval. Content provenance is maintained (every paragraph traces to an outline bullet). The agent does not generate novel claims, interpret results, or write the abstract.
- **Campaign ledgers.** Autoresearch execution records use `ledger/campaigns/` within the project (not vault `sessions/`), avoiding collision with the Session glossary term (one agent conversation).
- **Armonia untouched for now.** Armonia's current CONTEXT.md definition, ArmoniaService, and sidebar panel remain as-is. The future vision is to reposition Armonia as a multi-collaborator coordination layer, but that is a separate decision gated on this one succeeding.

## Consequences

### What changes

- CONTEXT.md gains Research Project and Dev Project as flavor definitions under Project
- `ProjectTable` gains `project.toml` awareness for type detection
- `PromptProjectSelector` is un-gated in the Amicode webview, enriched with type grouping and research metadata
- Skill merge chain extended with project source: project > custom > workspace > shipped
- `prepareOpencodeProject()` triggered on workspace folder changes (project add/remove)
- Autoresearch director reads the research project directory as its context source
- Campaign ledgers at `ledger/campaigns/`, not vault `sessions/`
- Problem workspaces continue for the copilot interview but are not part of the research project layout
- Multi-root workspaces supported; session binding is explicit via the selector chip, immutable after creation
- Paper writing is gated behind user-authored, user-finalized outlines; the agent is a typesetter, not a co-author

### Cross-repo impact

Skill auto-loading and session binding require changes to the opencode engine (vendored fork), which ships on its own release cadence. These are cross-repo changes that need coordinated PRs.

### Risks accepted

- **Intermediate skill visibility:** Until per-session skill scoping is implemented, all project skills from all open projects are visible to all sessions regardless of binding. This is cosmetic — it doesn't cause incorrect behavior, but it means session binding is weaker than it appears.
- **Soft behavioral gates:** The paper-writer skill's content-provenance and forbidden-actions rules are LLM instructions, not code. They work as well as the model's instruction-following allows.

### Reversibility

If Research Projects don't get adoption, the rollback is low-cost: `project.toml` is additive (ignore it and the directory is a regular git repo), the selector enrichment is behind the existing `!inAmicode()` gate (re-enable it), and the skill auto-loading is a no-op when no projects have `skills/`. The CONTEXT.md glossary additions are the hardest to undo but are also the lowest-risk (they extend, not replace). Armonia's current definition is untouched by this decision.
