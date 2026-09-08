// env_verb.ts — CLI wrapper for `amico env create` and `amico env register`.
// Pure logic lives in environment.ts; this module handles filesystem I/O,
// git init, flag parsing, and the verb dispatch. Part of #881.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
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
import { renderProjectToml, type ProjectToml } from "./project.js";
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

// ── nesting guard ───────────────────────────────────────────────────────────

/** Walk ancestors looking for a manifest file. Returns the first dir that has one, or null. */
function findAncestorManifest(dir: string, manifest: string): string | null {
  let current = resolve(dir);
  // Start from the PARENT — we don't care about dir itself (it may be the env we're creating)
  current = dirname(current);
  while (true) {
    if (existsSync(join(current, manifest))) return current;
    const parent = dirname(current);
    if (parent === current) return null; // filesystem root
    current = parent;
  }
}

/**
 * Guard: environments and projects must not be nested inside each other.
 * Multi-repo only — each is its own git repo at its own root.
 */
export function checkNestingViolation(
  dir: string,
): { ok: true } | { ok: false; error: string } {
  const parentProject = findAncestorManifest(dir, "research-project.toml");
  if (parentProject) {
    return {
      ok: false,
      error: `cannot create environment inside project ${parentProject} — environments and projects must be separate repos`,
    };
  }
  const parentEnv = findAncestorManifest(dir, "research-environment.toml");
  if (parentEnv) {
    return {
      ok: false,
      error: `cannot create environment inside environment ${parentEnv} — environments must not be nested`,
    };
  }
  return { ok: true };
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

  // Nesting guard: environments must not be created inside projects or other environments
  const nestCheck = checkNestingViolation(envDir);
  if (!nestCheck.ok) return fail(nestCheck.error);

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

// ── promote ─────────────────────────────────────────────────────────────────

/** Type → target directory routing map.
 *  Only environment-level directories — project-level types (experiment, result)
 *  are not promotable since they belong to the project, not the environment. */
const TYPE_ROUTE: Record<string, string> = {
  insight: "insights",
  method: "methods",
  context: "context",
  literature: "literature",
  template: "templates",
};

/** Extract a simple YAML frontmatter value from a markdown file. */
function extractFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w_]*)\s*:\s*"?([^"\n]*)"?$/);
    if (kv) fm[kv[1]] = kv[2];
  }
  return fm;
}

/** Add or update a key in the YAML frontmatter. */
function stampFrontmatter(text: string, key: string, value: string): string {
  const fmMatch = text.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    // No frontmatter → add one
    return `---\n${key}: "${value}"\n---\n${text}`;
  }
  const [, open, body, close] = fmMatch;
  // Check if key exists
  const keyRe = new RegExp(`^${key}\\s*:.*$`, "m");
  if (keyRe.test(body)) {
    // Replace existing
    const updated = body.replace(keyRe, `${key}: "${value}"`);
    return text.replace(fmMatch[0], `${open}${updated}${close}`);
  }
  // Append
  return text.replace(fmMatch[0], `${open}${body}\n${key}: "${value}"${close}`);
}

export function envPromote(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "env", subcommand: "promote", error },
    code: 64,
  });

  const envDir = resolve(flagValue(argv, "--env") ?? "");
  const dryRun = argv.includes("--dry-run");
  const targetDirOverride = flagValue(argv, "--target-dir");

  // Extract the file arg (first positional that isn't a flag value)
  const fileArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (argv[i] !== "--dry-run") i++; // skip flag value (except boolean flags)
      continue;
    }
    fileArgs.push(argv[i]);
  }

  if (fileArgs.length === 0) return fail("file path is required: amico env promote <file> --env <env-path>");
  if (!envDir) return fail("--env is required: amico env promote <file> --env <env-path>");

  // Validate environment
  const manifestPath = join(envDir, "research-environment.toml");
  if (!existsSync(manifestPath)) return fail(`no research-environment.toml found in ${envDir}`);

  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    return fail(`failed to read manifest in ${envDir}`);
  }

  // Extract slug from manifest (regex — no smol-toml dependency needed for simple key)
  const slugMatch = manifestText.match(/^slug\s*=\s*"([^"]*)"/m);
  if (!slugMatch) return fail("manifest missing slug field");
  const envSlug = slugMatch[1];

  const promoted: string[] = [];
  const skipped: string[] = [];

  for (const filePath of fileArgs) {
    const absFile = resolve(filePath);
    if (!existsSync(absFile)) {
      return fail(`file not found: ${absFile}`);
    }

    let text: string;
    try {
      text = readFileSync(absFile, "utf8");
    } catch (e) {
      return fail(`failed to read ${absFile}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const fm = extractFrontmatter(text);

    // Check if already promoted to this env
    if (fm.promoted && fm.promoted_to && fm.promoted_to.startsWith(`${envSlug}:`)) {
      skipped.push(absFile);
      continue;
    }

    // Determine target directory
    const type = fm.type;
    let targetDir: string;
    if (targetDirOverride) {
      targetDir = targetDirOverride;
    } else if (type && TYPE_ROUTE[type]) {
      targetDir = TYPE_ROUTE[type];
    } else {
      // Default: unrouted, goes to root of env (or error)
      return fail(`no type in frontmatter and no --target-dir specified for ${absFile}`);
    }

    const fileName = absFile.split("/").pop() || "promoted.md";
    const targetPath = join(envDir, targetDir, fileName);
    const relTarget = `${envSlug}:${targetDir}/${fileName}`;

    if (dryRun) {
      promoted.push(relTarget);
      continue;
    }

    // Create target directory if needed
    mkdirSync(join(envDir, targetDir), { recursive: true });

    // Stamp the copy with provenance
    const now = new Date().toISOString();
    let copyText = stampFrontmatter(text, "promoted_from_project", absFile.split("/").slice(-2, -1)[0] || "unknown");
    copyText = stampFrontmatter(copyText, "promoted_date", now);

    try {
      writeFileSync(targetPath, copyText);
    } catch (e) {
      return fail(`failed to write ${targetPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Stamp the source to prevent re-promotion
    let sourceText = stampFrontmatter(text, "promoted", now);
    sourceText = stampFrontmatter(sourceText, "promoted_to", relTarget);
    try {
      writeFileSync(absFile, sourceText);
    } catch {
      // Source stamp failure is a warning, not fatal
    }

    // Stage the promoted file in git (specific file, never `git add .`)
    try {
      execFileSync("git", ["add", targetPath], { cwd: envDir, stdio: "ignore" });
    } catch {
      // git staging failure is a warning
    }

    promoted.push(relTarget);
  }

  if (dryRun) {
    return {
      json: {
        verb: "env",
        subcommand: "promote",
        dry_run: true,
        would_promote: promoted,
        would_skip: skipped.length,
      },
      code: 0,
    };
  }

  if (skipped.length > 0 && promoted.length === 0) {
    return {
      json: {
        verb: "env",
        subcommand: "promote",
        skipped: true,
        reason: "already promoted to this environment",
      },
      code: 0,
    };
  }

  return {
    json: {
      verb: "env",
      subcommand: "promote",
      promoted: true,
      files: promoted,
      skipped: skipped.length,
      env_slug: envSlug,
    },
    code: 0,
  };
}

// ── bind ────────────────────────────────────────────────────────────────────

export function envBind(argv: string[], opts?: EnvVerbOptions): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "env", subcommand: "bind", error },
    code: 64,
  });

  const slug = positionalArg(argv);
  if (!slug) return fail("slug is required: amico env bind <slug> [--path <dir>] [--env-path <abs>] [--force]");

  const projectDir = resolve(flagValue(argv, "--path") ?? process.cwd());
  const envPath = flagValue(argv, "--env-path");
  const force = argv.includes("--force");

  // Validate: research-project.toml must exist
  const tomlPath = join(projectDir, "research-project.toml");
  if (!existsSync(tomlPath)) {
    return fail(`no research-project.toml found in ${projectDir}`);
  }

  let content: string;
  try {
    content = readFileSync(tomlPath, "utf8");
  } catch (e) {
    return fail(`failed to read ${tomlPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Check registry for a warning
  const registryPath = opts?.registryPath ?? defaultRegistryPath();
  const entries = readRegistry(registryPath);
  const inRegistry = entries.some((e) => e.slug === slug);
  const warning = inRegistry ? undefined : `slug "${slug}" not found in registry — binding anyway`;

  // Check if [environment] section already exists
  const parsed = parseToml(content) as Record<string, unknown>;
  const existingEnv = parsed.environment as { slug?: string; path?: string } | undefined;

  if (existingEnv?.slug) {
    if (existingEnv.slug === slug) {
      // Idempotent — same slug already bound
      return {
        json: {
          verb: "env",
          subcommand: "bind",
          bound: true,
          idempotent: true,
          slug,
          ...(warning ? { warning } : {}),
        },
        code: 0,
      };
    }
    // Different slug — require --force
    if (!force) {
      return fail(
        `project is already bound to "${existingEnv.slug}" — use --force to rebind to "${slug}"`,
      );
    }
    // Force: full parse → mutate → re-render
    try {
      const projectData = parsed as Record<string, unknown>;
      (projectData.environment as Record<string, unknown>) = {
        slug,
        ...(envPath ? { path: envPath } : {}),
      };
      writeFileSync(tomlPath, renderProjectToml(projectData as unknown as ProjectToml));
    } catch (e) {
      return fail(`failed to write ${tomlPath}: ${e instanceof Error ? e.message : String(e)}`);
    }

    return {
      json: {
        verb: "env",
        subcommand: "bind",
        bound: true,
        slug,
        forced: true,
        ...(warning ? { warning } : {}),
      },
      code: 0,
    };
  }

  // Initial bind: string append (preserves comments and formatting)
  const envSection = [
    "",
    "[environment]",
    `slug = "${slug}"`,
    ...(envPath ? [`path = "${envPath}"`] : []),
    "",
  ].join("\n");

  try {
    const appendContent = content.endsWith("\n") ? envSection : "\n" + envSection;
    writeFileSync(tomlPath, content + appendContent);
  } catch (e) {
    return fail(`failed to write ${tomlPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    json: {
      verb: "env",
      subcommand: "bind",
      bound: true,
      slug,
      ...(warning ? { warning } : {}),
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
  if (sub === "promote") return envPromote(rest);
  if (sub === "bind") return envBind(rest);
  return {
    json: {
      verb: "env",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico env create <name> [--path <dir>] [--platform <p>] [--field <f>] [--author <a>]  |  amico env register <path>  |  amico env promote <file> --env <path> [--dry-run] [--target-dir <dir>]  |  amico env bind <slug> [--path <dir>] [--env-path <abs>] [--force]",
    },
    code: 64,
  };
}
