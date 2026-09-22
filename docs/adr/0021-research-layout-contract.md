# ADR 0021: Research layout is a resolved contract, not a fixed directory tree

**Status:** proposed

**Date:** 2026-09-15

## Context

ADR 0012 introduced the Research Project as a git-backed directory with a *prescribed* layout (`scripts/`, `data/`, `paper/`, `ledger/`, `reports/`, `config/`, `skills/`) and a linear lifecycle; #880 added the Research Environment as a *separate* git repo holding shared knowledge (`insights/`, `methods/`, `context/`, `literature/`, `lib/`, `templates/`, `config/`), bound to projects by `[environment].slug`. Both are useful, and the opinionated layout is exactly what a focused, organized Harmoniqs research method wants.

But the same single opinion is welded into four independent layers, and users organize research in ways it forbids:

- **Detection** (`stack_state.ts`, `detect.ts`) stats the manifest at each **workspace-folder root only** — no walk-up, no subdirectory scan — and takes the first match. A project one level down, or a project nested inside an environment repo, is invisible.
- **Environment resolution** (`resolve_environment.ts`) is documented "multi-repo only — monorepo topology is not supported," binding by slug across sibling workspace folders or the global registry.
- **CLI creation** (`checkNestingViolation`) actively refuses to create an environment inside a project or another environment ("must be separate repos"). The guard is also one-directional: `project create` has no equivalent guard, so a project can already be scaffolded inside an environment — just not detected.
- **The scaffold layout is a frozen constant** (`SCAFFOLD_DIRS`) repeated as a hard-coded literal in the injected prompt block and again as a paths table in the `research` skill. The environment schema *declares* a `[paths]` override but nothing reads it; the project schema has no `[paths]` at all.

Researchers want the freedom to lay this out differently: several projects inside one environment repo (monorepo), a single standalone repo with no separate environment, or their own directory names on an existing repo they will not reorganize. Meanwhile the Research agent still needs enough structure to know where campaign ledgers, hypotheses, observations, specs, scripts, and shared knowledge live.

Two defects compound the problem and must be fixed as part of this work:

1. **The injected context blocks are dead in production.** `AMICODE_WORKSPACE_FOLDERS` and `AMICODE_RESOLVED_ENVIRONMENT` (read by the plugin) are set only in the server-auth env builder, and no server-spawn site passes them. So today the Research agent receives *no* project/environment context at all — the structure we believe we deliver is not delivered.
2. **Source-of-truth inconsistency.** The `research` agent card says "the vault is the database" (state in the personal vault's `sessions/`); the `research` skill says "the project is the database" (state in `<project>/ledger/`). The two disagree about where a research session's load-bearing state lives.

## Decision

Reframe the layout as a **resolved contract**: the Research agent consumes a map of logical role → path (where campaign ledgers go, where hypotheses/observations/specs/scripts/data live, where the checkout registry is, where shared knowledge lives), and the harness resolves that contract from the manifests. The physical arrangement of repos and folders becomes the user's choice; the contract stays constant.

- **A default contract equals today's layout, byte-for-byte.** A project or environment with no `[layout]` and no `[paths]` behaves exactly as it does now. This is the safety guarantee and the Harmoniqs default.
- **`[paths]` overrides individual roles.** The mechanism the environment schema already declares becomes real, and is extended to the project manifest. A researcher can rename `ledger/` → `notes/` or point `experiment_scripts` at `src/` without the agent losing its way.
- **A `[layout]` block selects a profile.** Three profiles, all reducing to the same resolved contract:
  - `separate` (default) — today's multi-repo behavior, unchanged.
  - `monorepo` — one environment repo declaring child project roots; nesting is *permitted in this mode only*.
  - `standalone` — a single repo, environment-optional, with shared-knowledge roles resolved in-repo.
- **Discover-then-persist.** For an existing repo, the harness scans, infers the role→directory map and any child projects, and writes the `[layout]`/`[paths]` declaration back into the manifest so the arrangement is explicit thereafter. Migration gains an "adopt in place" path alongside today's "reorganize."
- **The contract is resolved by the extension and injected as data.** The extension computes the resolved contract (project ⊕ environment ⊕ overrides) and passes it to the server spawn as JSON; the plugin renders whatever it is handed rather than printing a fixed literal. This closes the dead-wire defect and keeps the dependency-free plugin free of a TOML parser.
- **Source of truth is resolved by project-active.** When a Research Project is resolved, the project is the database; otherwise the personal vault's `sessions/` is. Both the agent card and the skill state this same rule.

### Alternatives considered

- **Keep the fixed layout; document workarounds.** Rejected: the coupling is in code at four layers, so "workarounds" means the agent silently loses context (or the CLI refuses) whenever a user deviates. The dead-wire defect means the status quo does not even deliver the fixed layout today.
- **Full polymorphic layout engine (arbitrary user-defined roles, pluggable resolvers).** Rejected as over-built for the need. The role set is small and stable; a fixed role vocabulary with per-role path overrides and three named profiles covers the observed demand without a plugin surface.
- **Monorepo by filesystem discovery only (no declaration).** Rejected as too magical for a system whose whole point is giving the agent reliable structure. Chosen instead: discover *then persist* — infer once, write the explicit declaration, operate on the declaration.

### Key structural decisions

- **Fixed role vocabulary, overridable paths.** The contract's roles are a closed set owned by this ADR; only their paths are user-overridable. Skills declare which roles they need (the dormant `project_contract.folders` frontmatter becomes the declaration), validated against the resolved contract.
- **Walk-up detection.** Session binding discovers the nearest ancestor `research-project.toml` (git-style), decoupling "project root" from "workspace-folder root." The fast root stat remains for sidebar typing.
- **Nesting guard is profile-aware.** Nesting is rejected under `separate`/`standalone` (in both directions — fixing the current asymmetry) and permitted under a declared `monorepo`.
- **Monorepo children reuse the existing environment grouping.** Child projects get their `environment.slug` set and nest under the environment in the sidebar's existing slug-keyed grouping; no new grouping mechanism is introduced.
- **Default conventions.** Monorepo children default to `projects/<slug>/`; the checkout registry stays per-project (campaign-scoped); a standalone repo keeps the environment directory names at its root so it is a clean superset that can later split into a separate environment.

## Consequences

### What changes

- A contract module (default constant + resolver) is added to the harness; the project and environment manifests gain `[paths]` and `[layout]`.
- The plugin renders the Active Research Project block from the resolved contract; the extension resolves and passes the contract into the server spawn, closing the dead-wire defect.
- Detection gains walk-up; environment resolution gains a monorepo strategy; the nesting guard becomes profile-aware and symmetric.
- The CLI gains `--profile`/`--layout` and a discover/adopt path; the create/migrate skills gain a profile choice and adopt-in-place.
- The `research` skill references the resolved contract instead of a fixed table; the `research` agent card and the skill are reconciled on the project-vs-vault source-of-truth rule.
- CONTEXT.md's Research Project and Research Environment glossary entries note that layout is a profile with `separate` as the default.

### Cross-repo impact

The plugin (vendored engine overlay) and the extension both change and ship on their own cadences; the contract JSON passed at spawn is the seam between them and must stay version-tolerant (an older plugin ignores unknown roles; an absent contract falls back to the default constant).

### Risks accepted

- **Config surface creep.** More knobs means more ways to misconfigure. Mitigated by making every knob optional with the Harmoniqs default, and by validating the resolved contract against each skill's declared role needs.
- **Discovery misclassification.** Inferring roles from an existing repo can guess wrong. Mitigated by persisting the inferred declaration for the user to review and edit, never operating on a silent guess.
- **Soft behavioral reconcile.** The source-of-truth rule is prompt text in two cards; it works as well as the model's instruction-following allows, as with the existing gates.

### Reversibility

Additive and low-cost to roll back. `[paths]`/`[layout]` are optional; absent them, the default contract equals today's layout, so an unmodified project/environment is unaffected. The contract-injection seam degrades to the default constant when the contract is absent. The walk-up and profile-aware guard are the hardest to revert but are gated on the presence of a `[layout]` profile other than `separate`. The glossary additions extend, not replace.
