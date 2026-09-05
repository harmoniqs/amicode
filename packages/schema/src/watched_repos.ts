// watched_repos.ts — the watched-repo registry's ONE shared validator (#820,
// spec-20260905-103000 living-sota D3-data / S2): the registry under the sota
// root (and the shipped seed that bootstraps it) is TYPED DATA, and this
// module is the single code path that judges it — imported by BOTH amico-run's
// lenses (the codebase lens reads it; the stamp writer revalidates before any
// persist) and the extension's vitest suite, so a registry that passes tests
// passes the machinery (the mode_registry.ts idiom, H1).
//
// The registry is the SOTA codebase lens's whole substrate: repos,
// why-watched, feeding-which-domains, fetch surface, match keywords,
// last-success stamps, consecutive-failure counters. Adding a repo is a DATA
// EDIT, never code. The retire-or-confirm flag is DERIVED from the
// consecutive-failure counter against the registry's threshold (default 7,
// carried IN THE SCHEMA — DEFAULT_FAILURE_THRESHOLD reads the schema's own
// `default` keyword, so the schema file stays the one source of truth); it is
// never stored, so it can never disagree with the counter it reads.
import { parse as parseToml } from "smol-toml";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsDefault from "ajv-formats";
import type { Validation } from "./index.js";
import watchedRepoRegistrySchema from "../schemas/watched-repo-registry.schema.json" with { type: "json" };

// ajv-formats ships a CJS default export; under NodeNext the default import
// can bind the module namespace rather than the callable — normalize
// defensively (same idiom as src/index.ts and mode_registry.ts).
const addFormats = (typeof addFormatsDefault === "function"
  ? addFormatsDefault
  : (addFormatsDefault as unknown as { default: unknown }).default) as unknown as (ajv: Ajv) => void;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const registryValidator = ajv.compile(watchedRepoRegistrySchema as object) as ValidateFunction;

/** The schema's own `failure_threshold.default` — the default 7 lives in the
 *  schema (one source of truth); this constant just surfaces it. */
export const DEFAULT_FAILURE_THRESHOLD: number =
  (watchedRepoRegistrySchema as {
    properties?: { failure_threshold?: { default?: number } };
  }).properties?.failure_threshold?.default ?? 7;

export type FetchSurface = "releases" | "changelog" | "issues";

export interface WatchedRepo {
  /** Canonical GitHub owner/name — the API fetch target, never a local fork checkout. */
  repo: string;
  /** The human reason this repo is watched — the retire-or-confirm line. */
  why_watched: string;
  /** Which research domains this repo feeds. */
  domains: string[];
  fetch_surface: FetchSurface[];
  match_keywords: string[];
  /** ISO-8601 stamp of the last successful fetch ("" until the first success). */
  last_success: string;
  /** Consecutive fetch failures since the last success (machinery-written). */
  consecutive_failures: number;
}

export interface WatchedRepoRegistry {
  schema_version: string;
  /** Consecutive-failure count that flags an entry for retire-or-confirm. */
  failure_threshold: number;
  repos: WatchedRepo[];
}

function formatAjvError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "(root)" : e.instancePath;
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

function ajvErrors(v: ValidateFunction, label: string): string[] {
  return (v.errors ?? []).map((e) => `${label}${formatAjvError(e)}`);
}

/** Parse + schema-validate + registry-level cross-checks, applying the
 *  IN-SCHEMA defaults for the machinery-written fields. Throws with
 *  field-precise errors on violation — a bad registry is a loud authoring
 *  failure, never a silent skip (the parseModeManifest idiom). */
export function parseWatchedRepoRegistry(text: string): WatchedRepoRegistry {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    throw new Error(`watched-repos.toml: parse error — ${(e as Error).message}`);
  }
  const errors: string[] = [];
  if (!registryValidator(parsed)) {
    errors.push(...ajvErrors(registryValidator, "watched-repos.toml"));
  }
  const raw = parsed as { repos?: { repo?: string }[] };
  const seen = new Set<string>();
  for (const r of raw.repos ?? []) {
    if (typeof r.repo !== "string") continue; // already reported by the schema validator
    if (seen.has(r.repo)) errors.push(`watched-repos.toml: duplicate repo entry "${r.repo}" — one repo, one entry`);
    seen.add(r.repo);
  }
  if (errors.length > 0) {
    throw new Error(`watched-repos.toml: schema violation — ${errors.join("; ")}`);
  }
  // apply the in-schema defaults so the machinery reads a normalized shape
  const reg = parsed as {
    schema_version: string;
    failure_threshold?: number;
    repos: Array<{
      repo: string;
      why_watched: string;
      domains: string[];
      fetch_surface: FetchSurface[];
      match_keywords: string[];
      last_success?: string;
      consecutive_failures?: number;
    }>;
  };
  return {
    schema_version: reg.schema_version,
    failure_threshold: reg.failure_threshold ?? DEFAULT_FAILURE_THRESHOLD,
    repos: reg.repos.map((r) => ({
      repo: r.repo,
      why_watched: r.why_watched,
      domains: r.domains,
      fetch_surface: r.fetch_surface,
      match_keywords: r.match_keywords,
      last_success: r.last_success ?? "",
      consecutive_failures: r.consecutive_failures ?? 0,
    })),
  };
}

/** The Validation-returning form (the validateGatePack idiom): parse (if a
 *  string) + schema-validate + cross-checks, errors field-precise. */
export function validateWatchedRepoRegistry(textOrParsed: unknown): Validation {
  let parsed = textOrParsed;
  if (typeof textOrParsed === "string") {
    try {
      parsed = parseToml(textOrParsed);
    } catch (e) {
      return { ok: false, errors: [`watched-repos.toml: parse error — ${(e as Error).message}`] };
    }
  }
  const errors: string[] = [];
  if (!registryValidator(parsed)) {
    errors.push(...ajvErrors(registryValidator, "watched-repos.toml"));
  }
  const raw = parsed as { repos?: { repo?: string }[] };
  if (Array.isArray(raw?.repos)) {
    const seen = new Set<string>();
    for (const r of raw.repos) {
      if (typeof r?.repo !== "string") continue; // already reported
      if (seen.has(r.repo)) errors.push(`watched-repos.toml: duplicate repo entry "${r.repo}" — one repo, one entry`);
      seen.add(r.repo);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The derived retire-or-confirm flag: an entry whose consecutive-failure
 *  counter reached the registry's threshold. Derived at read time — never
 *  stored, never able to disagree with its counter (the flag the weekly
 *  brief renders for the human retire-or-confirm decision). */
export function flaggedForRetireOrConfirm(entry: Pick<WatchedRepo, "consecutive_failures">, threshold: number): boolean {
  return entry.consecutive_failures >= threshold;
}
