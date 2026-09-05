---
name: sota-review
description: Survey the outside world before designing — TWO lenses in one skill. Papers (vault/repo grep first, then the arXiv API over HTTPS, never search-engine scraping) and codebases (the GitHub API against the watched-repo registry's canonical repos, never a local fork checkout). Cited, provenance-stamped briefs. Use before specs, decompositions, and hypothesis rounds.
agents: [researcher, librarian, dreamer]
surface: public
source: amicode
revision: 1
---

# SOTA review — the loops' external currency

One survey, two lenses, one discipline: **read-only toward the world,
append-only toward the vault**. The survey seeds hypotheses and design
decisions; it never blocks the loop (a survey that cannot run records a
NAMED outcome and the loop proceeds), and its matches route through staging
for a human eye before they count as currency — this skill fetches and
reports; the staged routing is a later layer.

## Usage

`/sota-review` — survey papers and watched codebases for the topic at hand.
`/sota-review papers <terms>` — the papers lens only.
`/sota-review codebase` — the codebase lens only (a watched-repo round).

## Lens 1 — papers

The recipe's rules, in order. **Step 1 always precedes step 2** — niche
queries are usually already answered in the vault, the demos, or the
package docs.

1. **Vault/repo grep FIRST.** Grep the vault mounts and the repo checkouts
   before touching the network:
   `grep -rn -i "<term>" <vault mounts> <repo checkouts>`
   Vendors, collaborators, and papers-we-cite are typically already in
   notes, reading cards, or package docs — a hit here is faster and better
   than any web result.
2. **The arXiv API over HTTPS for papers** — scriptable, reliable, never
   scraping. On-demand queries go through the fleet-wide serialized queue:
   `amico sota papers --query "<terms>" [--top N]`
   GOTCHA (mechanical, not advisory): the `http://` scheme on
   export.arxiv.org **silently hangs** — always `https://`. The fetch seam
   refuses `http://` by name; do not work around it.
3. **Direct domain or Wikipedia fetch** for companies and tools: fetch the
   plausible domain or `en.wikipedia.org/wiki/<Name>`. A 404 is signal too.
4. **Ask the user** when 1–3 fail — a one-line question beats ten minutes
   of scraper thrash.

**Never search-engine scraping.** Bing or Google HTML endpoints are SEO
garbage for niche technical queries or bot-blocked outright — never fetch
them, never parse them. The sanctioned paths are the two above.

### The queue discipline (one fetcher, one query queue)

All live arXiv traffic rides the fetch cache plus ONE serialized query queue
— a lock-file queue at the fleet-shared sota root (the personal vault
mount's `amicode/sota` directory; `$AMICO_SOTA_ROOT` overrides). A per-host
lock serializes nothing: the fleet is the concurrency, so the queue lives
at the shared path. In practice:

- If the cache holds the query, you get `via: cache` — no network ran.
- If another fetcher holds the queue, the wait is bounded; on timeout you
  get the **named outcome** `queue-timeout` with the disclosed alternative
  (read the fetch cache, or record the explicit waiver). Never retry in a
  tight loop; never block the loop on the wire.

## Lens 2 — codebases

Watch the repos that matter via the GitHub API **against canonical repos
(organizer/name), never a local fork checkout** — a local checkout sees
your drift, not the world's:

`amico sota codebase [--repo owner/name]`

The substrate is the **watched-repo registry** — validator-checked TOML
data living in the same fleet-shared sota root (`watched-repos.toml`),
seeded at first read with the shipped set: the canonical agent harnesses,
the Julia optimal-control stack adjacent to our authoring map, the
QEC/qLDPC challenge repos, and the quantum SDK release tracks.

- **Adding a repo is a data edit, never code**: append a `[[repos]]` entry
  (`repo`, `why_watched`, `domains`, `fetch_surface`, `match_keywords`).
  A malformed registry fails LOUDLY — fix the TOML, never the validator.
- Each round stamps `last_success` and accrues `consecutive_failures` per
  entry; after the registry's threshold (default 7) of consecutive failures
  the brief flags the entry for **human retire-or-confirm** — confirm the
  watch or retire it; the registry edit is yours, never the machinery's.
- Events surface only when they match the entry's keywords, and the brief
  names which keywords matched.

## Briefs — the PI register

Every brief this skill emits is written for a research PI: **concise,
human-readable, details-informed**, every claim **cited** (the paper's abs
URL, the release/issue URL), and every render **provenance-stamped** — the
query, the source, the fetch time, and the path (`via: cache` or
`via: fetched`; a cache read never launders as a live fetch). Raw payloads
stay one level down; the brief ranks, it never dumps.

**Quiet failures are the ones that matter:**

- A successful fetch returning zero entries where the trailing 7-fetch-day
  mean is nonzero renders **"scan returned nothing — anomalous"** — never
  "nothing new". An empty scan against history is a signal, not a rest day.
- A failed fetch is a **named** failure in the brief (which repo, which
  surface, which error) — never a silent skip.

## Checklist — the recipe's rules (lint-pinned)

Run through this list before publishing any brief:

- [ ] Vault and repo greps ran FIRST, and their hits (if any) are cited in the brief.
- [ ] Papers came from the arXiv API over **HTTPS** — `https://export.arxiv.org/api/query`, never `http://` (it hangs), never search-engine HTML (no Bing, no Google scraping).
- [ ] Every live fetch rode the serialized queue (`amico sota …`); a `queue-timeout` rendered its named outcome and the disclosed alternative — the loop was never blocked.
- [ ] Codebase events came from the GitHub API against **canonical repos**, never a local fork checkout.
- [ ] The registry is treated as data: any repo change was a TOML edit; a flagged entry went to the human as retire-or-confirm.
- [ ] Every claim in the brief is cited and the render carries its provenance stamp (query, source, fetched time, via).
- [ ] An empty-but-successful scan rendered "scan returned nothing — anomalous" if the floor was armed — the brief never says "nothing new".

## Honest degradation

- **No sota root / no registry**: the codebase lens bootstraps the registry
  from the shipped seed on first read; if even that fails, say so and name
  the error — never pretend a survey ran.
- **Network unavailable**: the survey records the named outcome and the
  loop proceeds (currency is a seed, not a stall). The brief renders the
  failure and its provenance honestly.
- **This slice fetches and reports**: it does not stage matches into a
  campaign ledger, render strategy compositions, or gate anything — those
  layers exist later; do not simulate their effects.
