// Vault card validation (#496 — the distillation-pass open contract). The JSON
// Schema file is the published contract (anyone may validate a card with any
// JSON Schema tool); THIS module is the amicode-side seam: it dispatches on
// `type` and validates against that type's branch, so a rejection names the
// violated schema path (the umbrella oneOf would report 18 branch errors for
// an unknown type — useless to a human).
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsDefault from "ajv-formats";
import type { Validation } from "./index.js";
import vaultCardSchema from "../schemas/vault-card.schema.json" with { type: "json" };

// ajv-formats ships a CJS default export; under NodeNext the default import can
// bind the module namespace rather than the callable — normalize defensively
// (same idiom as src/index.ts).
const addFormats = (typeof addFormatsDefault === "function"
  ? addFormatsDefault
  : (addFormatsDefault as unknown as { default: unknown }).default) as unknown as (ajv: Ajv) => void;

const CARD_SCHEMA_ID = "https://amico.harmoniqs.co/schema/vault-card/v1";

/** The closed set of card types (the oneOf branches, mirrored in TS so the
 *  dispatcher can name the vocabulary in its rejections). */
export const VAULT_CARD_TYPES = ["insight"] as const;
export type VaultCardType = (typeof VAULT_CARD_TYPES)[number];

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(vaultCardSchema);
const compiled = new Map<VaultCardType, ValidateFunction>();
for (const t of VAULT_CARD_TYPES) {
  compiled.set(t, ajv.compile({ $ref: `${CARD_SCHEMA_ID}#/$defs/cards/${t}` }));
}

/** Validate a parsed card (frontmatter object) against its type's schema.
 *  Rejections are field-precise: every error names the offending key and its
 *  JSON-pointer path. The untyped/unknown-type dispatch failures name /type. */
export function validateVaultCard(card: unknown): Validation {
  if (card === null || typeof card !== "object" || Array.isArray(card)) {
    return { ok: false, errors: ["(root): expected a card object"] };
  }
  const type = (card as Record<string, unknown>).type;
  if (type === undefined) {
    return { ok: false, errors: ['/type: missing required key "type" — untyped card'] };
  }
  if (typeof type !== "string" || !(VAULT_CARD_TYPES as readonly string[]).includes(type)) {
    return {
      ok: false,
      errors: [`/type: unknown card type ${JSON.stringify(type)} (known: ${VAULT_CARD_TYPES.join(", ")})`],
    };
  }
  const v = compiled.get(type as VaultCardType)!;
  const ok = v(card) as boolean;
  if (ok) return { ok: true, errors: [] };
  return { ok: false, errors: (v.errors ?? []).map(formatCardError) };
}

/** Field-precise error rendering (the index.ts formatError idiom), with one
 *  deliberate sharpening: a missing REQUIRED key renders as /<key> — the
 *  violated path IS the absent key, and the negative corpus asserts on it. */
function formatCardError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
  switch (e.keyword) {
    case "required": {
      const prop = (e.params as { missingProperty: string }).missingProperty;
      return `${where === "(root)" ? "" : where}/${prop}: missing required key "${prop}"`;
    }
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
