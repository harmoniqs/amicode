// @amicode/schema — the single source of truth for amico's config + run-dir
// artifact shapes. JSON Schema files in ../schemas are the contract (shared
// verbatim with the Julia round-trip, 0.1d); this module compiles them with ajv
// and exposes ONE validate() consumed by the extension, the amico-run CLI, the
// amico-validate CLI, and CI. No consumer should define its own schema (regression).
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsDefault from "ajv-formats";

import runSchema from "../schemas/run.schema.json" with { type: "json" };
import finishedSchema from "../schemas/finished.schema.json" with { type: "json" };
import resultSchema from "../schemas/result.schema.json" with { type: "json" };
import labSchema from "../schemas/lab.schema.json" with { type: "json" };
import solvespecSchema from "../schemas/solvespec.schema.json" with { type: "json" };
import catalogEntrySchema from "../schemas/catalog-entry.schema.json" with { type: "json" };

// ajv-formats ships a CJS default export; under NodeNext the default import can
// bind the module namespace rather than the callable, so normalize defensively.
const addFormats = (typeof addFormatsDefault === "function"
  ? addFormatsDefault
  : (addFormatsDefault as unknown as { default: unknown }).default) as unknown as (ajv: Ajv) => void;

// The registry IS the schema set. Adding a schema = one import + one entry; the
// SchemaKind type and the CI conformance loop derive from it automatically.
const SCHEMAS = {
  run: runSchema,
  finished: finishedSchema,
  result: resultSchema,
  lab: labSchema,
  solvespec: solvespecSchema,
  "catalog-entry": catalogEntrySchema,
} as const;

export type SchemaKind = keyof typeof SCHEMAS;
export const SCHEMA_KINDS = Object.keys(SCHEMAS) as SchemaKind[];

/** Versions the validators accept, PER KIND (Q87: tolerate known-prior within
 *  range, reject unknown/absent). Derived from the schema files' enums — the
 *  schemas are the single source of truth; this export just surfaces them.
 *  run + solvespec are at v2 (spec C: executor/tier/env/source/hashes); the
 *  rest remain v1 and bump independently. */
export const SUPPORTED_VERSIONS_BY_KIND: Record<Exclude<SchemaKind, "finished">, string[]> = Object.fromEntries(
  (["run", "result", "lab", "solvespec", "catalog-entry"] as const).map((kind) => [
    kind,
    (SCHEMAS[kind] as { properties: { schema_version: { enum: string[] } } }).properties.schema_version.enum,
  ]),
) as Record<Exclude<SchemaKind, "finished">, string[]>;

export interface Validation { ok: boolean; errors: string[] }

/** Resolve a schema kind from a file's basename, for the fixed-filename artifacts
 *  (run.toml, result.toml, lab.toml, FINISHED). Returns undefined for files
 *  with no canonical name (SolveSpec, catalog-entry) — those need an explicit
 *  --schema. The amico-validate CLI uses this for file-role resolution. */
export function kindForFilename(filePath: string): SchemaKind | undefined {
  const base = filePath.replace(/^.*[\\/]/, "");
  if (base === "run.toml") return "run";
  if (base === "result.toml") return "result";
  if (base === "lab.toml") return "lab";
  if (base === "FINISHED") return "finished";
  return undefined;
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = new Map<SchemaKind, ValidateFunction>();
for (const [kind, schema] of Object.entries(SCHEMAS)) {
  compiled.set(kind as SchemaKind, ajv.compile(schema as object));
}

/** Validate an already-parsed artifact against its schema. Field-precise: every
 *  error names the offending key and its JSON-pointer path. */
export function validate(artifact: unknown, kind: SchemaKind): Validation {
  const v = compiled.get(kind);
  if (!v) return { ok: false, errors: [`unknown schema kind: ${kind}`] };
  const ok = v(artifact) as boolean;
  if (ok) return { ok: true, errors: [] };
  return { ok: false, errors: (v.errors ?? []).map(formatError) };
}

/** Validate a file on disk: read → parse (TOML, or JSON by extension) → validate.
 *  Parse/read failures are themselves field-precise-ish errors, never a throw. */
export function validateFile(filePath: string, kind: SchemaKind): Validation {
  let raw: string;
  try { raw = readFileSync(filePath, "utf8"); }
  catch (e) { return { ok: false, errors: [`cannot read ${filePath}: ${(e as Error).message}`] }; }
  let parsed: unknown;
  try { parsed = extname(filePath).toLowerCase() === ".json" ? JSON.parse(raw) : parseToml(raw); }
  catch (e) { return { ok: false, errors: [`${filePath}: parse error — ${(e as Error).message}`] }; }
  return validate(normalizeDates(parsed), kind);
}

/** smol-toml parses an UNQUOTED TOML datetime (`created_at = 2026-…Z`) into a Date
 *  object, which fails our `type: string` (`format: date-time`) fields. Coerce any
 *  Date back to its ISO-8601 string so quoted and unquoted datetimes validate
 *  identically — important for the cross-language schemas (a Julia TOML.print of a
 *  DateTime emits unquoted). Shallow + one level of nesting covers our shapes. */
function normalizeDates(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeDates(val);
    return out;
  }
  return v;
}

function formatError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  // The schema_version carrier gets a version-specific message (S14, #16 AC5 /
  // #17 AC3). An ABSENT version fails as `required` on the parent (handled below);
  // an UNRECOGNIZED version fails `enum` here.
  if (e.instancePath === "/schema_version" && e.keyword === "enum") {
    // Per-kind version sets: the enum error's own allowedValues IS the kind's set.
    const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    return `/schema_version: unrecognized version (supported: ${allowed.join(", ")})`;
  }
  switch (e.keyword) {
    case "required":
      return `${where}: missing required key "${(e.params as { missingProperty: string }).missingProperty}"`;
    case "additionalProperties":
      return `${where}: unknown key "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    case "enum": {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `${where}: must be one of (${allowed.join(", ")})`;
    }
    default:
      return `${where}: ${e.message ?? "invalid"}`;
  }
}
