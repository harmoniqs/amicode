// SEAM 5 (amicode #681) — the calibrate→pin→re-optimize→re-bank verb chain.
//
// The chain composes EXISTING seams into ONE recorded path:
//   1. calibrate — the mock leg's calibration data source is the SEAM 1 MockSoc
//      rehearsal artifact (test/fixtures/mocksoc/ — the cross-seam dependency is
//      explicit and the fixture is shared). The hardware leg is structurally
//      impossible outside a real-board session: the code path REFUSES (a unit
//      test below) — real-board sessions are an enumerated human gate.
//   2. pin — the formulation's calibration_pin constraint (the
//      fix_global_variable! path) + solve.pinned_globals (existing entity
//      surfaces, no new kinds).
//   3. re-optimize — warm-started from the bank (the load_traj idiom); the
//      re-solve launches through the EXISTING solve path (bash amico-run — the
//      recording core never launches anything).
//   4. re-bank — the catalog note carries the chain's fingerprint (which
//      calibration, which pin, which warm-start seed) via `amico catalog ingest`
//      (packages/amico-run — provenance flags tested in that package's suite).
//      Promotion is human-gated like all promotions: the chain stages the
//      command and only VERIFIES the promoted entry afterwards.
//
// Layers here (mirroring the SEAM 1 test shape):
//   1. entities.ts — the additive [calib_chain] record (leg PINNED mock — the
//      record has no hardware variant to lie with; promotion DERIVED by the
//      serializer — never caller data).
//   2. calib_chain.ts — the recording core (recordCalibChain / completeCalibChain):
//      reads the rehearsal artifact through the SAME reader the tool uses,
//      refuses dishonesty by recording NOTHING, writes through the existing
//      entities (formulation calibration_pin + pinned_globals, run warm_start)
//      + the chain entity + events.
// The plugin wrapper (amicode_tools.ts amicode_calib_chain) is a thin adapter
// over this core, verified against the real binary (night-build), not in vitest.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parse } from "smol-toml";
import { readRehearsalRecord } from "../opencode-plugin/rehearsal";
import {
  calibChainToml,
  validateCalibChainRecord,
  type CalibChainRecord,
} from "../opencode-plugin/entities";

const REHEARSAL = join(__dirname, "fixtures", "mocksoc", "rehearsal-success.toml");

function rehearsalRecord() {
  const rr = readRehearsalRecord(REHEARSAL);
  if (!rr.ok) throw new Error(`fixture must parse: ${rr.problem}`);
  return rr.record;
}

/** A staged chain built from the SEAM 1 fixture — the shape the recording core
 *  records after the calibrate + pin + re-optimize legs. */
function stagedChain(overrides?: Partial<CalibChainRecord>): CalibChainRecord {
  const reh = rehearsalRecord();
  return {
    leg: "mock",
    calibration: {
      source: REHEARSAL,
      pulse_hash: reh.pulse_hash,
      mismatch: reh.mismatch,
    },
    pinned_globals: { delta: 0.21 },
    warm_start: "transmon-X-v1",
    run_dir: "/runs/devlab/r20260901-000000Z-chain",
    ...overrides,
  };
}

describe("calibChainToml — the chain record under [calib_chain]", () => {
  it("round-trips a staged chain: leg PINNED mock, promotion DERIVED pending-human-signoff, calibration + pin + seed", () => {
    const doc = parse(calibChainToml(stagedChain())) as any;
    expect(doc.calib_chain.leg).toBe("mock"); // pinned by the serializer — the record has no hardware variant
    expect(doc.calib_chain.promotion).toBe("pending-human-signoff"); // derived, never caller data
    expect(doc.calib_chain.warm_start).toBe("transmon-X-v1"); // which warm-start seed
    expect(doc.calib_chain.run_dir).toContain("r20260901");
    expect(doc.calib_chain.calibration.source).toMatch(/rehearsal-success\.toml$/); // which calibration
    expect(doc.calib_chain.calibration.pulse_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(doc.calib_chain.calibration.mismatch).toContain("delta × 1.05");
    expect(doc.calib_chain.pinned_globals.delta).toBeCloseTo(0.21); // which pin
    expect(doc.calib_chain.rebank).toBeUndefined(); // staged — the re-bank leg is absent until the promotion is verified
    expect(Number.isNaN(Date.parse(doc.calib_chain.recorded))).toBe(false);
  });

  it("round-trips the rebank leg and flips the DERIVED promotion to human-gated-rebank-recorded (the record still never claims approval)", () => {
    const reh = rehearsalRecord();
    const completed = stagedChain({
      rebank: {
        catalog_entry: "transmon-X-v2",
        provenance: {
          warm_start: "transmon-X-v1",
          calibration_ref: REHEARSAL,
          pinned_globals: { delta: 0.21 },
        },
      },
    });
    const doc = parse(calibChainToml(completed)) as any;
    expect(doc.calib_chain.promotion).toBe("human-gated-rebank-recorded");
    expect(doc.calib_chain.rebank.catalog_entry).toBe("transmon-X-v2");
    expect(doc.calib_chain.rebank.provenance.warm_start).toBe("transmon-X-v1");
    expect(doc.calib_chain.rebank.provenance.calibration_ref).toMatch(/rehearsal-success\.toml$/);
    expect(doc.calib_chain.rebank.provenance.pinned_globals.delta).toBeCloseTo(0.21);
    expect(reh.outcome).toBe("success"); // the fixture is a passed rehearsal (cross-seam sanity)
  });
});

describe("validateCalibChainRecord", () => {
  it("accepts the staged shape ([] problems)", () => {
    expect(validateCalibChainRecord(stagedChain())).toEqual([]);
  });

  it("refuses a leg other than mock — the hardware leg is not a recordable variant", () => {
    const problems = validateCalibChainRecord(stagedChain({ leg: "hardware" as any }));
    expect(problems.join(" ")).toMatch(/mock|hardware/i);
  });

  it("refuses an empty pin set, a bad pulse hash, and an empty warm-start seed", () => {
    expect(validateCalibChainRecord(stagedChain({ pinned_globals: {} }))[0]).toMatch(/pinned_globals/);
    expect(
      validateCalibChainRecord(
        stagedChain({ calibration: { source: REHEARSAL, pulse_hash: "not-a-hash", mismatch: "delta × 1.05" } }),
      )[0],
    ).toMatch(/pulse_hash/);
    expect(validateCalibChainRecord(stagedChain({ warm_start: "" }))[0]).toMatch(/warm_start/);
  });
});
