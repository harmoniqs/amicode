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
  "adjoint_robustness", // problem.objectives[].kind (the Piccolissimo robust family)
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

  // ── The set-difference assertions above cannot see shape-level leaks ────────
  //
  // `enumValues` flattens every enum in the document into one Set, so a value is
  // invisible to it once that value appears ANYWHERE — e.g. a public kind that a
  // CONDITIONAL references cancels out of `onlyInFull` even if a future emission
  // offered it in the wrong place. The `offeredIntegratorKinds` positional checks
  // above exist for exactly this reason: they pin the enum a caller actually
  // chooses from to the public-kind set, so a schema that quietly grows an
  // offered integrator kind outside the registered public set fails here loudly
  // instead of cancelling out above. On the 2.2.0 surface the conditional for
  // spline pulses references `spline` — which IS an offered public kind now —
  // so the leak class this block guards has moved from "private kind offered"
  // to "unregistered kind offered": the equality assertions catch both.
  //
  // That is the exact open-core leak this file exists to prevent, so it needs a
  // positional check on the enum a caller actually chooses from. Reaching into a
  // fixed schema path is deliberately brittle: if the shape moves, this should
  // fail loudly and make someone re-derive the guard rather than silently stop
  // guarding.
  const offeredIntegratorKinds = (file: string): string[] => {
    const control = JSON.parse(read(file))?.oneOf?.[0];
    const kinds = control?.properties?.integrator?.properties?.kind?.enum;
    expect(
      Array.isArray(kinds),
      `${file}: could not read oneOf[0].properties.integrator.properties.kind.enum — ` +
        `the schema shape changed, so this guard needs rewriting, not deleting`,
    ).toBe(true);
    return [...(kinds as string[])].sort();
  };

  // The public integrator kinds as of the Piccolo 2.2.0 open-core surface: the
  // BilinearIntegrator demotion (#334) and slice 3b (#430) made the native
  // integrator tier public — spline and the hermitian/nonhermitian exponential
  // families are REGISTERED kinds in Piccolo's own registry now (Piccolo's
  // src/specs/schema/drift.jl dropped them from its private-exclusion list in
  // lockstep). The paid surface no longer lives in offered integrator kinds;
  // it lives in the PRIVATE_ONLY capabilities above.
  const PUBLIC_INTEGRATOR_KINDS = [
    "bilinear",
    "hermitian_exponential",
    "nonhermitian_exponential",
    "spline",
  ];

  it("the OSS variant offers exactly the public integrator kinds", () => {
    expect(offeredIntegratorKinds("problemspec.oss.schema.json")).toEqual(
      [...PUBLIC_INTEGRATOR_KINDS].sort(),
    );
  });

  it("the FULL variant offers exactly the public integrator kinds", () => {
    expect(offeredIntegratorKinds("problemspec.schema.json")).toEqual(
      [...PUBLIC_INTEGRATOR_KINDS].sort(),
    );
  });

  it("no private integrator kind remains (the 2.2.0 demotion made the tier public)", () => {
    const oss = offeredIntegratorKinds("problemspec.oss.schema.json");
    const full = offeredIntegratorKinds("problemspec.schema.json");
    expect(full.filter((k) => !oss.includes(k)).sort()).toEqual([]);
    // And nothing OSS offers is missing from FULL (the other mis-vendor direction).
    expect(oss.filter((k) => !full.includes(k))).toEqual([]);
  });
});
