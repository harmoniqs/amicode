---
name: amico-vault
description: Vault schema and conventions for creating, reading, and querying Amico Obsidian vault notes. Use when creating experiment notes, reading vault context, or querying the knowledge graph.
agents: [researcher, librarian, dreamer]
surface: public
vault_contract:
  folders: [experiments, insights, methods, papers, specs, plans, hopper, notes, references,
            meetings, people, orgs, sessions, briefs, templates]
  note_types: [experiment, insight, method, paper, spec, plan, system-context, device, person,
               org, meeting, hypothesis, hopper, retrospective, research-brief, charter,
               control-hardware, reference, note, project]
  frontmatter: [session_id, visibility, promoted_from, promoted_to, route_intent]
---

Vault schema and conventions for the Amico Obsidian vault. Governs all note types: experiment, insight, method, system-context, paper, device, spec, plan.

## Folder Responsibility Table

| Folder | Note Types | Naming |
|--------|-----------|--------|
| qubit-hardware-context/ | system-context | descriptive (e.g., rydberg-global.md) |
| control-hardware-context/ | control-hardware | descriptive |
| model-of-lab/ | device | descriptive (e.g., local-workstation.md) |
| experiments/ | experiment | timestamped: experiment-YYYYMMDD-HHMMSS-desc.md |
| methods/ | method | timestamped: method-YYYYMMDD-HHMMSS-desc.md |
| papers/ | paper | timestamped: paper-YYYYMMDD-HHMMSS-desc.md |
| insights/ | insight | timestamped: insight-YYYYMMDD-HHMMSS-desc.md |
| specs/ | spec | timestamped: spec-YYYYMMDD-HHMMSS-desc.md |
| plans/ | plan | timestamped: plan-YYYYMMDD-HHMMSS-desc.md |
| dashboards/ | dashboard | descriptive |
| templates/ | template | descriptive |
| meetings/ | meeting | timestamped: meeting-YYYYMMDD-HHMMSS-desc.md |
| people/ | person | descriptive: person-<name>.md |
| orgs/ | org | descriptive: org-<name>.md |
| hypotheses/ | hypothesis | timestamped: hypothesis-YYYYMMDD-HHMMSS-desc.md |
| hopper/ | hopper | timestamped: hopper-YYYYMMDD-desc.md (+ a `HOPPER.md` index) |
| retrospectives/ | retrospective | timestamped: retro-YYYYMMDD-HHMMSS-desc.md |
| research-briefs/ | research-brief | timestamped |
| charter/ | charter | numbered + descriptive (e.g. `19-visibility-doctrine.md`) |
| notes/ | note | descriptive — the catch-all tier; prefer a typed folder when one fits |
| references/ | reference | descriptive |
| sessions/ | session distillate | timestamped |
| briefs/ | brief | dated: morning-brief-YYYY-MM-DD.md |
| catalog/ | catalog entry | `catalog/pulses/<id>/metadata.toml` (+ artifact, git-lfs) |

**This table is a contract, not documentation.** It is declared in this skill's
`vault_contract` frontmatter and checked against the mounted vaults by
`tests/lint_vault_contract.sh`, in both directions: a folder here that no vault has is a
stale claim, and a note type any vault holds that is missing here is a gap an agent will
meet with no schema to follow. When you add a note type to a vault, add it here in the same
change — that is the whole point of the entanglement.

## Tag Taxonomy

- **Platform:** rydberg, fluxonium, transmon, bosonic, trapped-ion, nv-center
- **Gate:** gate/X, gate/Y, gate/H, gate/CZ, gate/CNOT, gate/CPHASE
- **Method:** method/cold-start, method/warm-start, method/free-phase, method/robustness, method/lindblad
- **Status:** status/active, status/completed, status/failed, status/blocked, status/draft, status/approved, status/executing, status/abandoned

## Mounts & resolution

The vault is no longer a single directory. A user's **Armonia** is the set of vaults mounted under `~/.amico/vaults/`, discovered by convention (every dir with a `.amico-vault.toml` marker is a mount). The session-start hook injects a "Mount stack" summary each session; follow that stack for reads and the routing rules below for writes.

### The five kinds and read precedence

| Kind | Marker | Repo naming | Holds | Writable |
|------|--------|-------------|-------|----------|
| **personal** | `kind = "personal"` | `vault-<name>` (e.g. `vault-aaron`) | Own research notes, hopper, solo specs/plans, session distillates, experiments-in-progress | single-writer (you) |
| **engagement** | `kind = "engagement"` | `vault-<engagement>` | Engagement-scoped notes; lab state (`lab.toml`, device/model-of-lab notes, calibration, per-lab catalog) once hardware deploys | engagement staff |
| **project** | `kind = "project"` | `vault-<project>` | Proprietary-package knowledge (your private package internals, hopper, insights) | per-person grant |
| **team** | `kind = "team"` | `vault-<team>` (e.g. `vault-team` / `armonissima`) | Your team knowledge tier: hardware/control context, methods + patterns, strategy/specs/plans, experiments + insights, papers, people/orgs, central pulse catalog (git-lfs) | PR-gated promotion |
| **public** | `kind = "public"` | `harmoniqs/vault-public` | Best-practice usage patterns for public packages, hazard notes, platform cards, recipes | world read-only |

**Read precedence: personal → engagement → project(s) → team → public.** Queries search the **union** of all mounts; on a path collision the higher-precedence mount wins (first hit). `mounts.toml` (in `~/.amico/`) overrides order and writability; absent, kind-order applies. A dir with no marker, a duplicate id, or a manifest `path` that doesn't exist is dropped from the mount set with a warning in the hook summary — never guessed at, never fatal.

### First-run lifecycle (auto-provision)

A fresh Marketplace install gets a working vault ecosystem with zero commands:

1. **Personal vault** — `ensureVaultEcosystem()` creates `~/armonia/data/vaults/<os-username>/` (`kind="personal"`, local `git init`, no remote) if no personal mount resolves. Offline-tolerant, never throws; activation continues unpersonalized on failure.
2. **Public vault** — shallow-clones `harmoniqs/vault-public` to `~/armonia/data/vaults/vault-public/` (`kind="public"`, `writable=false`, 10s timeout, anonymous https). On offline / no-git / timeout it creates a placeholder dir with a `kind="public"` marker so the mount stack still resolves.
3. **`mounts.toml`** — written *only if absent* (personal rw first, public ro second). Presence means user-managed — never overwritten. The same three steps are mirrored in `tools/bootstrap-armonia.sh` so CLI-first or extension-first order is safe (second run is a no-op).

The canonical on-disk root is `~/armonia/` (`repos/` = versioned source, `data/` = managed state); `~/.amico/vaults` is a symlink into `~/armonia/data/vaults` for backward compat.

### Write routing (Claude is the resolver pre-Amicode)

Route every note-write by intent:

| If the note is… | Write it to | Mechanism |
|---|---|---|
| spec / plan for **shared** work | **team** (your team vault) | PR flow |
| lab state, calibration, device params, engagement notes | **engagement** vault | direct commit |
| proprietary-package knowledge, solver hopper items | **project** vault (e.g. `vault-<project>`) | direct commit |
| personal research, sessions, scratch, solo specs | **personal** vault | direct commit (auto-synced) |
| **ambiguous** | ask the user once → default personal | — |

**`route_intent` fallback:** if the routed target isn't mounted on this machine (no engagement vault here; not a member of the project vault), write to the **personal** vault and stamp frontmatter `route_intent: <kind>` so it can be re-homed later. Never silently drop a write or write to the wrong tier.

### Visibility and the two-note authoring pattern

`visibility: local | team | public` (default `local`). Visibility is the federation gate: **only `team`/`public` notes are eligible for promotion to the company vault; `local` notes never leave their mount.**

When a note mixes a publishable claim with proprietary mechanism, **split it into two**:

1. **Public-safe statement** — the general, device-agnostic, IP-free claim. Lives in (or promotes to) the **team**/**public** vault. Frontmatter links to the mechanism: `mechanism: "[[<private-note>]]"`.
2. **Private mechanism** — the chip-identifying params, raw pulses, proprietary algorithm. Stays `visibility: local` in the **personal**/**project** vault, wikilinked back to the public-safe statement.

Never put the mechanism in a `team`/`public` note expecting a later scrub — author the split up front. (Example: a convergence-behavior insight is public-safe; the exact device-identifying parameters and raw pulse binary that produced it are `local`.)

### Promotion semantics (copy, never move)

Crystallization to the company vault is double-gated: **gate 1** = author tags `visibility: team`; **gate 2** = a human merges the dream-promote PR. On promotion:

- The **copy** lands in the **team** vault carrying `promoted_from: vault-<name>` + `promoted_date: YYYY-MM-DD`.
- The **original stays put** in its source vault and gains `promoted_to: "[[<central-note>]]"` (a frontmatter-only stamp written back *only after* the PR merges). It is never re-proposed.
- Move is wrong — copy preserves the source vault's local graph and the provenance backlink. `promoted_from`/`promoted_date`/`promoted_to` are the charter/12 provenance fields, carried over unchanged.

## YAML Frontmatter Schemas (nucleus types only)

### experiment

```yaml
type: experiment
date: YYYY-MM-DD
session_id: "uuid"
source: null | "demo-ingest" | "doc-ingest" | "agent"  # optional, omit for agent experiments
source_path: null | "path/relative/to/repo"  # optional, for ingested content
platform: "{platform}"
gate: "{gate}"
task_type: experiment | validation | regression | reproduction | parameter-study
status: running | completed | failed | stalled
fidelity: {float}
duration_us: {float}
failure_mode: null | stagnation | divergence | constraint_violation | infeasible
warm_started_from: "{catalog-id}" | null
tags: [experiment, {platform}, gate/{gate}]
```

### paper

```yaml
type: paper
arxiv: "{id}"
title: "{title}"
authors: [{authors}]
date_read: YYYY-MM-DD
session_id: null
relevance: high | medium | low
systems: [{platforms}]
tags: [paper, {platform}, ...]
```

### insight

```yaml
type: insight
date: YYYY-MM-DD
session_id: "uuid"
evidence: ["[[experiment-note]]"]
confidence: high | medium | low
tags: [insight, ...]
```

### method

```yaml
type: method
name: "{name}"
date: YYYY-MM-DD
session_id: null
applicability: [{platforms}]
tags: [method, method/{tag}]
```

### spec

```yaml
type: spec
date: YYYY-MM-DD
session_id: "uuid"
status: draft | approved | in-progress | completed | abandoned
priority: P1 | P2 | ... | null
platform: "{platform}" | null
tags: [spec, ...]
linked_plan: "[[plan-YYYYMMDD-HHMMSS-desc]]" | null
```

### plan

```yaml
type: plan
date: YYYY-MM-DD
session_id: "uuid"
status: draft | approved | executing | completed | abandoned | failed
spec: "[[spec-YYYYMMDD-HHMMSS-desc]]"
tags: [plan, ...]
```

### hypothesis

```yaml
type: hypothesis
date: YYYY-MM-DD
session_id: "uuid" | null
status: open | untested | confirmed | refuted | abandoned
platform: "{platform}" | null
evidence: ["[[experiment-note]]"]   # accumulates as tests run
tags: [hypothesis, {platform}]
```

`status` is what `/hypothesis-review` ranks on — an untriaged hypothesis is invisible to it.

### hopper

```yaml
type: hopper
date: YYYY-MM-DD
status: open | promoted | pruned
promoted_to: "[[spec-YYYYMMDD-HHMMSS-desc]]" | null
tags: [hopper, ...]
```

An idea inbox entry. It leaves the hopper in exactly two ways: promoted to a spec (stamp
`promoted_to`) or pruned with a reason. Neither is optional — an unresolved hopper item that
accumulates is the failure mode this type exists to make visible.

### retrospective

```yaml
type: retrospective
date: YYYY-MM-DD
session_id: "uuid"
outcome: success | partial | failed | abandoned
tags: [retrospective, ...]
```

### research-brief / charter / reference / note

```yaml
type: research-brief | charter | reference | note
date: YYYY-MM-DD
session_id: "uuid" | null
tags: [{type}, ...]
```

The generic tier: `date` + `session_id` + `tags` is the floor every note type meets. Reach
for `note` only when no typed folder fits — an untyped note is one nothing can query.

### system-context

```yaml
type: system-context
platform: "{platform}"
variant: "{variant}"
# ... (full schema in vault/templates/system-context.md)
```

### device
```yaml
type: device
name: "local-workstation"
status: online  # online | offline | maintenance
device_class: classical  # classical | quantum
platforms: [fluxonium, transmon, bosonic]
location: "local"
tags: [device]
```

### person
```yaml
type: person
name: "Jane Researcher"
org: "[[org-example-lab]]"
role: "Principal Investigator"
contact: null  # optional email or URL
tags: [person]
```

### org
```yaml
type: org
name: "Example Lab"
domain: "superconducting qubits"
relationship: partner  # partner | customer | academic
tags: [org]
```

### meeting
```yaml
type: meeting
date: 2026-04-02
attendees: ["[[person-jane-researcher]]"]
org: "[[org-example-lab]]"
topic: "CZ partnership scoping"
tags: [meeting]
```

## Session ID

- All agent-generated notes MUST include `session_id: "{uuid}"` from the current session
- Human-curated notes use `session_id: null`
- Used for provenance tracking and concurrent access
- Generate a UUID at the start of each session and reuse it for all notes created in that session

## Wikilink Conventions

- Use `[[note-name-without-extension]]` format
- Experiments link to: method notes used, system-context, catalog entry, plan that spawned them
- Insights link to: experiment evidence
- Papers link to: system-context where relevant
- Specs link to: linked plan, related insights that motivated the spec
- Plans link to: parent spec, experiments spawned from the plan

## Quality Checklist

Before finalizing any vault note, verify:

- [ ] Valid YAML frontmatter with `---` delimiters
- [ ] All required fields present for the note type
- [ ] `session_id` set appropriately (uuid for agent notes, null for human notes)
- [ ] Tags include at least: type tag + platform tag
- [ ] Timestamped filename if applicable (experiments, methods, papers, insights, specs, plans)
- [ ] Wikilinks to related notes present

## Provenance Chain

The full research lifecycle flows through the vault:

**insight → hypothesis → spec → plan → experiment → result → insight**

Every node should link to its neighbors via wikilinks. An experiment should link back to the plan that spawned it; a plan should link to its parent spec; insights should cite the experiments that produced them.
