// Guards the OSS/FULL problemspec variant split (open-core containment).
//
// `packages/schema/schemas/` vendors TWO problemspec variants:
//
//   problemspec.schema.json      FULL  — emitted from PRIVATE Piccolissimo, and the
//                                       one registered as the `problemspec` kind.
//   problemspec.oss.schema.json  OSS   — emitted from public Piccolo, vendored for
//                                       package-access staging (Phase 3).
//
// Piccolo's own suite asserts the schema IT emits carries no private capability
// names. Nothing on this side asserted the vendored copies stayed distinct — so a
// re-vendor that wrote the FULL schema over the OSS filename (or shipped FULL from
// an OSS build) would silently expose private capability names, and every existing
// test would still pass because both files parse and validate identically well.
//
// The check is deliberately BIDIRECTIONAL. Asserting only "OSS lacks the private
// names" would still pass if someone vendored the OSS schema over BOTH filenames,
// quietly narrowing the shipped schema and rejecting specs Piccolissimo can really
// run. So we assert the private names are absent from OSS *and present in FULL*.
//
// Regenerate via each repo's src/specs/schema/regenerate.jl — never hand-edit.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schemas");
const read = (f: string) => readFileSync(join(schemaDir, f), "utf8");

// The private-only enum VALUES, computed by diffing the two vendored variants.
// These are capability names that exist only in Piccolissimo. Keep this list in
// sync with the same assertion in Piccolo's src/specs/schema/drift.jl.
const PRIVATE_ONLY = [
  "altissimo", // solver.backend
  "continuation", // solver.strategy
  "staged", // solver.strategy
  "hermite_bending_energy", // problem.objectives[].kind
  "hermite_c2", // problem.objectives[].kind
  "robust", // wrappers[].kind
] as const;

/** Every `enum` array value anywhere in a JSON Schema, flattened. Comparing enum
 *  values (not raw text) avoids false positives on public names that merely
 *  contain a private substring. */
function enumValues(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) enumValues(v, acc);
    return acc;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "enum" && Array.isArray(v)) for (const e of v) acc.add(String(e));
      else if (k === "const" && (typeof v === "string" || typeof v === "number")) acc.add(String(v));
      else enumValues(v, acc);
    }
  }
  return acc;
}

describe("problemspec OSS/FULL variant split", () => {
  const ossEnums = enumValues(JSON.parse(read("problemspec.oss.schema.json")));
  const fullEnums = enumValues(JSON.parse(read("problemspec.schema.json")));

  it("the OSS variant exposes NO private-only capability names", () => {
    const leaked = PRIVATE_ONLY.filter((n) => ossEnums.has(n));
    expect(leaked, `private capability names present in the OSS variant: ${leaked.join(", ")}`).toEqual([]);
  });

  it("the FULL variant DOES carry them (catches a mis-vendor in the other direction)", () => {
    const missing = PRIVATE_ONLY.filter((n) => !fullEnums.has(n));
    expect(
      missing,
      `FULL variant is missing private names (was the OSS schema vendored over it?): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("the two variants are not the same file", () => {
    expect(read("problemspec.oss.schema.json")).not.toEqual(read("problemspec.schema.json"));
  });

  it("both variants agree on the public surface (only private names differ)", () => {
    // Anything in FULL but not OSS must be an intentional private-only value. If
    // this trips, either a new private capability was added without listing it in
    // PRIVATE_ONLY, or a genuinely public value went missing from the OSS variant.
    const onlyInFull = [...fullEnums].filter((v) => !ossEnums.has(v)).sort();
    expect(onlyInFull).toEqual([...PRIVATE_ONLY].sort());
  });

  it("OSS is a strict subset: it introduces no value the FULL variant lacks", () => {
    const onlyInOss = [...ossEnums].filter((v) => !fullEnums.has(v));
    expect(onlyInOss, `OSS has values FULL lacks (variants built from divergent revisions?)`).toEqual([]);
  });
});
