---
name: amico-schema-check
description: Validate vault note frontmatter against type schemas. Run before dream:prune or as standalone audit.
agents: [dreamer]
surface: public
---

# Schema Check — Vault Frontmatter Validation

Validate all vault notes have correct frontmatter for their declared type.

## Vault root (`--vault-root`)

Vaults are now mounts under `~/.amico/vaults/` (see the `amico-vault` skill, "Mounts & resolution"), so the checker takes the vault to validate as an argument:

```
amico-schema-check [--vault-root <path>]
```

- `--vault-root <path>` — validate the single vault rooted at `<path>` (e.g. `~/.amico/vaults/armonia-<team>`).
- **Default (no argument)** — resolve the active mount set (every dir under `~/.amico/vaults/` with a `.amico-vault.toml` marker) and check **each mount independently**, reporting per-vault counts.

Run this before `dream:prune` or as a standalone audit, against the relevant vault root.

## Process

1. Determine the vault root(s) per `--vault-root` above.
2. Glob all `.md` files under each vault root (excluding `templates/`, `.dream-state.toml`, `dream-journal.md`, and the `archive/` subtree)
3. For each file, parse YAML frontmatter
4. Look up `type:` field and validate against schema below
5. Report: missing required fields, unknown fields, type mismatches (per vault root)

## Schemas

`amico-vault` is the single owner of these schemas — this table mirrors it, field for field (skills-integrity F10: three disagreeing copies of this table was the failure mode). Do not extend it here: when a schema changes, change it in `amico-vault` and mirror.

| Type | Required fields |
|------|----------------|
| experiment | type, date, session_id, platform, gate, task_type, status, fidelity, duration_us, tags |
| paper | type, arxiv, title, authors, date_read, session_id, relevance, systems, tags |
| insight | type, date, session_id, evidence, confidence, tags |
| method | type, name, date, session_id, applicability, tags |
| spec | type, date, session_id, status, tags, visibility |
| plan | type, date, session_id, status, spec, tags, visibility |
| hypothesis | type, date, session_id, status, evidence, tags |
| hopper | type, date, status, tags |
| retrospective | type, date, session_id, outcome, tags |
| research-brief | type, date, session_id, tags |
| charter | type, date, session_id, tags |
| reference | type, date, session_id, tags |
| note | type, date, session_id, tags |
| system-context | type, platform, variant |
| control-hardware | type, date, session_id, tags |
| project | type, date, session_id, tags |
| device | type, name, status, device_class, platforms, location, tags |
| person | type, name, org, role, tags |
| org | type, name, domain, relationship, tags |
| meeting | type, date, attendees, org, topic, tags |

- `session_id`: uuid on agent-generated notes, `null` on human-curated ones — present either way (`amico-vault`, "Session ID").
- Optional/nullable fields (experiment's `source`/`source_path`/`failure_mode`/`warm_started_from`, spec's `priority`/`platform`/`linked_plan`, hopper's `promoted_to`, hypothesis's `platform`, person's `contact`) are defined in `amico-vault` — their absence is not a schema violation.
- Types without a fuller schema (`control-hardware`, `project`) meet the generic floor every note type meets: `date + session_id + tags` (`amico-vault`, "research-brief / charter / reference / note").

## Auto-Fix Rules

These fixes are unambiguous and applied automatically:
- Missing `evidence` on insight/hypothesis → add `evidence: []`
- Missing `confidence` on insight → add `confidence: medium`
- Missing `tags` on any type → add `tags: []`
- Missing `status` on hypothesis → add `status: open`

## Flag Rules

These are ambiguous and reported for human review:
- Field name variants (`warm_started_from` vs `warm_start`) — report both, suggest canonical
- Missing `type` field entirely — cannot validate, flag as "untyped note"
- Unknown fields not in schema — report (may be platform-specific extensions)

## Escalation

Ambiguous issues are logged to `dream-journal.md` with tag `needs-human-review`. If more than 5 unfixable issues are found, route the finding to the amicissimo proposals surface (agents never edit INTENT): "Schema issues found in N notes — human review needed (see dream-journal)."

## Output

Print summary:
```
schema-check complete
  Notes scanned: N
  Valid: X
  Auto-fixed: Y (details: ...)
  Flagged for review: Z (details: ...)
```
