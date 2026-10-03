# Tagging rules (generative canon)

- **Tier-1** (`products` / `projects` / `types`): apply **only** values enumerated in
  `products.md`, `internal-projects.md`, `meeting-types.md`. Never invent Tier-1 values.
- **Tier-2** (`entities`): mint `<namespace>:<canonical>`, namespace ∈
  `{investor, partner, competitor, person}`, canonical kebab-case. Reuse an existing
  canonical (check `aliases.md`) before minting; on genuine ambiguity add the raw name to
  the note's `unresolved:` and to `state/resolution-queue.md` — never guess.
- **Tier-3** (`themes`): free-form kebab-case.
- **Disambiguation:** shipped/named offering → product; codenamed internal effort →
  project; soft topic (pricing, latency, hiring) → theme.
- Tagging runs on **de-garbled** text (`registry/degarble.json` applied upstream), so match
  against corrected names, not Gemini's manglings.
