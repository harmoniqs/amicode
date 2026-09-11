// The `skill` kind (amicode#996): the SKILL.md frontmatter contract —
// codifying exactly what the extension's loader enforces today (required
// name + description), lenient on the passthrough extras no loader reads so
// the schema never blocks a legitimate extension. Frontmatter-shaped, so it
// follows the library-paper registration precedent: registered in SCHEMAS,
// excluded from the version map (skills carry no schema_version).
import { describe, it, expect } from "vitest";
import { validate, SUPPORTED_VERSIONS_BY_KIND } from "../src/index.js";

const skill = (over: Record<string, unknown> = {}) => ({
  name: "atoms",
  description: "Neutral-atom Rydberg qubit physics, Hamiltonian, register geometry, and Piccolo setup.",
  ...over,
});
const drop = (o: Record<string, unknown>, k: string) => {
  const c = { ...o };
  delete c[k];
  return c;
};

describe("the skill kind", () => {
  it("accepts a minimal skill — only name + description (the loader's required set)", () => {
    expect(validate(drop(skill(), "surface"), "skill")).toMatchObject({ ok: true });
  });
  it("accepts a full shipped shape — surface, agents, passthrough extras, source + revision", () => {
    expect(
      validate(
        skill({
          surface: "public",
          agents: ["researcher", "librarian"],
          scenarios: ["spec-underspecified-must-block"],
          vault_contract: { folders: ["experiments", "insights"] },
          provides_helpers: ["a.jl"],
          public_refs: ["packages/Piccolo.jl"],
          cli_tool: "~/.local/bin/amico-slack",
          stub: true,
          source: "amicode",
          revision: 1,
        }),
        "skill",
      ),
    ).toMatchObject({ ok: true });
  });
  it("rejects a missing or empty name", () => {
    expect(validate(drop(skill(), "name"), "skill").ok).toBe(false);
    expect(validate(skill({ name: "" }), "skill").ok).toBe(false);
    expect(validate(skill({ name: 3 }), "skill").ok).toBe(false);
  });
  it("rejects a missing or empty description", () => {
    expect(validate(drop(skill(), "description"), "skill").ok).toBe(false);
    expect(validate(skill({ description: "" }), "skill").ok).toBe(false);
  });
  it("rejects a surface outside {public, entitled, internal}", () => {
    expect(validate(skill({ surface: "sideways" }), "skill").ok).toBe(false);
  });
  it("rejects a revision that is not a non-negative integer", () => {
    expect(validate(skill({ revision: -1 }), "skill").ok).toBe(false);
    expect(validate(skill({ revision: 1.5 }), "skill").ok).toBe(false);
    expect(validate(skill({ revision: "2" }), "skill").ok).toBe(false);
    expect(validate(skill({ revision: 0 }), "skill")).toMatchObject({ ok: true });
  });
  it("the entitlement pairing: surface: entitled REQUIRES a non-empty entitlement code", () => {
    expect(validate(skill({ surface: "entitled" }), "skill").ok).toBe(false);
    expect(validate(skill({ surface: "entitled", entitlement: "" }), "skill").ok).toBe(false);
    expect(validate(skill({ surface: "entitled", entitlement: "issimo" }), "skill")).toMatchObject({ ok: true });
  });
  it("the entitlement pairing: an entitlement on a non-entitled skill is flagged", () => {
    expect(validate(skill({ surface: "public", entitlement: "issimo" }), "skill").ok).toBe(false);
    expect(validate(skill({ surface: "internal", entitlement: "issimo" }), "skill").ok).toBe(false);
    expect(validate(skill({ entitlement: "issimo" }), "skill").ok).toBe(false); // untagged is not entitled either
  });
  it("accepts the real entitled shape (Intonatissimo) and an empty agents list (brainstorming)", () => {
    expect(validate(skill({ surface: "entitled", entitlement: "issimo" }), "skill")).toMatchObject({ ok: true });
    expect(validate(skill({ surface: "public", agents: [] }), "skill")).toMatchObject({ ok: true });
  });
  it("registered WITHOUT a version map entry — frontmatter carries no schema_version (the library-paper pattern)", () => {
    expect((SUPPORTED_VERSIONS_BY_KIND as Record<string, string[]>)["skill"]).toBeUndefined();
  });
});
