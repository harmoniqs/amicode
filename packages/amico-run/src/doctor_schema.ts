// doctor_schema.ts — validate `amico doctor --json` reports against the
// COMMITTED JSON Schema (schemas/doctor-report.schema.json, #525). A minimal
// JSON-Schema-subset engine covering exactly the keywords that schema uses
// (type incl. type arrays, enum, required, properties, items, minItems,
// minLength, additionalProperties) — the same zero-dependency approach as
// the extension's vault_card_validator. Errors name the violated path.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SchemaError = { path: string; message: string };
export type SchemaValidation = { ok: boolean; errors: SchemaError[] };

type JsonSchema = Record<string, unknown>;

/** Load the committed doctor-report schema. Resolved from this module's
 *  location (src/ → ../schemas/); when running from the esbuild bundle
 *  (dist/), the package root is one level up from there too. */
export function loadDoctorSchema(): JsonSchema {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "schemas", "doctor-report.schema.json"), // src/ or dist/
    join(here, "schemas", "doctor-report.schema.json"), // package root
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as JsonSchema;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`doctor-report.schema.json not found near ${here}`);
}

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

export function validateAgainstSchema(value: unknown, schema: JsonSchema, at = "$"): SchemaError[] {
  const errors: SchemaError[] = [];
  const push = (p: string, message: string) => errors.push({ path: p, message });

  if (schema.const !== undefined && value !== schema.const) {
    push(at, `must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    push(at, `must be one of ${(schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`);
  }

  const type = schema.type;
  if (typeof type === "string" && !checkType(value, type)) {
    push(at, `must be ${type}`);
    return errors;
  }
  if (Array.isArray(type) && !(type as string[]).some((t) => checkType(value, t))) {
    push(at, `must be one of ${(type as string[]).join(" | ")}`);
    return errors;
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      push(at, `must have at least ${schema.minItems} items (found ${value.length})`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((v, i) => errors.push(...validateAgainstSchema(v, schema.items as JsonSchema, `${at}[${i}]`)));
    }
    return errors;
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) push(at, `missing required field "${key}"`);
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        if (key in obj) errors.push(...validateAgainstSchema(obj[key], sub, `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false && schema.properties && typeof schema.properties === "object") {
      const allowed = new Set(Object.keys(schema.properties as Record<string, unknown>));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) push(`${at}.${key}`, `additional property not allowed here`);
      }
    }
    return errors;
  }

  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    push(at, `must be at least ${schema.minLength} characters`);
  }
  return errors;
}

/** Validate a doctor --json report object against the committed schema. */
export function validateDoctorReport(value: unknown, schema: JsonSchema = loadDoctorSchema()): SchemaValidation {
  const errors = validateAgainstSchema(value, schema);
  return { ok: errors.length === 0, errors };
}
