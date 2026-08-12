import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { validate, validateFile, SCHEMA_KINDS, SUPPORTED_VERSIONS_BY_KIND, type SchemaKind } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const validDir = join(here, "fixtures", "valid");
const fixtureFile = (kind: SchemaKind) => join(validDir, `${kind}.toml`);
const load = (kind: SchemaKind) => parseToml(readFileSync(fixtureFile(kind), "utf8")) as Record<string, unknown>;
const hasErr = (errs: string[], needle: string) => errs.some((e) => e.includes(needle));

// ── the shared golden corpus (also consumed by 0.1c CLI + 0.1d Julia round-trip) ──
describe("valid golden fixtures validate clean", () => {
  // ledger-record is JSONL ops-data (runs.jsonl), not a TOML run-dir artifact, so it
  // carries no golden .toml fixture and is not part of the Julia round-trip corpus —
  // it has its own dedicated coverage in ledger-record.test.ts.
  // `spec` and `plan` join ledger-record in the exclusion: both are MARKDOWN-frontmatter
  // kinds with no TOML fixture form, so there is no `fixtures/valid/<kind>.toml` to load.
  // `problemspec-oss` is the entitlement-keyed OSS subset (W2.4) — no separate fixture.
  for (const kind of SCHEMA_KINDS.filter((k) => k !== "ledger-record" && k !== "spec" && k !== "plan" && k !== "problemspec-oss")) {
    it(`${kind}: fixture conforms`, () => {
      const r = validateFile(fixtureFile(kind), kind);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});

describe("schema set + exports", () => {
  it("exposes all five versioned schemas + the FINISHED sub-shape + the problemspec + ledger-record kinds", () => {
    expect(new Set(SCHEMA_KINDS)).toEqual(
      new Set([
        "run", "result", "lab", "solvespec", "catalog-entry", "finished", "problemspec", "problemspec-oss", "ledger-record",
        // the deliberation artifacts (spec-20260728)
        "spec", "plan",
      ]),
    );
  });
  it("supported versions are PER-KIND: run at v2 (spec C); solvespec at v5 (v4 hpc tier + remote executor + problem_spec; v5 plan_hash); the rest v1", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND).toEqual({
      run: ["1", "2"],
      solvespec: ["1", "2", "3", "4", "5"],
      result: ["1"],
      lab: ["1"],
      "catalog-entry": ["1"],
      // the deliberation artifacts (spec-20260728): both DO carry a top-level
      // schema_version enum, so unlike problemspec/ledger-record they join the map.
      spec: ["1"],
      plan: ["1"],
    });
  });
  it("an unknown kind is a clean error, not a throw", () => {
    const r = validate({}, "nope" as SchemaKind);
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "unknown schema kind")).toBe(true);
  });
});

// ── schema_version policy (S5/S6, #15 AC3, #16 AC5, #17 AC3) ──
describe("schema_version policy", () => {
  it("ABSENT version → field-precise missing-required (the five versioned schemas)", () => {
    for (const kind of ["run", "result", "lab", "solvespec", "catalog-entry"] as SchemaKind[]) {
      const obj = load(kind);
      delete obj.schema_version;
      const r = validate(obj, kind);
      expect(r.ok).toBe(false);
      expect(hasErr(r.errors, 'missing required key "schema_version"')).toBe(true);
    }
  });
  it("UNRECOGNIZED version → distinct version-specific error (all five versioned schemas)", () => {
    for (const kind of ["run", "result", "lab", "solvespec", "catalog-entry"] as SchemaKind[]) {
      const obj = load(kind);
      obj.schema_version = "99";
      const r = validate(obj, kind);
      expect(r.ok).toBe(false);
      expect(hasErr(r.errors, "/schema_version: unrecognized version")).toBe(true);
    }
  });
  it("every versioned schema's enum is in sync with its per-kind version set (no drift seam)", () => {
    const schemasDir = join(here, "..", "schemas");
    for (const kind of ["run", "result", "lab", "solvespec", "catalog-entry"] as const) {
      const schema = JSON.parse(readFileSync(join(schemasDir, `${kind}.schema.json`), "utf8"));
      expect(schema.properties.schema_version.enum, `${kind} enum drift`).toEqual(SUPPORTED_VERSIONS_BY_KIND[kind]);
    }
  });
  it("FINISHED is a sub-shape — it carries NO schema_version and adding one is rejected", () => {
    expect(validate({ status: "completed", exit_code: 0 }, "finished").ok).toBe(true);
    const r = validate({ status: "completed", exit_code: 0, schema_version: "1" }, "finished");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, 'unknown key "schema_version"')).toBe(true);
  });
});

// ── field-precise negative matrix (#15 AC2, #16/#17 AC, #18 AC2/3) ──
describe("field-precise negative matrix", () => {
  it("missing required key → names the absent key + path (top-level + nested)", () => {
    const m = load("run");
    delete m.run_id;
    expect(hasErr(validate(m, "run").errors, 'missing required key "run_id"')).toBe(true);
    const j = load("run");
    delete (j.julia as Record<string, unknown>).binary;
    expect(hasErr(validate(j, "run").errors, '/julia: missing required key "binary"')).toBe(true);
  });
  it("wrong-type and out-of-range are reported DISTINCTLY + field-precise (#18 AC3)", () => {
    const wrong = load("result");
    wrong.fidelity = "high";
    expect(hasErr(validate(wrong, "result").errors, "/fidelity: must be number")).toBe(true); // wrong type
    const over = load("result");
    over.fidelity = 1.5;
    expect(hasErr(validate(over, "result").errors, "/fidelity: must be <= 1.0001")).toBe(true); // out of range — distinct
    const lab = load("lab");
    (lab.transmon as Record<string, unknown>).levels = 99;
    expect(hasErr(validate(lab, "lab").errors, "/transmon/levels: must be <= 10")).toBe(true);
  });
  it("unknown key (top level) → names the offending key", () => {
    const r = load("result");
    r.bogus = 1;
    expect(hasErr(validate(r, "result").errors, 'unknown key "bogus"')).toBe(true);
  });
  it("a legitimately-converged fidelity slightly over 1.0 still validates (S1: no false-reject)", () => {
    const r = load("result");
    r.fidelity = 1.0000000002;
    expect(validate(r, "result").ok).toBe(true);
  });
  it("catalog-entry + solvespec negatives are field-precise (#15 AC8 / #17 AC5) [S5/S6]", () => {
    const c = load("catalog-entry");
    delete c.pulse_path;
    expect(hasErr(validate(c, "catalog-entry").errors, 'missing required key "pulse_path"')).toBe(true);
    const c2 = load("catalog-entry");
    c2.fidelity = "x";
    expect(hasErr(validate(c2, "catalog-entry").errors, "/fidelity: must be number")).toBe(true);
    const s = load("solvespec");
    delete s.lab_id;
    expect(hasErr(validate(s, "solvespec").errors, 'missing required key "lab_id"')).toBe(true);
    const s2 = load("solvespec");
    s2.unexpected = 1;
    expect(hasErr(validate(s2, "solvespec").errors, 'unknown key "unexpected"')).toBe(true);
  });
  it("solvespec v3: hpc tier + remote executor validate; unknown tier/executor rejected", () => {
    const hpc = load("solvespec");
    hpc.schema_version = "3";
    hpc.tier = "hpc";
    hpc.executor = "remote";
    hpc.env = { kind: "provisioned" };
    expect(validate(hpc, "solvespec").ok).toBe(true);
    // a plain local free spec still validates unchanged (Piccolo path)
    const free = load("solvespec");
    free.tier = "free";
    free.executor = "local";
    free.env = { kind: "sandbox", project: "/tmp/x" };
    expect(validate(free, "solvespec").ok).toBe(true);
    // garbage tier / executor are field-precise enum errors
    const badTier = load("solvespec");
    badTier.tier = "premium";
    expect(hasErr(validate(badTier, "solvespec").errors, "/tier")).toBe(true);
    const badExec = load("solvespec");
    badExec.executor = "gpu";
    expect(hasErr(validate(badExec, "solvespec").errors, "/executor")).toBe(true);
  });
  it("lab hardware range bounds + name minLength are field-precise (#29)", () => {
    const hi = load("lab");
    (hi.transmon as Record<string, unknown>).omega_GHz = 999;
    expect(hasErr(validate(hi, "lab").errors, "/transmon/omega_GHz: must be <= 100")).toBe(true);
    const dm = load("lab");
    (dm.transmon as Record<string, unknown>).drive_max_GHz = 50;
    expect(hasErr(validate(dm, "lab").errors, "/transmon/drive_max_GHz: must be <= 10")).toBe(true);
    const d = load("lab");
    (d.transmon as Record<string, unknown>).delta_GHz = 25; // garbage anharmonicity
    expect(hasErr(validate(d, "lab").errors, "/transmon/delta_GHz: must be <= 2")).toBe(true);
    const nm = load("lab");
    (nm.lab as Record<string, unknown>).name = "";
    expect(hasErr(validate(nm, "lab").errors, "/lab/name")).toBe(true); // minLength
  });
  it("FINISHED bad status → field-precise enum error", () => {
    const r = validate({ status: "halfway", exit_code: 0 }, "finished");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "/status")).toBe(true);
  });
  it("params sub-table is lenient (mixed int/float + extra keys allowed) [M2]", () => {
    const r = load("result");
    (r.params as Record<string, unknown>).future_knob = 7; // unknown param OK
    (r.params as Record<string, unknown>).levels = 4.0; // float where int-ish OK
    expect(validate(r, "result").ok).toBe(true);
  });
});

describe("result.toml spline/free-phase fields (spec-20260704-113005 §6, additive)", () => {
  const base = { schema_version: "1", fidelity: 0.9991, iterations: 42 };

  it("accepts pulse_kind spline with free-phase declaration", () => {
    expect(
      validate(
        {
          ...base,
          pulse_kind: "spline",
          fidelity_convention: "free_phase",
          free_phases: [0.12, -1.7],
          subsystem_levels: [2, 3],
        },
        "result",
      ).ok,
    ).toBe(true);
  });
  it("accepts plain PWC results unchanged (fields all optional)", () => {
    expect(validate(base, "result").ok).toBe(true);
  });
  it("rejects unknown pulse_kind", () => {
    expect(validate({ ...base, pulse_kind: "wavelet" }, "result").ok).toBe(false);
  });
  it("rejects subsystem_levels below 2", () => {
    expect(validate({ ...base, subsystem_levels: [2, 1] }, "result").ok).toBe(false);
  });
  it("rejects non-numeric free_phases", () => {
    expect(validate({ ...base, free_phases: ["pi"] }, "result").ok).toBe(false);
  });
});

// ── migration: the contract formalize-don't-fork guarantee (S2) ──
describe("formalize-don't-fork: real beta.1 artifacts validate under the closed schemas", () => {
  it("a beta.1 manifest (writeManifest shape) + schema_version validates clean", () => {
    // EXACT shape amico-run/src/run_dir.ts writeManifest emits.
    const m = {
      schema_version: "1",
      run_id: "r20260101-000000Z-aaaa",
      script_path: "/s.jl",
      lab: "default",
      lab_id: "default",
      created_at: "2026-01-01T00:00:00.000Z",
      orchestrator_version: "0.1.0",
      julia: { binary: "julia", project: "/p", sysimage: "/img.so" },
    };
    expect(validate(m, "run")).toEqual({ ok: true, errors: [] });
  });
  it("a beta.1 result.toml WITHOUT schema_version is now rejected (the documented migration: 0.1a adds the emit)", () => {
    const old = { fidelity: 0.9999, iterations: 60, wall_seconds: 12.3, params: { levels: 3 } };
    const r = validate(old, "result");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "schema_version")).toBe(true);
  });
});

// validateFile must accept an UNQUOTED TOML datetime (smol-toml parses it to a
// Date) the same as a quoted ISO string — important for cross-language emit (S2).
describe("validateFile tolerates unquoted TOML datetimes", () => {
  it("an unquoted created_at validates identically to a quoted one", () => {
    const dir = mkdtempSync(join(tmpdir(), "labfx-"));
    const f = join(dir, "run.toml");
    writeFileSync(
      f,
      'schema_version = "1"\nrun_id = "r1"\nscript_path = "/s.jl"\nlab = "default"\n' +
        'lab_id = "default"\ncreated_at = 2026-06-15T00:00:00Z\norchestrator_version = "0.1.0"\n' +
        '[julia]\nbinary = "julia"\n',
    ); // NOTE: unquoted datetime
    expect(validateFile(f, "run").errors).toEqual([]);
  });
});

// The REAL bundled demo run dir (β.6 replay fallback) must conform under the
// closed schemas — it's a shipped artifact the inspector reads (M4).
describe("bundled demo run dir conforms", () => {
  const demoDir = join(here, "..", "..", "extension", "demo", "run");
  it("run.toml, FINISHED, result.toml all validate", () => {
    expect(validateFile(join(demoDir, "run.toml"), "run").errors).toEqual([]);
    expect(validateFile(join(demoDir, "FINISHED"), "finished").errors).toEqual([]);
    expect(validateFile(join(demoDir, "result.toml"), "result").errors).toEqual([]);
  });
});

// ── v2 (spec C): SolveSpec executor/tier/env/source/hashes + run.toml tier/hashes ──
describe("v2 (spec C)", () => {
  const specV2 = {
    schema_version: "2",
    script_path: "/w/solve.jl",
    lab_id: "default",
    executor: "local",
    tier: "free",
    env: { kind: "sandbox", project: "/w/env" },
    source: {},
    hashes: { system_hash: "sha256:ab", formulation_hash: "sha256:cd" },
  };
  it("accepts a full v2 solvespec and still accepts v1", () => {
    expect(validate(specV2, "solvespec").errors).toEqual([]);
    expect(validate({ schema_version: "1", script_path: "/s.jl", lab_id: "default" }, "solvespec").ok).toBe(true);
  });
  it('accepts executor "remote" — the Δ10 (#63) routing choice the SolveSpec carries upstream', () => {
    // The routing confirm sets executor to "remote" when the researcher picks
    // company compute; only "local" existed before this slice.
    expect(validate({ ...specV2, executor: "remote" }, "solvespec").errors).toEqual([]);
  });
  it("rejects bad tier / executor / env.kind field-precisely", () => {
    expect(validate({ ...specV2, tier: "trusted" }, "solvespec").errors.join()).toMatch(/tier/);
    expect(validate({ ...specV2, executor: "cloud" }, "solvespec").errors.join()).toMatch(/executor/);
    expect(validate({ ...specV2, env: { kind: "docker" } }, "solvespec").errors.join()).toMatch(/kind/);
  });
  it("run v2: tier + [hashes] (all four keys) accepted; v1 manifests still valid", () => {
    const run1 = {
      schema_version: "1",
      run_id: "r",
      script_path: "/s.jl",
      lab: "default",
      lab_id: "default",
      created_at: "2026-07-03T00:00:00Z",
      orchestrator_version: "0.1.0",
      julia: { binary: "julia" },
    };
    expect(validate(run1, "run").ok).toBe(true);
    expect(
      validate(
        {
          ...run1,
          schema_version: "2",
          tier: "free",
          hashes: {
            system_hash: "sha256:ab",
            formulation_hash: "sha256:cd",
            warm_start_hash: "sha256:ef",
            spec_hash: "sha256:01",
          },
        },
        "run",
      ).errors,
    ).toEqual([]);
    expect(validate({ ...run1, schema_version: "2", tier: "nope" }, "run").errors.join()).toMatch(/tier/);
  });
});

// ── v4 (spec C): SolveSpec grows `problem_spec` (Piccolo.Specs.solve_spec target),
// exactly one of {script_path, problem_spec}. lab_id stays required; strict-unknown
// stays. A problem_spec spec routes to the generic runner (amico-run Task 8). ──
describe("v4 (spec C): problem_spec XOR script_path", () => {
  const base = { schema_version: "4", lab_id: "default" };
  it("accepts a problem_spec-only spec (path string)", () => {
    expect(validate({ ...base, problem_spec: "/w/problem.toml" }, "solvespec").errors).toEqual([]);
  });
  it("accepts a problem_spec-only spec (inline object)", () => {
    const inline = { kind: "control", system: { kind: "template", template: "TransmonSystem" } };
    expect(validate({ ...base, problem_spec: inline }, "solvespec").errors).toEqual([]);
  });
  it("accepts a script_path-only spec unchanged (the historical shape)", () => {
    expect(validate({ ...base, script_path: "/w/solve.jl" }, "solvespec").ok).toBe(true);
    // and earlier versions still validate (v1 script_path spec)
    expect(validate({ schema_version: "1", script_path: "/s.jl", lab_id: "default" }, "solvespec").ok).toBe(true);
  });
  it("REJECTS both script_path AND problem_spec together (exactly one)", () => {
    const r = validate({ ...base, script_path: "/w/solve.jl", problem_spec: "/w/problem.toml" }, "solvespec");
    expect(r.ok).toBe(false);
  });
  it("REJECTS neither script_path NOR problem_spec (exactly one)", () => {
    const r = validate({ ...base }, "solvespec");
    expect(r.ok).toBe(false);
  });
  it("lab_id is still required even with problem_spec", () => {
    const r = validate({ schema_version: "4", problem_spec: "/w/problem.toml" }, "solvespec");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, 'missing required key "lab_id"')).toBe(true);
  });
  it("strict-unknown still holds alongside problem_spec", () => {
    const r = validate({ ...base, problem_spec: "/w/problem.toml", rogue: 1 }, "solvespec");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, 'unknown key "rogue"')).toBe(true);
  });
  it("schema_version 4 is accepted", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND.solvespec).toContain("4");
  });
});
