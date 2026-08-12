// Fleet Profiles — CRUD for fleet profile TOML files stored under
// ~/.amico/ops/fleet/profiles/. Each profile is one TOML file with a fixed
// schema (schema version 1). Pure I/O + serialization; the panel pushes
// profile lists to the webview.
//
// Part of #356 (Fleet Panel: Fleet Profiles CRUD).

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";

export const PROFILES_DIR = path.join(homedir(), ".amico", "ops", "fleet", "profiles");

export interface FleetProfile {
  schema: number;
  name: string;
  base: string;
  model: string;
  variant: string;
  task_type: string;
  skills: string[];
  gates: string[];
  permissions: Record<string, string>;
}

/** Generate a kebab-case slug from a profile name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Read a single profile from a TOML file. Returns null on parse failure. */
export function readProfile(filePath: string): FleetProfile | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseProfile(raw);
  } catch {
    return null;
  }
}

/** Parse profile from TOML string. */
export function parseProfile(toml: string): FleetProfile | null {
  try {
    const data = parse(toml) as Record<string, unknown>;
    return {
      schema: typeof data.schema === "number" ? data.schema : 1,
      name: String(data.name ?? ""),
      base: String(data.base ?? ""),
      model: String(data.model ?? ""),
      variant: String(data.variant ?? ""),
      task_type: String(data.task_type ?? "interactive"),
      skills: Array.isArray(data.skills) ? data.skills.map(String) : [],
      gates: Array.isArray(data.gates) ? data.gates.map(String) : [],
      permissions:
        data.permissions && typeof data.permissions === "object"
          ? Object.fromEntries(
              Object.entries(data.permissions as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
          : {},
    };
  } catch {
    return null;
  }
}

/** Serialize a profile to TOML string. */
export function serializeProfile(profile: FleetProfile): string {
  return stringify(profile as unknown as Record<string, unknown>);
}

/** List all profiles from the profiles directory. */
export function listProfiles(dir: string = PROFILES_DIR): { slug: string; profile: FleetProfile }[] {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml"));
    const results: { slug: string; profile: FleetProfile }[] = [];
    for (const file of files) {
      const slug = file.replace(/\.toml$/, "");
      const profile = readProfile(path.join(dir, file));
      if (profile) results.push({ slug, profile });
    }
    return results;
  } catch {
    return [];
  }
}

/** Write a profile atomically (tmp + rename). Creates dir if absent. */
export function writeProfile(
  profile: FleetProfile,
  slug: string,
  dir: string = PROFILES_DIR,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const toml = serializeProfile(profile);
  const filePath = path.join(dir, `${slug}.toml`);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, toml);
  fs.renameSync(tmp, filePath);
}

/** Check if a slug already exists in the profiles directory. */
export function slugExists(slug: string, dir: string = PROFILES_DIR): boolean {
  try {
    return fs.existsSync(path.join(dir, `${slug}.toml`));
  } catch {
    return false;
  }
}

/** Delete a profile by slug. */
export function deleteProfile(slug: string, dir: string = PROFILES_DIR): boolean {
  try {
    const filePath = path.join(dir, `${slug}.toml`);
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Duplicate a profile with a "-copy" suffix. Returns the new slug or null on failure. */
export function duplicateProfile(
  slug: string,
  dir: string = PROFILES_DIR,
): string | null {
  const source = readProfile(path.join(dir, `${slug}.toml`));
  if (!source) return null;

  let newSlug = `${slug}-copy`;
  let counter = 2;
  while (slugExists(newSlug, dir)) {
    newSlug = `${slug}-copy-${counter}`;
    counter++;
  }

  const newProfile = { ...source, name: `${source.name} (copy)` };
  writeProfile(newProfile, newSlug, dir);
  return newSlug;
}

/** Validate a profile for required fields. Returns array of error messages. */
export function validateProfile(profile: Partial<FleetProfile>): string[] {
  const errors: string[] = [];
  if (!profile.name || profile.name.trim() === "") errors.push("Name is required");
  if (!profile.model || profile.model.trim() === "") errors.push("Model is required");
  const slug = slugify(profile.name ?? "");
  if (!slug) errors.push("Name must produce a valid slug (at least one alphanumeric character)");
  return errors;
}
