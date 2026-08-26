// Vault card schemas v2 (#496 — the distillation-pass open contract): the 18
// card types (12 schema-check types + 4 memory families + tension/tombstone),
// the extension fields, the reviewed unrecoverable sentinel, and the plane
// residency table. The validator dispatches on `type` so a rejection names the
// violated schema path — the umbrella oneOf in vault-card.schema.json is the
// published open contract for external tools; this module is the amicode-side
// seam with field-precise errors.
import { describe, it, expect } from "vitest";
import { validateVaultCard } from "../src/vault-card.js";

describe("vault cards (distillation-pass contract, #496)", () => {
  it("accepts a legacy insight card — no extension fields, validates today", () => {
    const r = validateVaultCard({
      type: "insight",
      date: "2026-08-22",
      source: "session-71907fc9",
      evidence: ["evidence/runs/r20260814-065938Z-36d9/result.toml"],
      confidence: "medium",
      tags: ["pulse-design"],
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });
});
