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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { readRehearsalRecord } from "../opencode-plugin/rehearsal";
import {
  calibChainToml,
  validateCalibChainRecord,
  formulationToml,
  type CalibChainRecord,
  type FormulationEntity,
} from "../opencode-plugin/entities";
import {
  createProblem,
  problemDir,
  writeEntityFiles,
} from "../opencode-plugin/problems";
import {
  recordCalibChain,
  completeCalibChain,
  hardwareLegRefusal,
} from "../opencode-plugin/calib_chain";

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

// ── the recording core (opencode-plugin/calib_chain.ts) ─────────────────────────
// The SAME core the amicode_calib_chain tool drives; the slow e2e (test/slow)
// drives it end-to-end against the real solve + rehearsal + catalog ingests.

const FORM: FormulationEntity = {
  trajectory_type: "gate",
  time_mode: "fixed",
  parameterization: "smooth",
  robustness: { kind: "none", params: {} },
  free_phase: false,
  leakage: false,
  target: "X",
  objectives: [],
  constraints: [{ kind: "bounds", params: {}, label: "amplitude bound (drive_max)" }],
};

/** Fresh problem workspace with a system + formulation pre-recorded (the chain
 *  pins onto the RECORDED formulation — no formulation, no chain). */
function freshWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "calib-chain-"));
  process.env.AMICODE_PROBLEMS_DIR = root;
  const meta = createProblem("chain test");
  const dir = problemDir(meta.slug);
  const sys = { platform: "transmon", components: [{ id: "q1", role: "qubit", levels: 3, params: { omega: 4.8, delta: 0.2 } }], couplings: [], drive: { arch: "per-component" } };
  writeEntityFiles(meta.slug, "system", "x\n", JSON.stringify(sys) + "\n");
  writeEntityFiles(meta.slug, "formulation", formulationToml(FORM), JSON.stringify(FORM) + "\n");
  return meta.slug;
}

function readEvents(slug: string): Record<string, any>[] {
  const f = join(problemDir(slug), "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
}

describe("recordCalibChain — the chain's staging (calibrate + pin + re-optimize legs)", () => {
  const prevProblems = process.env.AMICODE_PROBLEMS_DIR;

  afterEach(() => {
    if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
    else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
  });

  it("stages through the EXISTING entities: formulation gains the calibration_pin constraint + solve.pinned_globals, the run stub gains warm_start, the chain entity + events express the chain", () => {
    const slug = freshWorkspace();
    const res = recordCalibChain({
      slug,
      leg: "mock",
      rehearsalRef: REHEARSAL,
      pinned: { delta: 0.21 },
      warmStart: "transmon-X-v1",
      runDir: "/runs/devlab/r20260901-000000Z-chain",
    });
    if (!res.ok) throw new Error(`expected ok, got: ${res.problem}`);
    // leg 2 — the pin rides the EXISTING formulation surfaces (calibration_pin
    // constraint with the calibrated VALUES, solve.pinned_globals with the
    // NAMES — the fix_global_variable! path's recorded halves).
    const form = parse(readFileSync(join(problemDir(slug), "entities", "formulation.toml"), "utf8")) as any;
    const pin = form.formulation.constraints.find((c: any) => c.kind === "calibration_pin");
    expect(pin).toBeDefined();
    expect(pin.params.delta).toBeCloseTo(0.21);
    expect(form.formulation.solve.pinned_globals).toEqual(["delta"]);
    // leg 3 — the re-optimize rides the run stub (warm_start, additive).
    const run = parse(readFileSync(join(problemDir(slug), "entities", "run.toml"), "utf8")) as any;
    expect(run.run.warm_start).toBe("transmon-X-v1");
    expect(run.run.run_dir).toContain("r20260901");
    // the chain entity — the fingerprint.
    const chain = parse(readFileSync(join(problemDir(slug), "entities", "calib_chain.toml"), "utf8")) as any;
    expect(chain.calib_chain.warm_start).toBe("transmon-X-v1");
    expect(chain.calib_chain.pinned_globals.delta).toBeCloseTo(0.21);
    expect(chain.calib_chain.calibration.pulse_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chain.calib_chain.promotion).toBe("pending-human-signoff");
    // events express the chain (the provenance spine).
    const events = readEvents(slug);
    const kinds = events.map((e) => `${e.entity}:${e.action}`);
    expect(kinds).toContain("formulation:updated");
    expect(kinds).toContain("run:created");
    expect(kinds).toContain("calib_chain:created");
  });

  it("re-staging replaces the prior calibration_pin (idempotent pin, not a growing constraint set)", () => {
    const slug = freshWorkspace();
    for (const delta of [0.21, 0.205]) {
      const res = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta }, warmStart: "transmon-X-v1" });
      if (!res.ok) throw new Error(res.problem);
    }
    const form = parse(readFileSync(join(problemDir(slug), "entities", "formulation.toml"), "utf8")) as any;
    const pins = form.formulation.constraints.filter((c: any) => c.kind === "calibration_pin");
    expect(pins).toHaveLength(1);
    expect(pins[0].params.delta).toBeCloseTo(0.205);
  });

  it("the hardware leg is structurally refused — the refusal names the enumerated human gate and records NOTHING", () => {
    const slug = freshWorkspace();
    const res = recordCalibChain({ slug, leg: "hardware", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.problem).toMatch(/real-board session/i); // the enumerated human gate
    expect(hardwareLegRefusal()).toMatch(/real-board session/i);
    // nothing recorded — no entity, no event, and the formulation untouched.
    expect(existsSync(join(problemDir(slug), "entities", "calib_chain.toml"))).toBe(false);
    expect(readEvents(slug).filter((e) => e.entity === "calib_chain")).toHaveLength(0);
    const form = parse(readFileSync(join(problemDir(slug), "entities", "formulation.toml"), "utf8")) as any;
    expect(form.formulation.constraints.some((c: any) => c.kind === "calibration_pin")).toBe(false);
  });

  it("refuses a dishonest calibration artifact through the SEAM 1 reader — nothing recorded", () => {
    const slug = freshWorkspace();
    const dir = mkdtempSync(join(tmpdir(), "calib-chain-badart-"));
    const bad = join(dir, "rehearsal.toml");
    writeFileSync(bad, readFileSync(REHEARSAL, "utf8").replace("sim = true", "sim = false"));
    const res = recordCalibChain({ slug, leg: "mock", rehearsalRef: bad, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toMatch(/sim/i);
    expect(existsSync(join(problemDir(slug), "entities", "calib_chain.toml"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses honestly when no formulation is recorded (the chain pins onto the recorded formulation)", () => {
    const slug = freshWorkspace();
    rmSync(join(problemDir(slug), "entities", "formulation.toml"));
    rmSync(join(problemDir(slug), "entities", "formulation.json"));
    const res = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toMatch(/formulation/i);
  });

  it("stages the human-gated re-bank command with the chain's provenance flags (the promotion the chain never performs)", () => {
    const slug = freshWorkspace();
    const res = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    if (!res.ok) throw new Error(res.problem);
    expect(res.staged.rebankCommand).toContain("amico catalog ingest");
    expect(res.staged.rebankCommand).toContain("--platform transmon"); // from the recorded system
    expect(res.staged.rebankCommand).toContain("--kind X"); // from the recorded formulation target
    expect(res.staged.rebankCommand).toContain("--warm-start transmon-X-v1"); // which seed
    expect(res.staged.rebankCommand).toContain("--calibration-ref"); // which calibration
    expect(res.staged.rebankCommand).toContain("--pin delta=0.21"); // which pin
    expect(res.staged.humanGate).toMatch(/sign-off|human/i); // promotion is human-gated like all promotions
  });
});

describe("completeCalibChain — the verified re-bank leg (the execution record)", () => {
  const prevProblems = process.env.AMICODE_PROBLEMS_DIR;

  afterEach(() => {
    if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
    else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
  });

  /** A catalog entry's metadata.toml carrying the chain's fingerprint — the
   *  shape `amico catalog ingest --warm-start/--calibration-ref/--pin` writes
   *  (the amico-run suite round-trips those flags; here the plugin side only
   *  READS it). */
  function fakeCatalogEntry(root: string, id: string, provenance: { warm_start?: string; calibration_ref?: string; pinned_globals?: Record<string, number> }): string {
    const dir = join(root, "pulses", id);
    mkdirSync(dir, { recursive: true });
    const lines = ["schema_version = 1", `id = ${JSON.stringify(id)}`, 'platform = "transmon"', 'gate = "X"', "fidelity = 0.9999"];
    if (provenance.warm_start !== undefined) lines.push(`warm_start = ${JSON.stringify(provenance.warm_start)}`);
    if (provenance.calibration_ref !== undefined) lines.push(`calibration_ref = ${JSON.stringify(provenance.calibration_ref)}`);
    if (provenance.pinned_globals !== undefined) {
      const inner = Object.entries(provenance.pinned_globals).map(([k, v]) => `${k} = ${v}`).join(", ");
      lines.push(`pinned_globals = { ${inner} }`);
    }
    writeFileSync(join(dir, "metadata.toml"), lines.join("\n") + "\n");
    return join(dir, "metadata.toml");
  }

  it("refuses a staged chain (no promoted entry to verify) — nothing recorded, promotion stays pending", () => {
    const slug = freshWorkspace();
    const stage = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    if (!stage.ok) throw new Error(stage.problem);
    const res = completeCalibChain({ slug, rebankMetadataRef: "/nowhere/metadata.toml" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problem).toMatch(/human|sign-off|metadata/i);
    expect(readEvents(slug).some((e) => e.action === "executed_on_mock")).toBe(false);
  });

  it("refuses a mismatched fingerprint — the re-bank must carry THIS chain's provenance (which calibration, which pin, which seed)", () => {
    const slug = freshWorkspace();
    const stage = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    if (!stage.ok) throw new Error(stage.problem);
    const root = mkdtempSync(join(tmpdir(), "calib-chain-cat-"));
    // wrong seed in the note
    const wrongSeed = fakeCatalogEntry(root, "transmon-X-v2", { warm_start: "other-v9", calibration_ref: REHEARSAL, pinned_globals: { delta: 0.21 } });
    const res1 = completeCalibChain({ slug, rebankMetadataRef: wrongSeed });
    expect(res1.ok).toBe(false);
    // wrong pin in the note
    const wrongPin = fakeCatalogEntry(root, "transmon-X-v2", { warm_start: "transmon-X-v1", calibration_ref: REHEARSAL, pinned_globals: { delta: 0.5 } });
    const res2 = completeCalibChain({ slug, rebankMetadataRef: wrongPin });
    expect(res2.ok).toBe(false);
    // missing calibration ref
    const noCal = fakeCatalogEntry(root, "transmon-X-v2", { warm_start: "transmon-X-v1", pinned_globals: { delta: 0.21 } });
    const res3 = completeCalibChain({ slug, rebankMetadataRef: noCal });
    expect(res3.ok).toBe(false);
    expect(readEvents(slug).some((e) => e.action === "executed_on_mock")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("records the verified re-bank: the executed_on_mock event (the countable execution record) + the fingerprint in the chain entity", () => {
    const slug = freshWorkspace();
    const stage = recordCalibChain({ slug, leg: "mock", rehearsalRef: REHEARSAL, pinned: { delta: 0.21 }, warmStart: "transmon-X-v1" });
    if (!stage.ok) throw new Error(stage.problem);
    const root = mkdtempSync(join(tmpdir(), "calib-chain-cat-"));
    const meta = fakeCatalogEntry(root, "transmon-X-v2", { warm_start: "transmon-X-v1", calibration_ref: REHEARSAL, pinned_globals: { delta: 0.21 } });
    const res = completeCalibChain({ slug, rebankMetadataRef: meta });
    if (!res.ok) throw new Error(res.problem);
    expect(res.executed_on_mock).toBe(true);
    const events = readEvents(slug);
    const executed = events.filter((e) => e.action === "executed_on_mock");
    expect(executed).toHaveLength(1); // calib_pin_reopt_chain_executed_on_mock == 1
    expect(executed[0].entity).toBe("calib_chain");
    const chain = parse(readFileSync(join(problemDir(slug), "entities", "calib_chain.toml"), "utf8")) as any;
    expect(chain.calib_chain.promotion).toBe("human-gated-rebank-recorded");
    expect(chain.calib_chain.rebank.catalog_entry).toBe("transmon-X-v2");
    expect(chain.calib_chain.rebank.provenance.pinned_globals.delta).toBeCloseTo(0.21);
    rmSync(root, { recursive: true, force: true });
  });
});
