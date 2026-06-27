import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  validate, validateFile, SCHEMA_KINDS, SUPPORTED_SCHEMA_VERSIONS, type SchemaKind,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const validDir = join(here, "fixtures", "valid");
const fixtureFile = (kind: SchemaKind) => join(validDir, `${kind}.toml`);
const load = (kind: SchemaKind) => parseToml(readFileSync(fixtureFile(kind), "utf8")) as Record<string, unknown>;
const hasErr = (errs: string[], needle: string) => errs.some((e) => e.includes(needle));

// ── the shared golden corpus (also consumed by 0.1c CLI + 0.1d Julia round-trip) ──
describe("valid golden fixtures validate clean", () => {
  for (const kind of SCHEMA_KINDS) {
    it(`${kind}: fixture conforms`, () => {
      const r = validateFile(fixtureFile(kind), kind);
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
    });
  }
});

describe("schema set + exports", () => {
  it("exposes all five versioned schemas + the FINISHED sub-shape", () => {
    expect(new Set(SCHEMA_KINDS)).toEqual(
      new Set(["manifest", "result", "lab", "solvespec", "catalog-entry", "finished"]),
    );
  });
  it("SUPPORTED_SCHEMA_VERSIONS is the v1 instantiation of a version SET", () => {
    expect([...SUPPORTED_SCHEMA_VERSIONS]).toEqual(["1"]);
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
    for (const kind of ["manifest", "result", "lab", "solvespec", "catalog-entry"] as SchemaKind[]) {
      const obj = load(kind); delete obj.schema_version;
      const r = validate(obj, kind);
      expect(r.ok).toBe(false);
      expect(hasErr(r.errors, "missing required key \"schema_version\"")).toBe(true);
    }
  });
  it("UNRECOGNIZED version → distinct version-specific error", () => {
    const obj = load("manifest"); obj.schema_version = "99";
    const r = validate(obj, "manifest");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "/schema_version: unrecognized version")).toBe(true);
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
  it("missing required key → names the absent key + path", () => {
    const m = load("manifest"); delete m.run_id;
    expect(hasErr(validate(m, "manifest").errors, 'missing required key "run_id"')).toBe(true);
    const j = load("manifest"); (j.julia as Record<string, unknown>).binary = undefined; delete (j.julia as Record<string, unknown>).binary;
    expect(hasErr(validate(j, "manifest").errors, "/julia")).toBe(true);
  });
  it("wrong type → names the offending key (incl. #18 AC3 non-numeric fidelity)", () => {
    const r = load("result"); r.fidelity = "high";
    const v = validate(r, "result");
    expect(v.ok).toBe(false);
    expect(hasErr(v.errors, "/fidelity")).toBe(true);
  });
  it("unknown key (top level) → names the offending key", () => {
    const r = load("result"); r.bogus = 1;
    expect(hasErr(validate(r, "result").errors, 'unknown key "bogus"')).toBe(true);
  });
  it("out-of-range → field-precise (fidelity > 1; lab levels out of bound) [M3]", () => {
    const r = load("result"); r.fidelity = 1.5;
    expect(hasErr(validate(r, "result").errors, "/fidelity")).toBe(true);
    const lab = load("lab"); (lab.qubit as Record<string, unknown>).levels = 99;
    expect(hasErr(validate(lab, "lab").errors, "/qubit/levels")).toBe(true);
  });
  it("FINISHED bad status → field-precise enum error", () => {
    const r = validate({ status: "halfway", exit_code: 0 }, "finished");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "/status")).toBe(true);
  });
  it("params sub-table is lenient (mixed int/float + extra keys allowed) [M2]", () => {
    const r = load("result");
    (r.params as Record<string, unknown>).future_knob = 7;       // unknown param OK
    (r.params as Record<string, unknown>).levels = 4.0;          // float where int-ish OK
    expect(validate(r, "result").ok).toBe(true);
  });
});

// ── migration: the contract formalize-don't-fork guarantee (S2) ──
describe("formalize-don't-fork: real beta.1 artifacts validate under the closed schemas", () => {
  it("a beta.1 manifest (writeManifest shape) + schema_version validates clean", () => {
    // EXACT shape amico-run/src/run_dir.ts writeManifest emits.
    const m = {
      schema_version: "1", run_id: "r20260101-000000Z-aaaa", script_path: "/s.jl",
      lab: "default", lab_id: "default", created_at: "2026-01-01T00:00:00.000Z",
      orchestrator_version: "0.1.0", julia: { binary: "julia", project: "/p", sysimage: "/img.so" },
    };
    expect(validate(m, "manifest")).toEqual({ ok: true, errors: [] });
  });
  it("a beta.1 result.toml WITHOUT schema_version is now rejected (the documented migration: 0.1a adds the emit)", () => {
    const old = { fidelity: 0.9999, iterations: 60, wall_seconds: 12.3, params: { levels: 3 } };
    const r = validate(old, "result");
    expect(r.ok).toBe(false);
    expect(hasErr(r.errors, "schema_version")).toBe(true);
  });
});

// The REAL bundled demo run dir (β.6 replay fallback) must conform under the
// closed schemas — it's a shipped artifact the inspector reads (M4).
describe("bundled demo run dir conforms", () => {
  const demoDir = join(here, "..", "..", "extension", "demo", "run");
  it("manifest.toml, FINISHED, result.toml all validate", () => {
    expect(validateFile(join(demoDir, "manifest.toml"), "manifest").errors).toEqual([]);
    expect(validateFile(join(demoDir, "FINISHED"), "finished").errors).toEqual([]);
    expect(validateFile(join(demoDir, "result.toml"), "result").errors).toEqual([]);
  });
});
