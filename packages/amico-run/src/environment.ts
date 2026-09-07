// environment.ts — pure logic for research environment entities (issue #881).
//
// Schema definition, validation, slug generation, scaffolding data, TOML
// rendering, and registry parsing. NO filesystem I/O — that lives in
// env_verb.ts. This module is the unit-testable core.

import { parse as parseToml } from "smol-toml";

// ── schema types ────────────────────────────────────────────────────────────

export const CURRENT_ENV_SCHEMA_VERSION = 1;

export interface EnvironmentToml {
  schema_version: number;
  name: string;
  slug: string;
  created: string; // YYYY-MM-DD
  description?: string;
  tags?: string[];
  domain?: { platform?: string; field?: string };
  authors?: { lead?: string; collaborators?: string[] };
  repo?: { remote?: string };
  paths?: Record<string, string>;
}

export interface EnvironmentRegistryEntry {
  slug: string;
  path: string;
}

/** The prescribed directory layout for a Research Environment (PRD #880). */
export const ENV_SCAFFOLD_DIRS = [
  "insights",
  "methods",
  "context",
  "literature",
  "experiments",
  "lib",
  "templates",
  "config",
  "results",
] as const;

// ── validation ──────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

const REQUIRED_FIELDS: (keyof EnvironmentToml)[] = [
  "schema_version",
  "name",
  "slug",
  "created",
];

export function validateEnvironmentToml(data: unknown): ValidationResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, errors: ["research-environment.toml must be a TOML table (object)"] };
  }

  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (obj[field] === undefined || obj[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  if (typeof obj.schema_version !== "undefined" && typeof obj.schema_version !== "number") {
    errors.push("schema_version must be an integer");
  }

  if (
    typeof obj.schema_version === "number" &&
    obj.schema_version > CURRENT_ENV_SCHEMA_VERSION
  ) {
    errors.push(
      `schema_version ${obj.schema_version} exceeds current (${CURRENT_ENV_SCHEMA_VERSION}) — manifest is unreadable by this version`,
    );
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// ── slug generation ─────────────────────────────────────────────────────────

export function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── TOML rendering ──────────────────────────────────────────────────────────

/** Render an EnvironmentToml to a TOML string. Hand-rendered for readability. */
export function renderEnvironmentToml(e: EnvironmentToml): string {
  const lines: string[] = [];
  lines.push(`schema_version = ${e.schema_version}`);
  lines.push(`name = ${q(e.name)}`);
  lines.push(`slug = ${q(e.slug)}`);
  lines.push(`created = ${q(e.created)}`);

  if (e.description) {
    lines.push(`description = ${q(e.description)}`);
  }

  if (e.tags && e.tags.length > 0) {
    lines.push(`tags = [${e.tags.map(q).join(", ")}]`);
  }

  if (e.domain) {
    lines.push("");
    lines.push("[domain]");
    if (e.domain.platform) lines.push(`platform = ${q(e.domain.platform)}`);
    if (e.domain.field) lines.push(`field = ${q(e.domain.field)}`);
  }

  if (e.authors) {
    lines.push("");
    lines.push("[authors]");
    if (e.authors.lead) lines.push(`lead = ${q(e.authors.lead)}`);
    if (e.authors.collaborators && e.authors.collaborators.length > 0) {
      lines.push(`collaborators = [${e.authors.collaborators.map(q).join(", ")}]`);
    }
  }

  if (e.repo) {
    lines.push("");
    lines.push("[repo]");
    if (e.repo.remote) lines.push(`remote = ${q(e.repo.remote)}`);
  }

  if (e.paths && Object.keys(e.paths).length > 0) {
    lines.push("");
    lines.push("[paths]");
    for (const [key, value] of Object.entries(e.paths)) {
      lines.push(`${key} = ${q(value)}`);
    }
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

function q(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── registry parsing ────────────────────────────────────────────────────────

/** Parse the `~/.amico/environments.toml` registry. */
export function parseEnvironmentRegistry(toml: string): EnvironmentRegistryEntry[] {
  if (!toml.trim()) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(toml) as Record<string, unknown>;
  } catch {
    return [];
  }

  const envs = parsed.environments;
  if (!Array.isArray(envs)) return [];

  const entries: EnvironmentRegistryEntry[] = [];
  for (const entry of envs) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).slug === "string" &&
      typeof (entry as Record<string, unknown>).path === "string"
    ) {
      entries.push({
        slug: (entry as Record<string, unknown>).slug as string,
        path: (entry as Record<string, unknown>).path as string,
      });
    }
  }

  return entries;
}

/** Render an environment registry to TOML. */
export function renderEnvironmentRegistry(entries: EnvironmentRegistryEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  for (const entry of entries) {
    lines.push("[[environments]]");
    lines.push(`slug = ${q(entry.slug)}`);
    lines.push(`path = ${q(entry.path)}`);
    lines.push("");
  }
  return lines.join("\n");
}
