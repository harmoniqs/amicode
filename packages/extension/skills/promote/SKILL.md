---
name: promote
description: On-demand promotion of specific vault notes (specs, plans, insights, methods, …) from a personal/project mount up to the company vault (the `kind = "team"` mount) via a PR, immediately. The interactive counterpart to the nightly dream-promote. Use when a teammate needs to read something you just authored, when a shared spec/insight must land in the team vault now, or any time you'd otherwise hand-clone the team vault to copy notes across.
agents: []
surface: public
---

# Promote — On-Demand Cross-Vault Promotion

> **Provenance:** salvaged from `harmoniqs/amico-plugin` PR #45 (repo archived
> 2026-08-26) — ruled SALVAGE in amicode#850, ported in amicode#851. Semantics
> follow the `amico-vault` skill's "Promotion semantics" section unchanged.

Promote **named** notes from a personal/project mount up to the company vault
(the `kind = "team"` mount — e.g. `armonissima`) **right now**, via one focused
PR — copying (never moving) with provenance, deduping against what's already
central, and stamping the source's `promoted_to` after merge.

This is the **interactive** counterpart to the nightly `dream-promote` flow:

| | `dream-promote` (nightly) | `promote` (this skill) |
|---|---|---|
| Trigger | nightly dream cycle | on-demand, you invoke it |
| Selection | every `visibility: team` note changed since `.dream-stamp` | the **specific notes** you name (or the current conversation's specs/notes) |
| Batch | ≤10/vault, one PR per vault | just the notes you asked for, one focused PR |
| When | eventual federation | a teammate is waiting *now* |

Both obey the **same promotion semantics** (see the `amico-vault` skill's
"Promotion semantics" section): **copy never move**, `promoted_from`/`promoted_date`
on the copy, `promoted_to` stamped back on the source **only after merge**, and
generalize-don't-leak. This skill does not replace `dream-promote` — it's the fast
path for "I need this in the team vault today."

**Announce at start:** "I'm using the promote skill to push these notes to the team vault."

## When to use

- A teammate asks to read a spec/insight/note you authored in your personal vault.
- You just finished shared work that belongs in the team vault (per the `amico-vault`
  write-routing rule: *specs/insights for shared work → team vault, PR flow*).
- Any time you'd otherwise hand-run clone → branch → copy → PR against the team vault.

## Inputs

`$ARGUMENTS` is either:
- explicit note paths (absolute, or vault-relative under a source mount), or
- a description like "the two GPU-opt specs and their plans" / "this session's
  spec + notes" — resolve these to concrete files with the user before proceeding.

If ambiguous, list the candidate files you resolved and confirm before writing anything.

## Instructions

### Step 0 — Resolve target, source, and the note set

- **Target** is always the team vault (the `kind = "team"` mount — resolve it
  from the mount stack, `~/.amico/vaults/`, per the `amico-vault` rules; e.g.
  `armonissima`). Confirm it is mounted. If not, stop.
- **Source** is the personal/project mount each note lives in.
- Resolve every input to a concrete `*.md` path that exists on disk. Print the
  resolved list (source path → intended target folder) and confirm.

### Step 1 — Gate + scrub (gate 1: this is shareable)

For each note:

1. **Shareability.** Confirm the note is *meant* to be team-visible. If it's
   proprietary mechanism (chip params, raw pulses, private algorithm), **do not
   promote it** — apply the two-note pattern (`amico-vault` → "Visibility and the
   two-note authoring pattern"): promote only the public-safe statement, keep its
   `mechanism: "[[<private-note>]]"` link into the source mount.
2. **Set `visibility: team`** on the **source** note's frontmatter if missing
   (this is gate 1, and it makes the note eligible for future `dream-promote`
   runs too). Frontmatter-only edit.
3. **Generalize** — strip engagement/partner names, device serials, chip-identifying
   params from the copy that will land central. If you cannot confidently scrub it,
   **flag it and stop** rather than promote a leaky copy.

### Step 2 — Fresh clone of the team vault (never the local mount)

The local team-vault mount is read-only, often stale, and can be dirty/detached
— **do not commit from it.** Clone fresh from the vault's git remote, skipping
LFS blobs (you're only adding markdown; the catalog is git-lfs):

```bash
WORK="${TMPDIR:-/tmp}/team-vault-promote-$$"
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 git@github.com:harmoniqs/<team-vault>.git "$WORK"
```

### Step 3 — Dedup against main (add | update | enrich)

For each note, check whether a central copy already exists (by filename **and** by
title grep — mirrors `dream-promote` Step 3):

```bash
ls "$WORK"/**/*.md 2>/dev/null | xargs -n1 basename | grep -ixF "<filename>"
grep -rilF "<title>" "$WORK" --include='*.md'
```

- **Not present** → *add* (Step 4).
- **Present, you're refreshing it** (e.g. spec you edited since it was first shared)
  → *update* in place (overwrite the central copy with the current source content,
  keeping/refreshing provenance frontmatter).
- **Present as a near-duplicate of a differently-named note** → *enrich* the
  existing central note (add the new evidence/link) rather than adding a twin.

### Step 4 — Copy into the matching folder + provenance + cross-links

- Copy each note into the team vault's folder **mirroring its type**: specs →
  `specs/`, plans → `plans/`, insights → `insights/`, methods → `methods/`,
  hopper → `hopper/`, …. Preserve the timestamped filename.
- Stamp the **central copy's** frontmatter:
  ```yaml
  visibility: team
  promoted_from: <source-vault-name>   # vault of origin (the amico-vault charter/12 provenance field)
  promoted_date: <YYYY-MM-DD>          # pass the date in; scripts can't call date-now reproducibly
  ```
- **Fix cross-links so wikilinks resolve inside the team vault.** If you're
  promoting a spec *and* its plan together, make sure the spec's
  `linked_plan: "[[plan-…]]"` and the plan's `spec: "[[spec-…]]"` both point at the
  now-co-located notes. If a `mechanism:` link points back into a private mount,
  leave it (it's an intentional backlink).

### Step 5 — Branch, commit, push, PR

```bash
cd "$WORK"
git checkout -b "promote/<slug>"          # <slug> = short kebab description of the set,
                                          # NOT a vault name — dream-promote owns promote/<vault>
git add <the copied/updated files...>
git -c user.name="<author>" -c user.email="<author-email>" commit -F - <<'MSG'
docs: promote <what> to the team vault

<one-line why + provenance: drafted/reviewed where, promoted_from which vault>
MSG
git push -u origin "promote/<slug>"
gh pr create --base main \
  --title "promote: <what>" \
  --body "<what's here, why, provenance, and any review asks>"
```

Return the **PR link** and direct blob links to each promoted note on the branch
(teammates can read them immediately without waiting for merge).

- **Branch name** `promote/<slug>` must use a content slug (e.g.
  `promote/gpu-opt-plans`), never a vault name — that namespace belongs to
  `dream-promote`'s per-vault branches, and colliding would cross the two flows.
- Sending outward-facing content: confirm with the user before opening the PR
  unless they've already said "push it" / "promote it."

### Step 6 — After merge: stamp `promoted_to` back on the source

Once the PR merges, stamp each **source** note (frontmatter-only) so it's never
re-promoted (by you or by `dream-promote`):

```yaml
promoted_to: "[[<central-note-name>]]"
```

Commit on the source vault's default branch
(`promote: stamp promoted_to after merge (<central-note>)`). If you can't confirm
the merge yet, say so and leave the stamp for a follow-up — `dream-promote`'s
filename/title dedup is the safety net that prevents a duplicate in the meantime.

## Quality bars

- **Copy, never move.** The source stays put; only `promoted_to` is written back,
  only after merge.
- **Fresh clone, never the local mount.** The `ro` mount is stale/dirty; committing
  from it risks dragging in unrelated working-tree changes.
- **Generalize, don't leak.** Can't confidently scrub proprietary specifics → flag
  and stop, don't promote a leaky copy.
- **Dedup before adding.** Update/enrich an existing central note rather than
  creating a near-twin.
- **One focused PR.** Promote the set the user asked for; don't fan out or bundle
  unrelated notes.
- **Fix the cross-links.** Co-promoted spec↔plan (and any wikilinks) must resolve
  inside the team vault, or the team vault graph breaks.

## Relationship to authoring

The root cause of "I keep having to promote by hand" is shared notes being authored
`visibility: local` (the default) in a personal mount. `brainstorming` tags shared
research **specs** `visibility: team` at authoring time, and the `amico-vault`
spec/plan schemas document the field — so `dream-promote` eventually federates them
automatically, and this skill is for when "eventually" isn't fast enough.
(`visibility` applies to any note type you promote.)
