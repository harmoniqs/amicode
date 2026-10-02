// The claim object's schema + validator (amicode #1681, brain flywheel slice 2):
// the ONE type namespace. The parent contract (#1679, vault spec
// spec-20261002-090500): type (insight|hypothesis|best-practice|hazard|method —
// the spec sketch's "hypthesis" is a corrected typo), statement, status
// (unverified→corroborated→superseded→refuted), confidence, evidence pointers,
// applied, last_applied, append-only history, scope, tags. Frontmatter-contract
// pattern (like library-paper/skill): no schema_version, exact key set
// (additionalProperties: false) — the pack.toml fixture discipline: a shape
// change MUST fail these tests.
import { describe, it, expect } from "vitest";
import claimSchemaJson from "../schemas/claim.schema.json" with { type: "json" };
import {
  validateClaim,
  CLAIM_TYPES,
  CLAIM_STATUSES,
  CLAIM_CONFIDENCE_LEVELS,
  CLAIM_SCOPES,
  CLAIM_HISTORY_EVENTS,
  bucketConfidence,
} from "../src/claim.js";

/** The claim of record — the fixture-of-record shape every well-formed claim
 *  must match. Distilled candidates (slice 1's notes) merge into THIS shape;
 *  memory cards project into it mechanically. */
export const CLAIM_OF_RECORD = {
  type: "insight",
  statement: "Two-qubit gates (SWAP, CX, CZ) are significantly harder than single-qubit gates",
  status: "unverified",
  confidence: "medium",
  evidence: ["memory-card/project_two_qubit_challenge.md"],
  applied: 0,
  last_applied: null,
  history: [
    {
      date: "2026-10-02T12:00:00.000Z",
      event: "projected",
      note: "projected from memory card project_two_qubit_challenge.md (card type: project) by amico claims project",
    },
  ],
  scope: "personal",
  tags: ["memory", "two-qubit"],
};

describe("claim schema (#1681 — one type namespace)", () => {
  it("accepts the claim of record", () => {
    const r = validateClaim(CLAIM_OF_RECORD);
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it("accepts a corroborated claim with applied history — every enum value in use is legal", () => {
    const r = validateClaim({
      ...CLAIM_OF_RECORD,
      status: "corroborated",
      applied: 3,
      last_applied: "2026-10-01T09:00:00.000Z",
      history: [
        ...CLAIM_OF_RECORD.history,
        { date: "2026-10-01T09:00:00.000Z", event: "applied", note: "cited in a solve" },
        { date: "2026-10-02T08:00:00.000Z", event: "corroborated", note: "second evidence pointer added" },
      ],
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  // ── each enum rejects bad values (AC 1: type + status enums, and the rest) ──
  it.each([
    ["type", "feedback", "an unprojected memory-card type", "must be one of (insight, hypothesis, best-practice, hazard, method)"],
    ["type", "hypthesis", "the parent issue's known typo — never a legal value", "must be one of (insight, hypothesis, best-practice, hazard, method)"],
    ["status", "wrong", "a status outside the lifecycle", "must be one of (unverified, corroborated, superseded, refuted)"],
    ["confidence", "medium-high", "an invented confidence band", "must be one of (high, medium, low)"],
    ["scope", "org", "a scope outside the promotion ladder", "must be one of (personal, team, public)"],
  ])("rejects a bad %s (%s)", (key, value, why, message) => {
    const r = validateClaim({ ...CLAIM_OF_RECORD, [key]: value });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes(`/${key}`) && e.includes(message)), `${why}: ${r.errors.join("; ")}`).toBe(true);
  });

  it("rejects a bad history event and a bad history entry shape", () => {
    const badEvent = validateClaim({
      ...CLAIM_OF_RECORD,
      history: [{ date: "2026-10-02T12:00:00.000Z", event: "flipped", note: "not a vocabulary word" }],
    });
    expect(badEvent.ok).toBe(false);
    expect(badEvent.errors.some((e) => e.includes("/history/0/event") && e.includes("must be one of"))).toBe(true);

    const badEntry = validateClaim({
      ...CLAIM_OF_RECORD,
      history: [{ date: "2026-10-02T12:00:00.000Z", event: "projected", note: "ok", by: "machinery" }],
    });
    expect(badEntry.ok).toBe(false);
    expect(badEntry.errors.some((e) => e.includes("/history/0/by: unknown key") || e.includes("/history/0: unknown key"))).toBe(true);
  });

  it("rejects missing required fields, naming each missing key", () => {
    const r = validateClaim({});
    expect(r.ok).toBe(false);
    for (const key of ["type", "statement", "status", "confidence", "evidence", "applied", "last_applied", "history", "scope", "tags"]) {
      expect(r.errors.some((e) => e === `/${key}: missing required key "${key}"`), `names /${key}: ${r.errors.join("; ")}`).toBe(true);
    }
  });

  it("rejects stray keys — the frontmatter is EXACTLY the claim object (provenance rides evidence + history, never extra keys)", () => {
    const r = validateClaim({ ...CLAIM_OF_RECORD, projected_from: "amicode/memory/foo.md" });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('/projected_from: unknown key "projected_from"');
  });

  it("rejects a non-object, an empty statement, a negative applied, and a malformed date", () => {
    expect(validateClaim(null).ok).toBe(false);
    expect(validateClaim({ ...CLAIM_OF_RECORD, statement: "  " }).ok).toBe(false);
    expect(validateClaim({ ...CLAIM_OF_RECORD, applied: -1 }).ok).toBe(false);
    expect(validateClaim({ ...CLAIM_OF_RECORD, last_applied: "yesterday" }).ok).toBe(false);
  });

  it("pins the TS vocabularies to the schema's enums — a drift on either side fails here (the pack.toml fixture discipline)", () => {
    // Read the enums straight off the published schema so the cross-pin is a
    // contract check, not a restatement.
    const schema = claimSchemaJson as unknown as {
      properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }>;
    };
    expect(schema.properties.type.enum).toEqual([...CLAIM_TYPES]);
    expect(schema.properties.status.enum).toEqual([...CLAIM_STATUSES]);
    expect(schema.properties.confidence.enum).toEqual([...CLAIM_CONFIDENCE_LEVELS]);
    expect(schema.properties.scope.enum).toEqual([...CLAIM_SCOPES]);
    expect(schema.properties.history.items!.properties.event.enum).toEqual([...CLAIM_HISTORY_EVENTS]);
    // the schema's required set is exactly the 10 contract keys
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["applied", "confidence", "evidence", "history", "last_applied", "scope", "statement", "status", "tags", "type"],
    );
  });

  it("bucketConfidence bridges distill's numeric candidate confidence into the claim enum (one convention, defined in the schema slice)", () => {
    expect(bucketConfidence(0.95)).toBe("high");
    expect(bucketConfidence(0.8)).toBe("high");
    expect(bucketConfidence(0.79)).toBe("medium");
    expect(bucketConfidence(0.5)).toBe("medium");
    expect(bucketConfidence(0.49)).toBe("low");
    expect(bucketConfidence(0)).toBe("low");
  });
});
