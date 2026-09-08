// `amico env create` / `amico env register` — integration tests for the
// environment CLI verbs. Filesystem I/O in env_verb.ts.
// Part of #881 (sub-issue of #880 Research Environments).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

import { envCreate, envRegister, envBind, checkNestingViolation } from "../src/env_verb.js";
import { ENV_SCAFFOLD_DIRS, renderEnvironmentToml, type EnvironmentToml } from "../src/environment.js";

// ── integration: env create verb ───────────────────────────────────────────

describe("envCreate", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-env-create-"));
    registryPath = join(tmpDir, "environments.toml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds directory with manifest, dirs, and git init (AC-22)", () => {
    const envDir = join(tmpDir, "transmon-oc");
    const result = envCreate(
      ["Transmon Optimal Control", "--path", envDir],
      { registryPath },
    );

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.created).toBe(true);
    expect(json.slug).toBe("transmon-optimal-control");

    // Manifest exists and is valid TOML
    const manifestPath = join(envDir, "research-environment.toml");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = parseToml(readFileSync(manifestPath, "utf8"));
    expect(manifest.schema_version).toBe(1);
    expect(manifest.name).toBe("Transmon Optimal Control");
    expect(manifest.slug).toBe("transmon-optimal-control");

    // All scaffold dirs exist
    for (const dir of ENV_SCAFFOLD_DIRS) {
      expect(existsSync(join(envDir, dir))).toBe(true);
    }

    // Git initialized
    expect(existsSync(join(envDir, ".git"))).toBe(true);

    // Registry updated
    expect(existsSync(registryPath)).toBe(true);
    const reg = readFileSync(registryPath, "utf8");
    expect(reg).toContain("transmon-optimal-control");
    expect(reg).toContain(envDir);
  });

  it("passes --platform and --field to domain section", () => {
    const envDir = join(tmpDir, "domain-test");
    envCreate(
      ["Domain Test", "--path", envDir, "--platform", "transmon", "--field", "quantum-control"],
      { registryPath },
    );

    const manifest = parseToml(readFileSync(join(envDir, "research-environment.toml"), "utf8"));
    const domain = manifest.domain as Record<string, unknown>;
    expect(domain.platform).toBe("transmon");
    expect(domain.field).toBe("quantum-control");
  });

  it("passes --author to authors section", () => {
    const envDir = join(tmpDir, "author-test");
    envCreate(
      ["Author Test", "--path", envDir, "--author", "JJ Lee"],
      { registryPath },
    );

    const manifest = parseToml(readFileSync(join(envDir, "research-environment.toml"), "utf8"));
    const authors = manifest.authors as Record<string, unknown>;
    expect(authors.lead).toBe("JJ Lee");
  });

  it("is idempotent when manifest already exists", () => {
    const envDir = join(tmpDir, "idempotent");
    const first = envCreate(["Idempotent", "--path", envDir], { registryPath });
    expect((first.json as Record<string, unknown>).created).toBe(true);

    const second = envCreate(["Idempotent", "--path", envDir], { registryPath });
    expect(second.code).toBe(0);
    expect((second.json as Record<string, unknown>).idempotent).toBe(true);
  });

  it("returns error when no name is provided", () => {
    const result = envCreate(["--path", join(tmpDir, "bad")], { registryPath });
    expect(result.code).toBe(64);
    expect((result.json as Record<string, unknown>).error).toBeDefined();
  });

  it("refuses to create an environment inside a project directory", () => {
    // Create a project directory first
    const projectDir = join(tmpDir, "my-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "research-project.toml"),
      `schema_version = 1\nname = "Test"\nslug = "test"\nquestion = "?"\nstatus = "running"\ncreated = "2026-09-07"\n`,
    );

    // Try to create an environment inside it
    const envDir = join(projectDir, "shared-env");
    const result = envCreate(["Shared", "--path", envDir], { registryPath });
    expect(result.code).toBe(64);
    expect((result.json as Record<string, unknown>).error).toContain("separate repos");
  });

  it("refuses to create an environment inside another environment", () => {
    // Create a parent environment
    const parentDir = join(tmpDir, "parent-env");
    envCreate(["Parent", "--path", parentDir], { registryPath });

    // Try to nest another environment inside it
    const childDir = join(parentDir, "child-env");
    const result = envCreate(["Child", "--path", childDir], { registryPath });
    expect(result.code).toBe(64);
    expect((result.json as Record<string, unknown>).error).toContain("must not be nested");
  });
});

// ── integration: env register verb ─────────────────────────────────────────

describe("envRegister", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-env-register-"));
    registryPath = join(tmpDir, "environments.toml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a minimal valid environment directory. */
  function makeEnvDir(slug: string): string {
    const dir = join(tmpDir, slug);
    mkdirSync(dir, { recursive: true });
    const manifest: EnvironmentToml = {
      schema_version: 1,
      name: slug.replace(/-/g, " "),
      slug,
      created: "2026-09-07",
    };
    writeFileSync(join(dir, "research-environment.toml"), renderEnvironmentToml(manifest));
    return dir;
  }

  it("registers an existing environment in the registry (AC-43)", () => {
    const dir = makeEnvDir("my-env");
    const result = envRegister([dir], { registryPath });

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.registered).toBe(true);
    expect(json.slug).toBe("my-env");

    // Registry file contains the entry
    const reg = readFileSync(registryPath, "utf8");
    expect(reg).toContain("my-env");
    expect(reg).toContain(dir);
  });

  it("exits non-zero if no valid manifest found (AC-43)", () => {
    const emptyDir = join(tmpDir, "no-manifest");
    mkdirSync(emptyDir, { recursive: true });

    const result = envRegister([emptyDir], { registryPath });
    expect(result.code).toBe(64);
  });

  it("replaces existing entry on slug collision + emits notice (AC-44)", () => {
    const dir1 = makeEnvDir("collision-env");
    envRegister([dir1], { registryPath });

    // Create a second directory with the same slug
    const dir2 = join(tmpDir, "collision-env-v2");
    mkdirSync(dir2, { recursive: true });
    const manifest: EnvironmentToml = {
      schema_version: 1,
      name: "collision env",
      slug: "collision-env",
      created: "2026-09-07",
    };
    writeFileSync(join(dir2, "research-environment.toml"), renderEnvironmentToml(manifest));

    const result = envRegister([dir2], { registryPath });
    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.replaced).toBe(true);

    // Registry should have only one entry for this slug, pointing to dir2
    const reg = readFileSync(registryPath, "utf8");
    expect(reg).toContain(dir2);
    // Parse and verify exactly one entry with the new path
    const entries = parseToml(reg) as { environments: Array<{ slug: string; path: string }> };
    expect(entries.environments).toHaveLength(1);
    expect(entries.environments[0].path).toBe(dir2);
  });

  it("exits non-zero for a nonexistent path", () => {
    const result = envRegister([join(tmpDir, "does-not-exist")], { registryPath });
    expect(result.code).toBe(64);
  });
});

// ── integration: env bind verb ──────────────────────────────────────────────

describe("envBind", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-env-bind-"));
    registryPath = join(tmpDir, "environments.toml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a minimal research-project.toml in a project directory. */
  function makeProjectDir(name = "my-project", extraToml = ""): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "research-project.toml"),
      `schema_version = 1\nname = "Test"\nslug = "test"\nquestion = "?"\nstatus = "running"\ncreated = "2026-09-07"\n${extraToml}`,
    );
    return dir;
  }

  /** Helper: create a minimal environment and register it. */
  function makeEnvAndRegister(slug: string): string {
    const dir = join(tmpDir, slug);
    envCreate([slug, "--path", dir], { registryPath });
    return dir;
  }

  it("writes [environment] section via string append (preserves comments)", () => {
    const projectDir = makeProjectDir("proj1");
    makeEnvAndRegister("shared-env");

    const result = envBind(["shared-env", "--path", projectDir], { registryPath });

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.bound).toBe(true);
    expect(json.slug).toBe("shared-env");

    // Verify the TOML was appended (not re-rendered): original content intact
    const content = readFileSync(join(projectDir, "research-project.toml"), "utf8");
    expect(content).toContain('[environment]');
    expect(content).toContain('slug = "shared-env"');
    // Original top-level fields still present in original form
    expect(content).toContain('schema_version = 1');
    expect(content).toContain('question = "?"');
  });

  it("is idempotent on same slug", () => {
    const projectDir = makeProjectDir("proj2");
    makeEnvAndRegister("my-env");

    const first = envBind(["my-env", "--path", projectDir], { registryPath });
    expect(first.code).toBe(0);

    const second = envBind(["my-env", "--path", projectDir], { registryPath });
    expect(second.code).toBe(0);
    const json = second.json as Record<string, unknown>;
    expect(json.idempotent).toBe(true);
  });

  it("refuses different slug without --force", () => {
    const projectDir = makeProjectDir("proj3");
    makeEnvAndRegister("env-a");
    makeEnvAndRegister("env-b");

    envBind(["env-a", "--path", projectDir], { registryPath });
    const result = envBind(["env-b", "--path", projectDir], { registryPath });

    expect(result.code).toBe(64);
    const json = result.json as Record<string, unknown>;
    expect(json.error).toContain("env-a");
  });

  it("allows different slug with --force (full re-render)", () => {
    const projectDir = makeProjectDir("proj4");
    makeEnvAndRegister("env-a");
    makeEnvAndRegister("env-b");

    envBind(["env-a", "--path", projectDir], { registryPath });
    const result = envBind(["env-b", "--path", projectDir, "--force"], { registryPath });

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.bound).toBe(true);
    expect(json.slug).toBe("env-b");

    // Verify the slug was updated
    const content = readFileSync(join(projectDir, "research-project.toml"), "utf8");
    expect(content).toContain('slug = "env-b"');
    // Should NOT contain the old slug in an [environment] context
    const envSection = content.slice(content.indexOf("[environment]"));
    expect(envSection).not.toContain("env-a");
  });

  it("returns error when no research-project.toml found", () => {
    const emptyDir = join(tmpDir, "no-manifest");
    mkdirSync(emptyDir, { recursive: true });

    const result = envBind(["some-env", "--path", emptyDir], { registryPath });
    expect(result.code).toBe(64);
    expect((result.json as Record<string, unknown>).error).toContain("research-project.toml");
  });

  it("warns but allows when slug is not in the registry", () => {
    const projectDir = makeProjectDir("proj5");
    // Do NOT create/register the environment — just bind the slug

    const result = envBind(["unknown-env", "--path", projectDir], { registryPath });

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.bound).toBe(true);
    expect(json.warning).toContain("not found in registry");

    // Verify it still wrote the binding
    const content = readFileSync(join(projectDir, "research-project.toml"), "utf8");
    expect(content).toContain('slug = "unknown-env"');
  });

  it("supports --env-path to set an explicit path in the [environment] section", () => {
    const projectDir = makeProjectDir("proj6");
    makeEnvAndRegister("env-with-path");

    const envPath = "/some/absolute/path/to/env";
    const result = envBind(["env-with-path", "--path", projectDir, "--env-path", envPath], { registryPath });

    expect(result.code).toBe(0);
    const content = readFileSync(join(projectDir, "research-project.toml"), "utf8");
    expect(content).toContain(`path = "${envPath}"`);
  });
});

// ── nesting guard ──────────────────────────────────────────────────────────

describe("checkNestingViolation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-nesting-guard-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ok for a standalone directory", () => {
    const dir = join(tmpDir, "clean-env");
    mkdirSync(dir, { recursive: true });
    const result = checkNestingViolation(dir);
    expect(result.ok).toBe(true);
  });

  it("rejects a directory nested inside a project", () => {
    const projectDir = join(tmpDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "research-project.toml"),
      `schema_version = 1\nname = "P"\nslug = "p"\nquestion = "?"\nstatus = "running"\ncreated = "2026-09-07"\n`,
    );

    const nested = join(projectDir, "sub", "env");
    mkdirSync(nested, { recursive: true });
    const result = checkNestingViolation(nested);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("separate repos");
  });

  it("rejects a directory nested inside another environment", () => {
    const parentEnv = join(tmpDir, "parent-env");
    mkdirSync(parentEnv, { recursive: true });
    writeFileSync(
      join(parentEnv, "research-environment.toml"),
      `schema_version = 1\nname = "P"\nslug = "p"\ncreated = "2026-09-07"\n`,
    );

    const nested = join(parentEnv, "child");
    mkdirSync(nested, { recursive: true });
    const result = checkNestingViolation(nested);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must not be nested");
  });
});
