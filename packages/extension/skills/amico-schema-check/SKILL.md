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

| Type | Required fields |
|------|----------------|
| experiment | type, task_type, date, session_id, platform, gate, fidelity, duration_us, status, tags |
| insight | type, date, source, evidence, confidence, tags |
| hypothesis | type, date, source, status, evidence, tags |
| method | type, name, date, source, applicability, tags |
| paper | type, date, arxiv, authors, tags |
| spec | type, date, status, priority, platform, tags |
| plan | type, date, status, tags |
| retrospective | type, date, tags |
| person | type, name, org, role, tags |
| org | type, name, tags |
| device | type, name, status, platforms, tags |
| meeting | type, date, attendees, tags |

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

Ambiguous issues are logged to `dream-journal.md` with tag `needs-human-review`. If more than 5 unfixable issues are found, append to STRATEGY `## Agent Suggestions`: "Schema issues found in N notes — human review needed (see dream-journal)."

## Output

Print summary:
```
schema-check complete
  Notes scanned: N
  Valid: X
  Auto-fixed: Y (details: ...)
  Flagged for review: Z (details: ...)
```
