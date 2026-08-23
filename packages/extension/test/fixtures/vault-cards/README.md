# Vault card fixtures

Golden corpora for the vault schema contract tests (`test/vault_schemas.test.ts`).

- `valid/` — 45 cards covering all 18 card types (floors: ≥ 30 cards, ≥ 6 types).
  Each must validate and round-trip byte-equal under canonical JSON.
- `invalid/` — 18 refusals; each must fail with the violated schema path named
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
of their own before merging — this README records that the obligation is open
until they do.
