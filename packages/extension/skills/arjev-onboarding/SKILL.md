---
name: arjev-onboarding
description: Set up arJev (a daily arXiv digest ranked against an Obsidian vault) for a researcher — install, vault adoption or init, the feeds interview, seeding from Google Scholar/Zotero/PDFs/Slack, their own Jev and Slack credentials, the daily timer, and verification gates. Use when the user asks to set up arJev, get a daily paper digest or paper recommendations, or seed their vault with their existing library.
agents: []
surface: public
---

# arJev Onboarding

arJev is Harmoniqs' daily arXiv digest engine: it ranks the full multi-feed union
against a researcher's **living Obsidian vault** every day, so the picks improve as
the vault grows — the user is the training data. You are setting it up on this
person's machine, on their behalf. The repo is `github.com/harmoniqs/arJev`
(Apache-2.0); its agent-setup runbook
(https://github.com/harmoniqs/arJev/blob/main/docs/agent-setup.md) is the full
reference — this card is self-contained; read the repo docs only if the user has
the clone.

What you are building:

```
their Obsidian vault (taste, records, ground truth)
    → daily digest (ranked against the vault) → stdout / vault / Slack
    → keeps scaffold back into the vault (status: staged)
    → YOU write the staged notes' prose (status: written) → taste grows
    → weekly calibration report (labels vs predictions)
```

Division of labor: **the decision model judges, you write, the vault stays theirs.**
The ranking model (Jev, from TypeSafe AI) is text-free by design; every piece of
prose in the loop is yours or the human's.

Invariants you must respect:

- Never edit an existing note through the tool (arJev writes new files only; the
  single exception is `arjev rate accept`, a human-invoked gate).
- Keys/tokens live in env vars or mode-600 files — never in configs, the vault,
  or a repo. **Always the user's own credentials** — their TypeSafe account, their
  Slack workspace; never keys from anyone else's setup.
- Runtime artifacts go under the XDG state dir (`~/.local/state/arjev/`), never
  inside a repo or the vault.
- arJev ranks **only** the arXiv categories the user configures — never guess a
  default category; an empty `feeds` blocks the digest by design.

## Stage 0 — preconditions

- Python 3.11+ and `uv` (or `pipx`). Check: `uv --version`.
- A vault path: either an existing Obsidian vault with literature notes, or a
  fresh empty directory for one. Ask which if not already known.
- What they already have (ask in the interview, Stage 2): a Google Scholar or
  Zotero library, a PDF collection, a Slack channel where their group shares
  papers — any combination seeds the vault.

## Stage 1 — install

```bash
uv tool install git+https://github.com/harmoniqs/arJev@v0.4.0
```

**Gate:** `arjev --version` prints a version.

## Stage 2 — the interview (ONE question at a time, always via the `question` tool)

1. **Field** → their arXiv categories from <https://arxiv.org/category_taxonomy>
   (e.g. a condensed-matter researcher: `cond-mat.mes-hall`, `cond-mat.str-el`;
   an econometrician: `econ.TH`, `econ.GN`). Never default.
2. **Vault state** → extant literature notes (Stage 3A: adopt) or none (Stage 3B:
   `arjev init`). Ask where the notes live.
3. **Schema** (extant only) → read two or three of their real notes' frontmatter
   before configuring anything.
4. **Taste** → what they want more of, less of (Stage 4 drafts it; they edit).
5. **Seeds** → which of Scholar / Zotero / PDF folder / Slack channel they have.

## Stage 3A — extant vault: adopt (map it, then prove it)

Fill `~/.config/arjev/arjev.toml` from what their notes actually carry — do NOT
reorganize their vault. Every field is remappable:

| their note has…                        | config slot                      | default            |
| -------------------------------------- | -------------------------------- | ------------------ |
| a `type:` value marking a paper note    | `[vault] type`                   | `"paper"`          |
| the field(s) holding the paper id       | `[vault.fields] identity`        | `["arxiv", "doi"]` |
| the field for when they read it         | `[vault.fields] read_date`       | `"date_read"`      |
| the field for their verdict             | `[vault.fields] rating`          | `"rating"`         |
| the field for their one-line reason     | `[vault.fields] why`             | `"why"`            |
| the field listing tags                  | `[vault.fields] tags`            | `"tags"`           |
| the field for staged-vs-written status  | `[vault.fields] status`          | `"status"`         |

Worked schemas: Zotero-style exports (`type = "journalArticle"`, `identity =
["doi", "arxiv"]`, `read_date = "dateAdded"`, `tags = "keywords"`); bare-DOI
vaults (`identity = ["doi"]`); a field named anything else — remap the row, never
the vault.

**Gate:** `arjev inspect` (read-only, exits 1 when blocked). Grep-able shapes:
`slot roots: set (…)`, `slot feeds: set (…)`, `fold identity-bearing: <n>` above
zero proves the mapping landed; `blocked: …` lines on stderr mean adoption is not
done. `fold warnings` surface verbatim — fix what they name or accept them.

## Stage 3B — fresh vault: the checklist-file

```bash
arjev init --vault /path/to/their/vault
```

`init` writes the config as a checklist-file: every slot explains itself inline,
`feeds` starts empty. Fill it **with the human**, one interview answer at a time.
Right after init, `arjev inspect` blocks with `blocked: zero identity-bearing
notes` — expected; the seeds (Stage 5) make it pass.

## Stage 4 — taste directives (HUMAN STEP)

Draft an `arjev-directives.md` at the vault root: frontmatter lists (labs,
companies, topics) plus a prose body saying what they want and what to
de-prioritize. Let them edit — taste is theirs; the ranking follows what they
write, in plain English. **Gate:** `arjev inspect` shows
`fold directives: loaded (<n> terms)`.

## Stage 5 — seed the vault from what they already have

All idempotent, all provenance-stamped; re-running changes nothing. A file the
user exports is theirs to parse — arJev never scrapes a site.

- **Google Scholar** (HUMAN STEP — the export needs their browser): in Scholar,
  open **My Library**, select the papers (or all), click the **export** icon and
  choose **BibTeX** — a `.bib` file downloads. Then:
  `arjev ingest --bibtex ~/Downloads/scholar.bib`.
- **Zotero**: File → Export Library… → format BibTeX, then the same
  `--bibtex` ingest.
- **A PDF folder**: `arjev ingest --pdf-dir ~/Papers` (arXiv ids from filenames
  or the arXiv stamp inside the PDF).
- **Slack**: `arjev ingest --slack-channel-id C0123456ABC --limit 200` (needs
  `ARJEV_SLACK_TOKEN`; every human-shared arXiv link becomes a staged note
  carrying who/where/when provenance — bot posts filtered).

**Gate:** printed counts match reality; seeded notes appear in the vault's
`papers/` dir with `why:` provenance lines; `arjev inspect` exits 0 with
`fold identity-bearing` counting their library.

## Stage 6 — credentials (their own; both optional, both fail open)

- **Jev** — semantic ranking of the full feed (~pennies/day). **HUMAN STEP**: the
  user signs up at <https://console.typesafe.ai> and gets **their own** key. Have
  them drop it in a mode-600 file (`chmod 600 ~/.config/arjev/jev.key`); the
  timer's service exports `ARJEV_JEV_KEY_FILE=<that path>`. Without a key the
  digest runs lexical-only and the `mode:` line says so — degraded, never broken.
- **Slack** (optional attention layer) — **HUMAN STEP**: they create the Slack
  app in **their** workspace (scopes: `chat:write`, `reactions:read`,
  `conversations:replies`; token in a mode-600 file → `ARJEV_SLACK_TOKEN`), then
  set `channel`, `keepers` (user IDs whose reactions count as labels), `why_style`
  in the config. The full five-minute walkthrough:
  https://github.com/harmoniqs/arJev/blob/main/docs/slack-setup.md

**Gate:** with a Jev key, the digest's `mode:` line says `jev`.

## Stage 7 — first digest, then the timer

One manual run first: `arjev digest --post slack` (or `vault`/`stdout`) — the
configured feeds run as one deduped union, each pick carrying a why-line. Then a
timer. Linux systemd user unit:

```ini
# ~/.config/systemd/user/arjev-digest.timer
[Timer]
OnCalendar=*-*-* 13:00:00 UTC
Persistent=true
```

with a `.service` running a wrapper that exports the key env vars from the
mode-600 files, then `arjev digest --top 5 --post slack` and `arjev slack sync`
(idempotent; harvests reactions → labels → staged stubs). macOS: a launchd
plist with the same shape. **Gate:** `systemctl --user list-timers` shows it
armed (or `launchctl list`), and the first manual run posted.

## Stage 8 — the staged loop: your prose obligation

A keep (Slack reaction, `arjev keep`, a checkbox) scaffolds a note with
`status: staged` — metadata only, zero taste until prose exists. Writing it is
**your** obligation:

1. `arjev staged` — the worklist, one stable line per note.
2. `arjev fetch <id>` — the PDF lands in the configured `library_dir`.
3. Read it; write the note body in your own words plus a one-line `why:`.
4. Flip `status: staged` → `status: written` — an ordinary frontmatter edit; there
   is no verb for it, by design.

**Gate:** the note leaves `arjev staged`; `arjev inspect`'s `fold staged:` counts
down. A digested keep left staged is a loop left open — run this pass daily.

## What the human owns (tell them)

- React 👍/👀/❌ on picks (if keepers-listed) — each becomes a label + a vault stub.
- Fill `rating:` and `why:` on notes — that is what makes notes taste.
- `arjev calibrate` weekly — read the report; thresholds are human-applied.
- `arjev rate propose` (advisory model first-pass ratings, side table only) and
  `arjev rate accept <arxiv> <core|useful|marginal>` (the human gate that writes).

## Post-onboarding options (offer, don't auto-apply)

- `arjev backfill` — fetches every corpus paper's PDF + extracted text into the
  library (paced, idempotent, one run), so kept papers carry their own abstracts
  and conclusions in the taste context.
- The v0.4 content arms — `state_policy = "budget-greedy"` (a recency-weighted,
  budgeted context window) and `candidate_content = true` (finalist conclusions) —
  ship **opt-in**: defaults stay incumbent until
  `arjev calibrate --replay-arms` shows a measured win on their labels. Offer the
  arms once labels accumulate; never flip them silently.

## Failure modes you will hit

- **`feeds not configured`** — the `feeds` slot is empty; fill it from the
  taxonomy, never with a guessed default.
- **"feed parsed to zero items"** — arXiv RSS occasionally returns junk mid-day;
  the digest refuses to post empty; the next run recovers.
- **Slack `missing_scope`** — the app lacks one of the three scopes.
- **`profile-degraded` in the mode line** — fewer than 5 notes or no `why` lines
  yet; seed more, or write a few (your Stage 8 job anyway).
- **`fold type-matched: 0` but identity-bearing healthy** — the `[vault] type`
  slot missed their schema; fix the slot, not the vault.
