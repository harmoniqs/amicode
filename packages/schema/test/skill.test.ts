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
});
