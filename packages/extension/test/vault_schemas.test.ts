import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSchemas,
  loadPlaneResidency,
  loadRecordSchema,
  validateCard,
  validateCardFile,
  validateRecord,
  canonicalJson,
  tombstonePointerResolves,
  CARD_TYPES,
} from "../src/vault_card_validator";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, "..");
const SCHEMA_DIR = path.join(EXT, "vault-schemas");
const FIXTURE_DIR = path.join(HERE, "fixtures", "vault-cards");

const schemas = loadSchemas(SCHEMA_DIR);
const residency = loadPlaneResidency(SCHEMA_DIR);
const recordSchema = loadRecordSchema(SCHEMA_DIR);

function fixtureFiles(sub: string): string[] {
  const dir = path.join(FIXTURE_DIR, sub);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function readFixture(sub: string, name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, sub, name), "utf8"));
}

describe("card schemas", () => {
  it("has exactly the 18 card types", () => {
    expect(schemas.size).toBe(18);
    for (const t of CARD_TYPES) {
      expect(schemas.has(t), `missing schema for type ${t}`).toBe(true);
    }
  });

  it("a legacy card with no extension fields still validates (backward compat)", () => {
    const legacy = { type: "insight", date: "2026-01-01", source: "s", evidence: [], confidence: "medium", tags: [] };
    const res = validateCard(legacy, schemas);
    expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it("a card carrying all extension fields validates", () => {
    const full = {
      type: "insight",
      date: "2026-08-22",
      source: "session",
      evidence: ["experiments/x.md"],
      confidence: "high",
      tags: ["a"],
      provenance: ["experiments/x.md"],
      review_by: "2026-11-22",
      subject: "warm-starts",
    };
    expect(validateCard(full, schemas).ok).toBe(true);
  });
});

describe("valid fixture corpus", () => {
  const valid = fixtureFiles("valid");

  it("meets the corpus floors (>= 30 cards, >= 6 types)", () => {
    expect(valid.length).toBeGreaterThanOrEqual(30);
    const types = new Set(valid.map((f) => (readFixture("valid", f) as { type?: string }).type));
    expect(types.size).toBeGreaterThanOrEqual(6);
  });

  it("covers all 18 card types", () => {
    const types = new Set(valid.map((f) => (readFixture("valid", f) as { type?: string }).type));
    for (const t of CARD_TYPES) expect(types.has(t), `no valid fixture for type ${t}`).toBe(true);
  });

  it.each(valid.map((f) => [f]))("valid fixture %s validates", (f) => {
    const obj = readFixture("valid", f);
    const res = validateCard(obj, schemas);
    expect(res.errors, `${f}: ${JSON.stringify(res.errors)}`).toEqual([]);
  });

  it.each(valid.map((f) => [f]))("valid fixture %s round-trips byte-equal under canonical JSON", (f) => {
    const obj = readFixture("valid", f);
    const once = canonicalJson(obj);
    const twice = canonicalJson(JSON.parse(once));
    expect(twice).toBe(once);
  });
});

describe("invalid fixture corpus (refusals with named schema paths)", () => {
  const invalid = fixtureFiles("invalid");

  const EXPECTED_PATH: Record<string, string> = {
    "sentinel-conflict.json": "$.provenance",
    "sentinel-no-review-pointer.json": "$.reviewed_after",
    "unknown-confidence.json": "$.confidence",
    "malformed-review-by.json": "$.review_by",
    "tombstone-open-vocabulary.json": "$.justification",
    "tombstone-dangling-pointer.json": "$.pointer",
    "tombstone-superseded-no-pointer.json": "$.pointer",
    "tombstone-expired-ttl-no-date.json": "$.original_review_by",
    "missing-required.json": "$.source",
    "untyped.json": "$.type",
    "unknown-type.json": "$.type",
    "record-missing-origin.json": "$.origin",
    "tension-empty-a-cards.json": "$.a_cards",
    "confidence-wrong-type.json": "$.confidence",
    "review-by-wrong-type.json": "$.review_by",
    "experiment-missing-fidelity.json": "$.fidelity",
    "tension-missing-subject.json": "$.subject",
    "memory-card-missing-description.json": "$.description",
    // reviewer adversarial variants (2026-08-23, PR #517)
    "tombstone-empty-pointer.json": "$.pointer",
    "tombstone-empty-tombstone-of.json": "$.tombstone_of",
    "provenance-not-array.json": "$.provenance",
    "sentinel-empty-reviewed-after.json": "$.reviewed_after",
    "tombstone-unrecoverable-no-review-pointer.json": "$.review_pointer",
    "tension-self-tension.json": "$.a_cards",
    "experiment-fidelity-out-of-range.json": "$.fidelity",
    "experiment-fidelity-negative.json": "$.fidelity",
    "experiment-negative-duration.json": "$.duration_us",
    "review-by-calendar-invalid.json": "$.review_by",
  };

  it("meets the corpus floor (>= 15 adversarial fixtures)", () => {
    expect(invalid.length).toBeGreaterThanOrEqual(15);
  });

  it.each(invalid.map((f) => [f]))("invalid fixture %s is refused with the violated path named", (f) => {
    const obj = readFixture("invalid", f) as Record<string, unknown>;
    const res =
      f === "record-missing-origin.json"
        ? validateRecord(obj, recordSchema)
        : f === "tombstone-dangling-pointer.json"
          ? validateCard(obj, schemas) // passes schema; pointer existence is a separate check below
          : validateCard(obj, schemas);
    if (f === "tombstone-dangling-pointer.json") {
      // Schema-level: valid. Existence-level: the pointer must resolve under the vault root.
      expect(res.ok).toBe(true);
      const tmpVault = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "vault-"));
      expect(tombstonePointerResolves(obj, tmpVault)).toBe(false);
      fs.rmSync(tmpVault, { recursive: true, force: true });
      return;
    }
    expect(res.ok, `${f} unexpectedly valid`).toBe(false);
    const expected = EXPECTED_PATH[f];
    const paths = res.errors.map((e) => e.path);
    const joined = paths.join(" | ");
    expect(
      expected === undefined || joined.includes(expected),
      `${f}: expected violated path ${expected} in errors, got ${joined}`,
    ).toBe(true);
  });
});

describe("sentinel semantics", () => {
  it("refuses provenance_unrecoverable with a non-empty provenance list", () => {
    const bad = {
      type: "insight",
      date: "2026-08-22",
      source: "s",
      evidence: [],
      confidence: "medium",
      tags: [],
      provenance_unrecoverable: true,
      reviewed_after: "journal/pass-1.md",
      provenance: ["experiments/x.md"],
    };
    expect(validateCard(bad, schemas).ok).toBe(false);
  });

  it("refuses the sentinel without a review pointer", () => {
    const bad = {
      type: "insight",
      date: "2026-08-22",
      source: "s",
      evidence: [],
      confidence: "medium",
      tags: [],
      provenance_unrecoverable: true,
    };
    expect(validateCard(bad, schemas).ok).toBe(false);
  });

  it("accepts a reviewed sentinel with empty provenance", () => {
    const good = {
      type: "insight",
      date: "2026-08-22",
      source: "s",
      evidence: [],
      confidence: "low",
      tags: [],
      provenance: [],
      provenance_unrecoverable: true,
      reviewed_after: "journal/pass-1.md",
    };
    expect(validateCard(good, schemas).ok).toBe(true);
  });
});

describe("reviewer adversarial semantics (2026-08-23 pass, #517)", () => {
  it("accepts fidelity at the [0, 1] boundaries", () => {
    const base = {
      type: "experiment",
      task_type: "experiment-sim",
      date: "2026-08-22",
      session_id: "s",
      platform: "transmon",
      gate: "X",
      duration_us: 10,
      status: "solved",
      tags: [],
    };
    for (const fidelity of [0, 1]) {
      const res = validateCard({ ...base, fidelity }, schemas);
      expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
    }
  });

  it("accepts a real leap day but refuses a non-leap Feb 29", () => {
    const base = { type: "insight", date: "2026-08-22", source: "s", evidence: [], confidence: "medium", tags: [] };
    expect(validateCard({ ...base, review_by: "2024-02-29" }, schemas).ok).toBe(true);
    expect(validateCard({ ...base, review_by: "2027-02-29" }, schemas).ok).toBe(false);
  });

  it("refuses a tension whose sides partially overlap", () => {
    const res = validateCard(
      {
        type: "tension",
        date: "2026-08-22",
        subject: "partial-overlap",
        a_cards: ["knowledge/x.md", "knowledge/y.md"],
        b_cards: ["knowledge/y.md", "knowledge/z.md"],
        tags: [],
      },
      schemas,
    );
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.path).join("|")).toContain("$.a_cards");
  });
});

describe("tombstone vocabulary", () => {
  const base = { type: "tombstone", date: "2026-08-22", tombstone_of: "knowledge/insight-x.md", tags: [] };

  it("accepts each legal justification with its conditional fields", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...base, justification: "superseded_by", pointer: "knowledge/insight-y.md" },
      { ...base, justification: "expired_ttl", original_review_by: "2026-01-01" },
      { ...base, justification: "provenance_unrecoverable", review_pointer: "journal/review-1.md" },
      { ...base, justification: "redundant_with", pointer: "knowledge/insight-z.md" },
      { ...base, justification: "filed_to", pointer: "repo:harmoniqs/Piccolo.jl#AGENTS.md" },
      { ...base, justification: "lifecycle_complete" },
    ];
    for (const c of cases) {
      const res = validateCard(c, schemas);
      expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
    }
  });

  it("refuses a justification outside the vocabulary", () => {
    const res = validateCard({ ...base, justification: "because" }, schemas);
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.path).join("|")).toContain("$.justification");
  });
});

describe("evidence-plane records", () => {
  it("a minimal record validates", () => {
    expect(validateRecord({ type: "experiment", date: "2026-08-22", origin: "runs/r1/" }, recordSchema).ok).toBe(true);
  });

  it("refuses a non-evidence type as a record", () => {
    const res = validateRecord({ type: "insight", date: "2026-08-22", origin: "x" }, recordSchema);
    expect(res.ok).toBe(false);
  });
});

describe("plane residency", () => {
  it("maps every card type to exactly one plane", () => {
    for (const t of CARD_TYPES) {
      const entry = residency[t];
      expect(entry, `no residency for ${t}`).toBeDefined();
      expect(["knowledge", "evidence", "work"]).toContain(entry.plane);
    }
  });

  it("evidence-plane types are experiment, meeting, retrospective, paper", () => {
    for (const t of ["experiment", "meeting", "retrospective", "paper"]) {
      expect(residency[t].plane).toBe("evidence");
    }
  });
});

describe("file-level validation", () => {
  it("validates a markdown card with frontmatter", () => {
    const p = path.join(FIXTURE_DIR, "valid-md", "insight-cat-state.md");
    const res = validateCardFile(p, schemas);
    expect(res.errors, JSON.stringify(res.errors)).toEqual([]);
  });
});
