// env_verb.ts — CLI wrapper for `amico env create` and `amico env register`.
// Pure logic lives in environment.ts; this module handles filesystem I/O,
// git init, flag parsing, and the verb dispatch. Part of #881.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  CURRENT_ENV_SCHEMA_VERSION,
  ENV_SCAFFOLD_DIRS,
  nameToSlug,
  parseEnvironmentRegistry,
  renderEnvironmentRegistry,
  renderEnvironmentToml,
  validateEnvironmentToml,
  type EnvironmentRegistryEntry,
  type EnvironmentToml,
} from "./environment.js";
import type { VerbResult } from "./verbs.js";

/** Options for DI in tests (registry path override). */
export interface EnvVerbOptions {
  registryPath?: string;
}

function defaultRegistryPath(): string {
  return join(homedir(), ".amico", "environments.toml");
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Extract the first positional argument (not a --flag or a flag's value). */
function positionalArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      i++; // skip the flag's value
      continue;
    }
    return argv[i];
  }
  return undefined;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── registry helpers ────────────────────────────────────────────────────────

function readRegistry(path: string): EnvironmentRegistryEntry[] {
  if (!existsSync(path)) return [];
  try {
    return parseEnvironmentRegistry(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

function writeRegistry(path: string, entries: EnvironmentRegistryEntry[]): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderEnvironmentRegistry(entries));
}

function upsertRegistryEntry(
  registryPath: string,
  entry: EnvironmentRegistryEntry,
): { replaced: boolean } {
  const entries = readRegistry(registryPath);
  const idx = entries.findIndex((e) => e.slug === entry.slug);
  const replaced = idx >= 0;
  if (replaced) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  writeRegistry(registryPath, entries);
  return { replaced };
}

// ── create ──────────────────────────────────────────────────────────────────

export function envCreate(argv: string[], opts?: EnvVerbOptions): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "env", subcommand: "create", error },
    code: 64,
  });

  const name = positionalArg(argv);
  if (!name) return fail("environment name is required: amico env create <name>");

  const slug = nameToSlug(name);
  const envDir = resolve(flagValue(argv, "--path") ?? join(process.cwd(), slug));

  // Idempotent: if research-environment.toml already exists, validate and return
  const tomlPath = join(envDir, "research-environment.toml");
  if (existsSync(tomlPath)) {
    try {
      const existing = parseToml(readFileSync(tomlPath, "utf8")) as unknown as EnvironmentToml;
      const v = validateEnvironmentToml(existing);
      if (v.ok) {
        return {
          json: {
            verb: "env",
            subcommand: "create",
            created: false,
            idempotent: true,
            path: envDir,
            slug: existing.slug,
          },
          code: 0,
        };
      }
    } catch {
      // Invalid TOML; fall through and overwrite
    }
  }

  const platform = flagValue(argv, "--platform");
  const field = flagValue(argv, "--field");
  const author = flagValue(argv, "--author");

  const env: EnvironmentToml = {
    schema_version: CURRENT_ENV_SCHEMA_VERSION,
    name,
    slug,
    created: today(),
    ...(platform || field ? { domain: { ...(platform ? { platform } : {}), ...(field ? { field } : {}) } } : {}),
    ...(author ? { authors: { lead: author } } : {}),
  };

  // Create directory and scaffold
  try {
    mkdirSync(envDir, { recursive: true });
  } catch (e) {
    return fail(`failed to create directory: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Scaffold directories
  try {
    for (const dir of ENV_SCAFFOLD_DIRS) {
      mkdirSync(join(envDir, dir), { recursive: true });
    }
  } catch (e) {
    return fail(`failed to scaffold directories: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Write manifest
  try {
    writeFileSync(tomlPath, renderEnvironmentToml(env));
  } catch (e) {
    return fail(`failed to write manifest: ${e instanceof Error ? e.message : String(e)}`);
  }

  // git init + initial commit
  try {
    if (!existsSync(join(envDir, ".git"))) {
      execFileSync("git", ["init"], { cwd: envDir, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: envDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `init: scaffold research environment "${name}"`], {
        cwd: envDir,
        stdio: "ignore",
      });
    }
  } catch (e) {
    // git failure is a warning, not a hard error
    const registryPath = opts?.registryPath ?? defaultRegistryPath();
    upsertRegistryEntry(registryPath, { slug, path: envDir });
    return {
      json: {
        verb: "env",
        subcommand: "create",
        created: true,
        path: envDir,
        slug,
        warning: `git init failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      code: 0,
    };
  }

  // Register in environments.toml
  const registryPath = opts?.registryPath ?? defaultRegistryPath();
  upsertRegistryEntry(registryPath, { slug, path: envDir });

  return {
    json: {
      verb: "env",
      subcommand: "create",
      created: true,
      path: envDir,
      slug,
    },
    code: 0,
  };
}

// ── register ────────────────────────────────────────────────────────────────

export function envRegister(argv: string[], opts?: EnvVerbOptions): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "env", subcommand: "register", error },
    code: 64,
  });

  const dirArg = positionalArg(argv);
  if (!dirArg) return fail("path is required: amico env register <path>");

  const dir = resolve(dirArg);
  if (!existsSync(dir)) return fail(`directory not found: ${dir}`);

  const tomlPath = join(dir, "research-environment.toml");
  if (!existsSync(tomlPath)) return fail(`no research-environment.toml found in ${dir}`);

  let manifest: EnvironmentToml;
  try {
    manifest = parseToml(readFileSync(tomlPath, "utf8")) as unknown as EnvironmentToml;
    const v = validateEnvironmentToml(manifest);
    if (!v.ok) return fail(`invalid manifest: ${v.errors.join("; ")}`);
  } catch (e) {
    return fail(`failed to read manifest: ${e instanceof Error ? e.message : String(e)}`);
  }

  const registryPath = opts?.registryPath ?? defaultRegistryPath();
  const { replaced } = upsertRegistryEntry(registryPath, { slug: manifest.slug, path: dir });

  return {
    json: {
      verb: "env",
      subcommand: "register",
      registered: true,
      slug: manifest.slug,
      path: dir,
      ...(replaced ? { replaced: true } : {}),
    },
    code: 0,
  };
}

// ── dispatch ────────────────────────────────────────────────────────────────

export function envVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "create") return envCreate(rest);
  if (sub === "register") return envRegister(rest);
  return {
    json: {
      verb: "env",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico env create <name> [--path <dir>] [--platform <p>] [--field <f>] [--author <a>]  |  amico env register <path>",
    },
    code: 64,
  };
}
