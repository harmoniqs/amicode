// project_verb.ts — CLI wrapper for `amico project create` and `amico project import`.
// Pure logic lives in project.ts; this module handles filesystem I/O, git init,
// flag parsing, and the verb dispatch. Part of #665.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  nameToSlug,
  scaffoldManifest,
  validateProjectToml,
  type ProjectToml,
} from "./project.js";
import type { VerbResult } from "./verbs.js";

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

// ── create ──────────────────────────────────────────────────────────────────

export function projectCreate(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "project", subcommand: "create", error },
    code: 64,
  });

  // The project name is the first positional argument (non-flag)
  const name = positionalArg(argv);
  if (!name) return fail("project name is required: amico project create <name>");

  const slug = nameToSlug(name);
  const defaultPath = join(homedir(), "projects", slug);
  const projectDir = resolve(flagValue(argv, "--path") ?? defaultPath);

  // Idempotent: if research-project.toml already exists, validate and return
  const tomlPath = join(projectDir, "research-project.toml");
  if (existsSync(tomlPath)) {
    try {
      const existing = parseToml(readFileSync(tomlPath, "utf8")) as unknown as ProjectToml;
      const v = validateProjectToml(existing);
      if (v.ok) {
        return {
          json: {
            verb: "project",
            subcommand: "create",
            created: false,
            idempotent: true,
            path: projectDir,
            slug: existing.slug,
          },
          code: 0,
        };
      }
    } catch {
      // If the existing TOML is invalid, fall through and overwrite
    }
  }

  const domain = flagValue(argv, "--domain");
  const venue = flagValue(argv, "--venue");
  const deadline = flagValue(argv, "--deadline");

  const project: ProjectToml = {
    schema_version: 1,
    name,
    slug,
    question: flagValue(argv, "--question") ?? "TODO",
    status: "proposing",
    created: today(),
    tags: [],
    authors: { lead: flagValue(argv, "--author") },
    ...(domain ? { domain_pack: { name: domain } } : {}),
    ...(venue ? { venue: { name: venue, ...(deadline ? { deadline } : {}) } } : {}),
  };

  // Create directory and scaffold
  try {
    mkdirSync(projectDir, { recursive: true });
  } catch (e) {
    return fail(`failed to create directory: ${e instanceof Error ? e.message : String(e)}`);
  }

  const manifest = scaffoldManifest(project);
  try {
    for (const item of manifest) {
      const fullPath = join(projectDir, item.path);
      if (item.content === null) {
        mkdirSync(fullPath, { recursive: true });
      } else {
        // Don't overwrite existing files (idempotent)
        if (!existsSync(fullPath)) {
          mkdirSync(join(fullPath, ".."), { recursive: true });
          writeFileSync(fullPath, item.content);
        }
      }
    }
  } catch (e) {
    return fail(`failed to scaffold: ${e instanceof Error ? e.message : String(e)}`);
  }

  // git init + initial commit
  try {
    if (!existsSync(join(projectDir, ".git"))) {
      execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: projectDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `init: scaffold research project "${name}"`], {
        cwd: projectDir,
        stdio: "ignore",
      });
    }
  } catch (e) {
    // git failure is a warning, not a hard error — the scaffold is on disk
    return {
      json: {
        verb: "project",
        subcommand: "create",
        created: true,
        path: projectDir,
        slug,
        warning: `git init failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      code: 0,
    };
  }

  return {
    json: {
      verb: "project",
      subcommand: "create",
      created: true,
      path: projectDir,
      slug,
    },
    code: 0,
  };
}

// ── import ──────────────────────────────────────────────────────────────────

export function projectImport(argv: string[]): VerbResult {
  const fail = (error: string): VerbResult => ({
    json: { verb: "project", subcommand: "import", error },
    code: 64,
  });

  // The directory is the first positional argument, or "." by default
  const dir = resolve(positionalArg(argv) ?? ".");

  if (!existsSync(dir)) return fail(`directory not found: ${dir}`);

  const tomlPath = join(dir, "research-project.toml");

  // Idempotent: if research-project.toml already exists, validate and return
  if (existsSync(tomlPath)) {
    try {
      const existing = parseToml(readFileSync(tomlPath, "utf8")) as unknown as ProjectToml;
      const v = validateProjectToml(existing);
      if (v.ok) {
        return {
          json: {
            verb: "project",
            subcommand: "import",
            imported: false,
            idempotent: true,
            path: dir,
            slug: existing.slug,
          },
          code: 0,
        };
      }
    } catch {
      // Invalid TOML; fall through
    }
  }

  // For import, infer name from directory basename
  const basename = dir.split("/").pop() || "unnamed";
  const name = flagValue(argv, "--name") ?? basename;
  const slug = nameToSlug(name);
  const question = flagValue(argv, "--question") ?? "TODO";
  const status = (flagValue(argv, "--status") ?? "running") as ProjectToml["status"];

  const project: ProjectToml = {
    schema_version: 1,
    name,
    slug,
    question,
    status,
    created: today(),
  };

  // Scaffold missing directories without overwriting existing files
  const manifest = scaffoldManifest(project);
  const scaffolded: string[] = [];

  try {
    for (const item of manifest) {
      const fullPath = join(dir, item.path);
      if (item.content === null) {
        if (!existsSync(fullPath)) {
          mkdirSync(fullPath, { recursive: true });
          scaffolded.push(item.path + "/");
        }
      } else {
        if (!existsSync(fullPath)) {
          mkdirSync(join(fullPath, ".."), { recursive: true });
          writeFileSync(fullPath, item.content);
          scaffolded.push(item.path);
        }
      }
    }
  } catch (e) {
    return fail(`failed to scaffold: ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    json: {
      verb: "project",
      subcommand: "import",
      imported: true,
      path: dir,
      slug,
      scaffolded,
    },
    code: 0,
  };
}

// ── dispatch ────────────────────────────────────────────────────────────────

export function projectVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "create") return projectCreate(rest);
  if (sub === "import") return projectImport(rest);
  return {
    json: {
      verb: "project",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage: "amico project create <name> [--path <dir>] [--domain <pack>] [--venue <name>] [--deadline <date>]  |  amico project import [<dir>] [--name <n>] [--question <q>] [--status <s>]",
    },
    code: 64,
  };
}
