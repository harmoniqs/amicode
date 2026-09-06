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
// problemspec is VENDORED from the Piccolo/Piccolissimo registries — do not hand-edit.
// The shipped default (registered as the `problemspec` kind) is the FULL variant
// (harmoniqs/Piccolissimo.jl @ 9098f6f, built against Piccolo.jl @ c3884122); the OSS
// variant (Piccolo.jl @ c3884122) is vendored alongside as problemspec.oss.schema.json
// for package-access staging (Phase 3). Provenance shas live in the *.schema.json.sha
// sidecars (kept OUT of the JSON so the vendored files stay byte-identical to the
// emitted schemas for the cross-repo vendoring-drift gate). Regenerate via each repo's
// src/specs/schema/regenerate.jl.
import problemspecSchema from "../schemas/problemspec.schema.json" with { type: "json" };
// ledger-record is a top-level `oneOf` discriminated on `type` (six record kinds);
// like problemspec it has NO top-level properties.schema_version — see the SCHEMAS
// note below and the SUPPORTED_VERSIONS_BY_KIND exclusion.
import ledgerRecordSchema from "../schemas/ledger-record.schema.json" with { type: "json" };
// The deliberation artifacts (spec-20260728). Both are MARKDOWN-frontmatter shapes, so
// neither has a canonical filename and `kindForFilename` gains no entry — the kind is
// always explicit. Registered AFTER ledger-record on purpose: `spec.budget` $refs
// ledger-record's $defs.bounds, and the compile loop below resolves refs in insertion
// order, so an earlier entry cannot reference a later one.
import specSchema from "../schemas/spec.schema.json" with { type: "json" };
import planSchema from "../schemas/plan.schema.json" with { type: "json" };
// The pack manifest (autoresearch studio WS1, #369) — the unit of generality
// for a domain pack. Registered AFTER plan: it references nothing, but keeping
// the insertion order append-only makes the $ref-resolution note above stable.
import packSchema from "../schemas/pack.schema.json" with { type: "json" };
// The studio manifest (#402) — one file binding the installation: studio
// root, the ordered vault mount stack, derived-root overrides. NOT filename-
// kinded (config.toml is too generic a name to claim).
import amicodeConfigSchema from "../schemas/amicode-config.schema.json" with { type: "json" };
// The paper record (#405, literature plane): the vault reading-note frontmatter
// contract — identity, lifecycle, provenance, scoping. NOT filename-kinded
// (notes are markdown frontmatter, validated as parsed objects).
import libraryPaperSchema from "../schemas/library-paper.schema.json" with { type: "json" };

// Cross-language ProblemSpec hashing (Plan 2 Task 5) — re-exported at the package
// root so cross-package consumers (e.g. the extension's ledger_client.ts, Plan 3
// Task 6) can `import { structureHash } from "@amicode/schema"` instead of a
// package-internal `../src/hashing.js` relative path (this package has no
// "exports" map, so a subpath import would work, but the root export is the
// established, documented seam every other consumer uses — see `validate` below).
export { structureHash, problemHash, canonicalJson, fullDict, structureFields, sha256hex, designHash, planHash, workIdV1 } from "./hashing.js";

// The studio reader (#402): one library owns manifest parsing + root
// resolution. Consumers import { studioPathsOrLegacy } from the root — the
// same documented seam as everything else above.
export {
  expandTilde,
  resolveStudioPaths,
  legacyStudioPaths,
  loadStudioBinding,
  studioManifestCandidates,
  studioPathsOrLegacy,
  type StudioManifest,
  type StudioMount,
  type StudioMountDecl,
  type StudioPaths,
} from "./studio.js";

// The director-mode registry's ONE shared validator + stager (#804, spec
// 20260905-063000 D1): mode bundles under packages/extension/modes/<mode>/ are
// typed data; this module is the single code path both the extension's vitest
// suite and the amico-run doctor probe import. Same documented root seam.
export {
  MODE_GENERATOR_VERSION,
  MODE_CONSUMERS,
  LEDGER_DISCOVERY_RULE_TEXT,
  LEDGER_DISCOVERY_RULE_BEGIN,
  LEDGER_DISCOVERY_RULE_END,
  LEDGER_DISCOVERY_RULE_REGION_NAME,
  generateLedgerDiscoveryRegion,
  classifyLedgerDiscoveryRegion,
  type GeneratedRegionStatus,
  type GeneratedRegionClassification,
  compareModeVersions,
  parseModeManifest,
  validateGatePack,
  validateModeBundle,
  validateModeRegistry,
  declaredComponents,
  type DeclaredComponent,
  type ModeManifest,
  type ModeRole,
  type ModeHandoffSeed,
  type ModeConsumer,
  type ModeBundleOpts,
  checkConsumerFloor,
  SUPPORTED_MODE_BUNDLE_VERSION,
  type ConsumerFloorOk,
  type ConsumerFloorGap,
  parseReleaseIndex,
  compareReleaseToIndex,
  versionBaseOf,
  type ReleaseIndex,
  type ReleaseIndexEntry,
  type ReleaseCompare,
  type ReleaseCompareStatus,
} from "./mode_registry.js";
export {
  stageModeBundles,
  modeBundleStagingRoot,
  readStagingLock,
  stagingLockVerdict,
  pidAlive,
  processStartTimeToken,
  MODE_STAGING_LOCK_NAME,
  MODE_DEPLOY_RECEIPT_NAME,
  MODE_STAGING_TTL_MS_DEFAULT,
  type StageModeBundlesResult,
  type ModeStagingLock,
  type ModeStagingOpts,
  type StolenLock,
  type StagingLockVerdict,
} from "./mode_staging.js";

// The public workflow skills' typed revision contract (#807, spec
// 20260905-063000 D2): frontmatter `source` + `revision` (monotonic integer,
// missing = 0), the supersede-path consumer floor + generated-region parity
// validation the extension's skill resolver runs BEFORE a strictly newer
// vault revision may supersede the in-repo canonical copy. Same root seam.
export {
  SUPPORTED_SKILL_CONTRACT_VERSION,
  KNOWN_GENERATED_REGIONS,
  parseSkillRevisionFrontmatter,
  validateSupersedingSkillRevision,
  type SkillRevisionFrontmatter,
  type SupersedingSkillRevisionCheck,
  type SupersedingSkillDeclineKind,
} from "./skill_revision.js";

// The watched-repo registry's ONE shared validator (#820, spec-20260905-103000
// living-sota D3-data / S2): the SOTA codebase lens's data substrate —
// validator-checked TOML where adding a repo is a data edit, never code. Same
// documented root seam: amico-run's lenses and the extension's suite both
// import from here, so a registry that passes tests passes the machinery.
export {
  DEFAULT_FAILURE_THRESHOLD,
  validateWatchedRepoRegistry,
  parseWatchedRepoRegistry,
  flaggedForRetireOrConfirm,
  type WatchedRepo,
  type WatchedRepoRegistry,
  type FetchSurface,
} from "./watched_repos.js";

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
  // Registered in SCHEMAS ONLY (not SUPPORTED_VERSIONS_BY_KIND): problemspec is a
  // top-level `oneOf` shape with an INTEGER schema_version enum `[1]` carried INSIDE
  // each branch, so it has no top-level `properties.schema_version` for the version
  // map to read (plan review correction #6 — same pattern as ledger-record).
  problemspec: problemspecSchema,
  // Registered in SCHEMAS ONLY (not SUPPORTED_VERSIONS_BY_KIND): ledger-record is a
  // top-level `oneOf` discriminated on `type` with NO top-level
  // properties.schema_version — including it in the version map would read
  // `.properties.schema_version` off an undefined and crash @amicode/schema at load
  // (Plan 3 review correction #1, exactly the problemspec case).
  "ledger-record": ledgerRecordSchema,
  spec: specSchema,
  plan: planSchema,
  pack: packSchema,
  "amicode-config": amicodeConfigSchema,
// Registered in SCHEMAS ONLY (not SUPPORTED_VERSIONS_BY_KIND): library-paper
// is the vault NOTE frontmatter contract (#405) — notes carry no top-level
// schema_version (real-data parity with the two production notes), same
// pattern as problemspec/ledger-record.
  "library-paper": libraryPaperSchema,
} as const;

export type SchemaKind = keyof typeof SCHEMAS;
export const SCHEMA_KINDS = Object.keys(SCHEMAS) as SchemaKind[];

/** Versions the validators accept, PER KIND (Q87: tolerate known-prior within
 *  range, reject unknown/absent). Derived from the schema files' enums — the
 *  schemas are the single source of truth; this export just surfaces them.
 *  run + solvespec carry higher versions (spec C: executor/tier/env/source/hashes;
 *  solvespec v4 also adds problem_spec, the typed ProblemSpec runner target);
 *  the rest remain v1 and bump independently. `finished` (no schema_version),
 *  `problemspec`, and `ledger-record` (both top-level `oneOf` shapes with no
 *  top-level properties.schema_version), and `library-paper` (vault note
 *  frontmatter — real notes carry no schema_version) are excluded from this
 *  string-version map. */
export const SUPPORTED_VERSIONS_BY_KIND: Record<Exclude<SchemaKind, "finished" | "problemspec" | "ledger-record" | "library-paper">, string[]> =
  Object.fromEntries(
    (["run", "result", "lab", "solvespec", "catalog-entry", "spec", "plan", "pack", "amicode-config"] as const).map((kind) => [
      kind,
      (SCHEMAS[kind] as { properties: { schema_version: { enum: string[] } } }).properties.schema_version.enum,
    ]),
  ) as Record<Exclude<SchemaKind, "finished" | "problemspec" | "ledger-record">, string[]>;

export interface Validation {
  ok: boolean;
  errors: string[];
}

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
  if (base === "problem.toml") return "problemspec";
  if (base === "PACK.toml") return "pack";
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

/** Validate a bare WarrantBounds object against `$defs.bounds` of the ledger-record
 *  schema. Exists because the spec-review `budget` lens must check an AUTHORED budget
 *  against the shipped bound vocabulary, and `validate()` only accepts whole registered
 *  kinds — without this seam the lens could only restate the key set in prose, which is
 *  the drift that let the long-removed `max_duration` into a spec example
 *  (spec-20260728 §2.1). */
const boundsValidator = ajv.compile({
  $schema: "http://json-schema.org/draft-07/schema#",
  ...((ledgerRecordSchema as unknown as { $defs: { bounds: object } }).$defs.bounds),
});

export function validateBounds(obj: unknown): Validation {
  const ok = boundsValidator(obj) as boolean;
  return ok ? { ok: true, errors: [] } : { ok: false, errors: (boundsValidator.errors ?? []).map(formatError) };
}

/** Validate a file on disk: read → parse (TOML, or JSON by extension) → validate.
 *  Parse/read failures are themselves field-precise-ish errors, never a throw. */
export function validateFile(filePath: string, kind: SchemaKind): Validation {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, errors: [`cannot read ${filePath}: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = extname(filePath).toLowerCase() === ".json" ? JSON.parse(raw) : parseToml(raw);
  } catch (e) {
    return { ok: false, errors: [`${filePath}: parse error — ${(e as Error).message}`] };
  }
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
