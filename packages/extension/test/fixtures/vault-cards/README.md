# Vault card fixtures

Golden corpora for the vault schema contract tests (`test/vault_schemas.test.ts`).

- `valid/` — 45 cards covering all 18 card types (floors: ≥ 30 cards, ≥ 6 types).
  Each must validate and round-trip byte-equal under canonical JSON.
- `invalid/` — 28 refusals; each must fail with the violated schema path named
  (the expectation table lives in the test file). `tombstone-dangling-pointer.json`
  passes schema validation by design — pointer *existence* is checked separately
  (`tombstonePointerResolves`).
- `valid-md/` — markdown cards for file-level (frontmatter) validation.
- `generate-fixtures.mjs` — deterministic generator; the committed JSON files
  are the corpus of record.

## Authorship attestation (the PR-review gate)

These fixtures are **implementer-generated**. Per the spec's authorship-split
rule (spec-20260821-090401, Measurement Protocol: "authorship split (reviewer
≠ implementer) … attested in the fixture directory README"), the PR reviewer
must spot-check the refusal corpus and add at least one adversarial variant
of their own before merging.

**reviewer pass 2026-08-23: 10 adversarial variants added by an independent
reviewer agent; gate discharged.** Findings:

1. **Tension side overlap was accepted** — a tension card citing the same card
   in `a_cards` and `b_cards` (full or partial overlap) validated. Fixed: a
   disjointness check in `validateCard` (cross-field, not expressible in the
   schema subset); fixture `tension-self-tension.json` + a partial-overlap unit
   test.
2. **Unbounded physical quantities were accepted** — `fidelity: 1.5`,
   `fidelity: -0.2`, and `duration_us: -5` all validated. Fixed: the engine
   gained `minimum`/`maximum`; the experiment schema now bounds fidelity to
   [0, 1] and duration_us to ≥ 0; fixtures `experiment-fidelity-out-of-range`,
   `experiment-fidelity-negative`, `experiment-negative-duration` + a
   boundary-accept unit test.
3. **Calendar-invalid dates were accepted** — `review_by: "2026-02-30"` passed
   `format: "date"` because `Date.parse` rolls non-existent dates over. Fixed:
   a round-trip calendar check in `isWellFormedDate`; fixture
   `review-by-calendar-invalid.json` + a leap-day unit test.
4. Probed and cleared (accepted, judged correct): `provenance_unrecoverable:
   false` alongside `reviewed_after` (the extension fields are optional and
   independently meaningful; the sentinel rule constrains only the true case);
   `filed_to` with a non-`repo:` pointer (existence-level concern, caller's
   domain); the sentinel with `provenance` absent (absent ≡ empty).
5. **Left for human judgment, not fixed:** empty-string items inside
   `evidence`/`tags`/`a_cards`/`b_cards` arrays still validate (the
   `packages/schema` tracer uses `minLength: 1` items — a consistency question
   across the whole field table, not a surgical gap).
