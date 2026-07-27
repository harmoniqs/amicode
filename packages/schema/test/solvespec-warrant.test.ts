// solvespec v5 — `plan_hash`, the field that lets amico-run's --spec gate join a
// launch to its capability warrant (spec-20260727-164748 §5.1).
//
// The load-bearing decision under test: `plan_hash` is OPTIONAL. §5.1 rule 1 makes
// its absence safe by restricting the launch to the ungated free set, so requiring it
// would break every existing spec while buying nothing. Its absence must never WIDEN
// what a launch may do — only restrict it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { validate, SUPPORTED_VERSIONS_BY_KIND } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const base = () =>
  parseToml(readFileSync(join(here, "fixtures", "valid", "solvespec.toml"), "utf8")) as Record<string, unknown>;

describe("solvespec v5 — registration", () => {
  it("v5 is a supported version (derived from the schema's own enum)", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND.solvespec).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("solvespec v5 — plan_hash", () => {
  it("a v5 spec carrying plan_hash validates", () => {
    const spec = { ...base(), schema_version: "5", plan_hash: "9f2c" };
    expect(validate(spec, "solvespec").errors).toEqual([]);
  });

  it("plan_hash is OPTIONAL — a v5 spec without it validates", () => {
    const spec = { ...base(), schema_version: "5" };
    expect(validate(spec, "solvespec").errors).toEqual([]);
  });

  it("an empty plan_hash fails — it would join every launch to any warrant", () => {
    const spec = { ...base(), schema_version: "5", plan_hash: "" };
    expect(validate(spec, "solvespec").ok).toBe(false);
  });

  it("plan_hash must be a string", () => {
    const spec = { ...base(), schema_version: "5", plan_hash: 42 };
    expect(validate(spec, "solvespec").ok).toBe(false);
  });

  it("earlier versions still validate — v5 is additive", () => {
    expect(validate(base(), "solvespec").errors).toEqual([]);
  });
});
