// SEAM 5 (amicode #681) — the chain's structural invariants, made mechanical
// (the mocksoc_imports.test.ts pattern):
//
//   `chain_promotion_never_a_plugin_write == 1` (AC: the chain's promotion is
//   human-gated like all promotions). The recording path (calib_chain.ts —
//   the same core the amicode_calib_chain tool drives) must have NO catalog
//   discovery and NO direct filesystem write: it can never find the catalog on
//   its own (so it can never write an entry), and every workspace write goes
//   through the provenance-spine helpers (writeEntityFiles/appendEvent), whose
//   only writer surface is the problem workspace. The promotion happens
//   out-of-band via the human-gated `amico catalog ingest`; the chain only
//   READS the promoted entry afterwards (an explicit metadata path).
//
//   `chain_hardware_leg_refusal_is_the_only_path == 1` (AC: the hardware leg is
//   structurally impossible outside a real-board session). The record type has
//   exactly one leg variant ("mock" — entities.ts pins it), and the recording
//   path's only other leg is the REFUSAL that names the enumerated human gate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORE = join(__dirname, "..", "opencode-plugin", "calib_chain.ts");
const ENTITIES = join(__dirname, "..", "opencode-plugin", "entities.ts");

describe("chain recording path — the promotion invariant (structural scan)", () => {
  const src = readFileSync(CORE, "utf8");

  it("never discovers the catalog — no AMICO_CATALOG_DIR, no catalogPulsesDir (the promotion runs out-of-band, human-gated)", () => {
    expect(src).not.toMatch(/AMICO_CATALOG_DIR/);
    expect(src).not.toMatch(/catalogPulsesDir/);
    expect(src).not.toMatch(/armonissima/);
  });

  it("performs no direct filesystem WRITE — every workspace write rides the provenance-spine helpers", () => {
    // writeEntityFiles / appendEvent (problems.ts) are the ONLY write surface;
    // a direct fs write here would bypass the diff/hash/event spine.
    const offenders = src
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /fs\.(write|append|mkdir|rename|copy|rm|unlink)Sync/.test(l));
    expect(offenders, `direct fs writes in the chain core: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it("reads the promoted entry only through the caller-given metadata path (read-only verify)", () => {
    // The single catalog touch: completeCalibChain's read of the explicit
    // rebankMetadataRef. readFileSync appears once, in readCatalogMetadata.
    const reads = src.split("\n").filter((l) => /fs\.readFileSync/.test(l));
    expect(reads.length).toBe(2); // readEntityJson + readCatalogMetadata — both read-only
    expect(src).toMatch(/rebankMetadataRef/);
  });
});

describe("chain record type — the leg invariant (structural scan)", () => {
  it("the record has exactly one leg variant: mock (the hardware leg is a refusal, never a record variant)", () => {
    const entities = readFileSync(ENTITIES, "utf8");
    expect(entities).toMatch(/leg: "mock"/);
    // the validator refuses anything else — the structural refusal
    expect(entities).toMatch(/leg must be "mock"/);
    // and the refusal path names the enumerated human gate
    expect(readFileSync(CORE, "utf8")).toMatch(/real-board session/);
  });
});
