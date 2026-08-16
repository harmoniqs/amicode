// The `pack` schema kind (autoresearch studio WS1, #369): one manifest per
// domain — skills, template registry, corrector with integrity manifest,
// catalog schema, onboarding score, eval corpus pointer. A score is one FIELD
// of a pack. The per-entry `tier` encodes the open-core boundary.
import { describe, it, expect } from "vitest";
import { validate, SUPPORTED_VERSIONS_BY_KIND, kindForFilename } from "../src/index.js";

const pack = (over: Record<string, unknown> = {}) => ({
  schema_version: "1",
  id: "quantum-control",
  name: "Quantum Control",
  version: 1,
  scores: ["scores/overture", "scores/pulse-designer", "scores/pasqal-mis"],
  onboarding: { primary: "pulse-designer", head: "overture" },
  skills: [{ path: "skills/transmon", tier: "open" }],
  templates: { solve: { path: "templates/solve_template.jl", tier: "open" } },
  corrector: {
    name: "amico-run verification",
    paths: ["corrector/verify.sh"],
    integrity: "corrector/integrity.toml",
    tier: "open",
  },
  catalog_schema: "catalog-entry",
  eval_corpus: "prova://corpora/pulse-design",
  ...over,
});
const drop = (o: Record<string, unknown>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};

describe("the pack kind", () => {
  it("accepts a complete pack manifest", () => {
    expect(validate(pack(), "pack")).toMatchObject({ ok: true });
  });
  it("accepts a minimal manifest — optional sections absent, tier defaults open", () => {
    expect(
      validate(
        pack({ skills: undefined, templates: undefined, version: undefined, catalog_schema: undefined, eval_corpus: undefined }),
        "pack",
      ),
    ).toMatchObject({ ok: true });
  });
  it("rejects an unknown top-level key (strict shape: we own both sides)", () => {
    expect(validate(pack({ modes: [] }), "pack").ok).toBe(false);
  });
  it("rejects an unrecognized schema_version", () => {
    expect(validate(pack({ schema_version: "2" }), "pack").ok).toBe(false);
  });
  it("requires the onboarding primary score — a score is a FIELD of a pack", () => {
    expect(validate(pack({ onboarding: { head: "overture" } }), "pack").ok).toBe(false);
  });
  it("requires a non-empty scores list", () => {
    expect(validate(pack({ scores: [] }), "pack").ok).toBe(false);
  });
  it("requires corrector.integrity — the threshold condition is a load-time property, not a convention", () => {
    const c = { ...(pack().corrector as object) } as Record<string, unknown>;
    delete c.integrity;
    expect(validate(pack({ corrector: c }), "pack").ok).toBe(false);
  });
  it("requires corrector.paths to be non-empty", () => {
    const c = { ...(pack().corrector as object) } as Record<string, unknown>;
    c.paths = [];
    expect(validate(pack({ corrector: c }), "pack").ok).toBe(false);
  });
  it("tier accepts an entitlement bundle id, rejects garbage", () => {
    expect(validate(pack({ skills: [{ path: "s", tier: "issimo" }] }), "pack").ok).toBe(true);
    expect(validate(pack({ skills: [{ path: "s", tier: "Not A Tier" }] }), "pack").ok).toBe(false);
  });
  it("tiered entries require a path", () => {
    expect(validate(pack({ templates: { solve: { tier: "open" } } }), "pack").ok).toBe(false);
  });
  it("pack id is kebab-case free-form, not an enum — the taxonomy is manifest data", () => {
    expect(validate(pack({ id: "qec" }), "pack").ok).toBe(true);
    expect(validate(pack({ id: "QEC Pack" }), "pack").ok).toBe(false);
  });
  it("drops the whole pack on a missing required top-level key", () => {
    for (const k of ["id", "name", "scores", "onboarding", "corrector"] as const)
      expect(validate(drop(pack(), k), "pack").ok, k).toBe(false);
  });
});

describe("registration", () => {
  it("carries a version, so the module does not crash at load", () => {
    expect(SUPPORTED_VERSIONS_BY_KIND.pack).toEqual(["1"]);
  });
  it("resolves PACK.toml by filename", () => {
    expect(kindForFilename("/any/where/PACK.toml")).toBe("pack");
  });
});
