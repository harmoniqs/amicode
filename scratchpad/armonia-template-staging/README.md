# Your Armonia vault

This is a personal **Armonia** vault — one of the repos mounted under
`~/.amico/vaults/`. Claude (via the amico-plugin skills + hooks) discovers it by
convention and resolves reads/writes across all your mounts.

The kind of this vault is set in `.amico-vault.toml` (`kind = "personal"` by
default; `armonia-init` rewrites it per `--kind`).

## What goes here

| Folder | Holds |
|---|---|
| `hopper/` | half-formed ideas, untriaged proposals |
| `specs/` | specifications you author |
| `plans/` | implementation plans |
| `experiments/` | experiment notes |
| `insights/` | distilled findings |
| `sessions/` | working-session scratch |
| `notes/` | freeform / everything else |
| `briefs/` | **written by automation** — your daily brief lands here (do not hand-edit) |

`briefs/` is populated by Notturno (the brief generator) via the git resolver —
treat it as read-only. Everything else is yours to write.

## Routing (where a note goes)

Reads search the **union** of all your mounts (first-hit wins on a name
collision). Writes route by intent (full table lives in the amico-vault skill's
"Mounts & resolution" section):

- shared spec / plan / charter → the **team** vault (`armonissima`)
- proprietary package knowledge → the **project** vault (`armonia-issimo`)
- lab / engagement state → the matching **engagement** vault
- personal notes & scratch → **here** (your personal vault)
- ambiguous → Claude asks once, then remembers

## Visibility tiers

Every note has a `visibility:` frontmatter field (default `local`):

- `local` — stays in this vault, never promoted.
- `team` — eligible for promotion to `armonissima` (dream-promote copies it,
  never moves it; the original is stamped `promoted_to` once the PR merges).
- `public` — eligible for the public vault (future).

```yaml
---
type: insight
date: 2026-06-10
visibility: team        # local | team | public  (default: local)
---
```

## Two-note authoring pattern (proprietary content)

When a note contains a proprietary **mechanism** but also a result worth sharing,
split it into two wikilinked notes instead of writing one note you can't promote:

1. A **public-safe statement** — the result, the "what", no mechanism. This one
   carries `visibility: team` and can promote to `armonissima`. It links to the
   private note via `mechanism: "[[<private-note>]]"`.
2. A **private mechanism** note — the "how", the proprietary detail. It stays
   `visibility: local` (or lives in `armonia-issimo`).

```
public-safe note (visibility: team)        private mechanism note (visibility: local)
  body: the result / claim          ──────►   body: the proprietary how
  mechanism: "[[mechanism-detail]]"           (never promoted)
```

This keeps the shareable claim promotable while the mechanism never leaks into a
team/public vault.

## Sync

A 15-minute timer (`systemd/armonia-sync.timer`) runs `armonia-sync-once`, which
pulls and (for personal vaults) commits + pushes your changes. `armonia-init`
installs both. Writes also trigger a debounced sync via the plugin's post-write
hook, so you rarely wait the full 15 minutes.
