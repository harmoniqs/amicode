// claim.ts — the claim object's amicode-side seam (amicode #1681, brain flywheel
// slice 2): the ONE type namespace the #1679 flywheel operates on. The JSON
// Schema file is the published contract (anyone may validate a claim with any
// JSON Schema tool); THIS module is the field-precise validator + the closed
// vocabularies mirrored in TS (so a rejection names the vocabulary) + the
// ONE bridge from slice 1's numeric distill confidence into the contract's
// enum (bucketConfidence — defined here so slice 5's dedupe/merge inherits it
// instead of inventing a parallel convention).
//
// WHY the frontmatter IS the claim object (no render-level extras): distill's
// candidate NOTES carry provenance keys beyond the claim fields (session_id,
// source_db, …) because a candidate is a DRAFT rendering; a registry claim is
// the machinery surface itself, so provenance rides evidence pointers + the
// append-only history — never a second key set. additionalProperties: false
// makes any drift (a stray key, an unprojected memory card dropped into the
// registry) a validation failure, which is exactly how the memory/vault
// type-namespace collision stays dissolved.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsDefault from "ajv-formats";
import type { Validation } from "./index.js";
import claimSchema from "../schemas/claim.schema.json" with { type: "json" };

// ajv-formats ships a CJS default export; under NodeNext the default import can
// bind the module namespace rather than the callable — normalize defensively
// (the src/index.ts / vault-card.ts idiom).
const addFormats = (typeof addFormatsDefault === "function"
  ? addFormatsDefault
  : (addFormatsDefault as unknown as { default: unknown }).default) as unknown as (ajv: Ajv) => void;

/** The claim's closed type set — the same vocabulary slice 1's distill pass
 *  types candidates over (jev_curation.ts CLAIM_TYPES; the vault spec sketch's
 *  "hypthesis" is a corrected typo, the parent issue's known erratum). */
export const CLAIM_TYPES = ["insight", "hypothesis", "best-practice", "hazard", "method"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** The machinery-driven lifecycle: unverified → corroborated → superseded →
 *  refuted. Transitions are stamped with history (slice 5); a claim with zero
 *  resolvable evidence cannot reach corroborated. */
export const CLAIM_STATUSES = ["unverified", "corroborated", "superseded", "refuted"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** The calibrated confidence bands (the vault spec sketch's closed set). */
export const CLAIM_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type ClaimConfidence = (typeof CLAIM_CONFIDENCE_LEVELS)[number];

/** The promotion ladder — copy-never-move, human-gated above `personal`. */
export const CLAIM_SCOPES = ["personal", "team", "public"] as const;
export type ClaimScope = (typeof CLAIM_SCOPES)[number];

/** The closed history-event vocabulary machinery stamps (append-only trail). */
export const CLAIM_HISTORY_EVENTS = [
  "created",
  "projected",
  "merged",
  "evidence-added",
  "applied",
  "corroborated",
  "superseded",
  "refuted",
] as const;
export type ClaimHistoryEvent = (typeof CLAIM_HISTORY_EVENTS)[number];

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateFn: ValidateFunction = ajv.compile(claimSchema);

/** Validate a parsed claim (the note frontmatter / the machinery's object).
 *  Field-precise: every error names the offending key and its JSON-pointer
 *  path; a missing required key renders as /<key> (the vault-card idiom). */
export function validateClaim(claim: unknown): Validation {
  const ok = validateFn(claim) as boolean;
  if (ok) return { ok: true, errors: [] };
  return { ok: false, errors: (validateFn.errors ?? []).map(formatClaimError) };
}

function formatClaimError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  switch (e.keyword) {
    case "required": {
      const prop = (e.params as { missingProperty: string }).missingProperty;
      return `${where === "(root)" ? "" : where}/${prop}: missing required key "${prop}"`;
    }
    case "additionalProperties":
      return `${where === "(root)" ? "" : where}/${(e.params as { additionalProperty: string }).additionalProperty}: unknown key "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    case "enum": {
      const allowed = (e.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `${where}: must be one of (${allowed.join(", ")})`;
    }
    default:
      return `${where}: ${e.message ?? "invalid"}`;
  }
}

/** The ONE bridge from distill's numeric candidate confidence (slice 1 stamps
 *  the Jev Choice's p on candidate notes) into the claim contract's enum —
 *  defined here, in the schema slice, so the dedupe/merge pass (slice 5)
 *  inherits a single convention instead of inventing a parallel one. */
export function bucketConfidence(p: number): ClaimConfidence {
  if (p >= 0.8) return "high";
  if (p >= 0.5) return "medium";
  return "low";
}
