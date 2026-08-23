// Vault card/record validation — the open contract for the vault distillation
// pass's schema slice (harmoniqs/amicode#496, spec-20260821-090401).
//
// Design constraints: zero new dependencies (the `yaml` dep already exists for
// frontmatter parsing); a minimal JSON-Schema-subset engine covering exactly the
// keywords the vault schemas use (type, required, properties, enum, const,
// format:"date", minItems/maxItems, items, minLength, minimum/maximum, allOf,
// if/then); errors always name the violated schema path (e.g. `$.confidence`).

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: boolean; errors: ValidationError[]; type?: string };

type JsonSchema = Record<string, any>;

export const CARD_TYPES = [
  "experiment",
  "insight",
  "hypothesis",
  "method",
  "paper",
  "spec",
  "plan",
  "retrospective",
  "person",
  "org",
  "device",
  "meeting",
  "feedback",
  "project",
  "reference",
  "user",
  "tension",
  "tombstone",
] as const;

export type CardType = (typeof CARD_TYPES)[number];

/** Load every card schema from <dir>/cards/<type>.schema.json, keyed by type. */
export function loadSchemas(schemasDir: string): Map<string, JsonSchema> {
  const dir = path.join(schemasDir, "cards");
  const out = new Map<string, JsonSchema>();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".schema.json")) continue;
    const schema = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as JsonSchema;
    const type = (schema.properties as Record<string, any> | undefined)?.type?.const as
      | string
      | undefined;
    if (!type) throw new Error(`schema ${file} does not declare properties.type.const`);
    out.set(type, schema);
  }
  return out;
}

/** Load the evidence-plane record schema. */
export function loadRecordSchema(schemasDir: string): JsonSchema {
  return JSON.parse(
    fs.readFileSync(path.join(schemasDir, "records", "evidence-record.schema.json"), "utf8"),
  );
}

/** Load the plane-residency table (type → {plane, note?}). */
export function loadPlaneResidency(
  schemasDir: string,
): Record<string, { plane: string; note?: string }> {
  return JSON.parse(fs.readFileSync(path.join(schemasDir, "plane-residency.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Minimal JSON-Schema-subset engine
// ---------------------------------------------------------------------------

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isWellFormedDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  // Date.parse rolls calendar-invalid dates over (V8: 2026-02-30 → Mar 2),
  // so the regex+parse pair alone accepts non-existent dates. Require the
  // parsed instant to round-trip to the same calendar day (reviewer pass #517).
  const d = new Date(t);
  return (
    d.getUTCFullYear() === Number(value.slice(0, 4)) &&
    d.getUTCMonth() === Number(value.slice(5, 7)) - 1 &&
    d.getUTCDate() === Number(value.slice(8, 10))
  );
}

export function validate(value: unknown, schema: JsonSchema, at = "$"): ValidationError[] {
  const errors: ValidationError[] = [];
  const push = (p: string, message: string) => errors.push({ path: p, message });

  if (schema.const !== undefined && value !== schema.const) {
    push(at, `must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) {
    push(at, `must be one of [${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}]`);
    return errors;
  }
  if (schema.type !== undefined && !checkType(value, schema.type)) {
    push(at, `must be of type ${schema.type}`);
    return errors;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(at, `must have length >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(at, `must have length <= ${schema.maxLength}`);
    }
    if (schema.format === "date" && !isWellFormedDate(value)) {
      push(at, "must be a well-formed ISO date (YYYY-MM-DD)");
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      push(at, `must match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push(at, `must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push(at, `must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(at, `must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(at, `must have at most ${schema.maxItems} item(s)`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${at}[${i}]`)));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (schema.required !== undefined) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) push(`${at}.${key}`, "missing required field");
      }
    }
    if (schema.properties !== undefined) {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        if (key in obj) errors.push(...validate(obj[key], sub, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys((schema.properties as Record<string, JsonSchema>) ?? {}));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) push(`${at}.${key}`, "unknown field");
      }
    }
  }

  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf as JsonSchema[]) errors.push(...validate(value, sub, at));
  }
  if (schema.if !== undefined) {
    const conditionHolds = validate(value, schema.if as JsonSchema, at).length === 0;
    if (conditionHolds && schema.then !== undefined) {
      errors.push(...validate(value, schema.then as JsonSchema, at));
    }
    if (!conditionHolds && schema.else !== undefined) {
      errors.push(...validate(value, schema.else as JsonSchema, at));
    }
  }
  if (schema.not !== undefined) {
    if (validate(value, schema.not as JsonSchema, at).length === 0) {
      push(at, "must not match the forbidden shape");
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Card / record validation
// ---------------------------------------------------------------------------

/** Validate a parsed card object against its type's schema. */
export function validateCard(obj: unknown, schemas: Map<string, JsonSchema>): ValidationResult {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, errors: [{ path: "$", message: "card must be an object" }] };
  }
  const type = (obj as Record<string, unknown>).type;
  if (type === undefined) {
    return { ok: false, errors: [{ path: "$.type", message: "missing required field (untyped card)" }] };
  }
  if (typeof type !== "string" || !schemas.has(type)) {
    return {
      ok: false,
      errors: [{ path: "$.type", message: `unknown type ${JSON.stringify(type)}` }],
      type: typeof type === "string" ? type : undefined,
    };
  }
  const errors = validate(obj, schemas.get(type)!);
  // Cross-field semantic check the JSON-Schema subset cannot express: a
  // tension card's two sides must be disjoint — a card cited on both sides
  // of its own tension is self-referential noise (reviewer pass #517).
  if (type === "tension") {
    const a = (obj as Record<string, unknown>).a_cards;
    const b = (obj as Record<string, unknown>).b_cards;
    if (Array.isArray(a) && Array.isArray(b)) {
      const bSet = new Set(b);
      const shared = a.filter((x) => bSet.has(x));
      if (shared.length > 0) {
        errors.push({
          path: "$.a_cards",
          message: `a_cards and b_cards must be disjoint (shared: ${shared
            .map((s) => JSON.stringify(s))
            .join(", ")})`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors, type };
}

/** Validate a parsed record object against the evidence-plane record schema. */
export function validateRecord(obj: unknown, recordSchema: JsonSchema): ValidationResult {
  const errors = validate(obj, recordSchema);
  const type = (obj as Record<string, unknown> | null)?.type;
  return { ok: errors.length === 0, errors, type: typeof type === "string" ? type : undefined };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** Parse and validate a markdown card file (YAML frontmatter) against the schemas. */
export function validateCardFile(
  filePath: string,
  schemas: Map<string, JsonSchema>,
): ValidationResult {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { ok: false, errors: [{ path: "$", message: "no YAML frontmatter block" }] };
  }
  let obj: unknown;
  try {
    obj = parseYaml(match[1]);
  } catch (err) {
    return { ok: false, errors: [{ path: "$", message: `frontmatter is not valid YAML: ${String(err)}` }] };
  }
  return validateCard(obj, schemas);
}

/**
 * Existence-level check for tombstone pointers: schema validates shape, but a
 * pointer must also resolve to a real file. Vault-relative pointers
 * (`knowledge/x.md`, `journal/pass-1.md`) are resolved under `vaultRoot`;
 * `repo:` pointers (filed_to) are resolved against the workspace root when
 * available — existence there is the caller's concern, so a `repo:` pointer
 * returns true here (resolved by the dev gate, not the vault).
 */
export function tombstonePointerResolves(obj: Record<string, unknown>, vaultRoot: string): boolean {
  const pointer = obj.pointer;
  if (typeof pointer !== "string" || pointer.length === 0) return false;
  if (pointer.startsWith("repo:")) return true;
  return fs.existsSync(path.resolve(vaultRoot, pointer));
}

/** Canonical JSON: deep-sorted keys, 2-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
