// resolve_environment.test.ts — fixture-based tests for the four-strategy
// environment resolution + edge cases. Part of #882.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEnvironment,
  invalidateEnvironmentCache,
  type ResolvedEnvironment,
} from "../../src/project/resolve_environment";

describe("resolveEnvironment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-resolve-env-"));
    invalidateEnvironmentCache();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a minimal environment dir with a manifest. */
  function makeEnv(dir: string, slug: string, name?: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "research-environment.toml"),
      `schema_version = 1\nname = "${name ?? slug}"\nslug = "${slug}"\ncreated = "2026-09-07"\n`,
    );
  }

  /** Helper: create a project dir with a research-project.toml. */
  function makeProject(dir: string, envSection?: { slug: string; path?: string }): void {
    mkdirSync(dir, { recursive: true });
    let toml = `schema_version = 1\nname = "Test"\nslug = "test"\nquestion = "?"\nstatus = "running"\ncreated = "2026-09-07"\n`;
    if (envSection) {
      toml += `\n[environment]\nslug = "${envSection.slug}"\n`;
      if (envSection.path) toml += `path = "${envSection.path}"\n`;
    }
    writeFileSync(join(dir, "research-project.toml"), toml);
  }

  // ── Strategy 1: walk-up ────────────────────────────────────────────────

  it("walk-up: finds environment in parent directory", () => {
    const envDir = tmpDir;
    makeEnv(envDir, "my-env", "My Env");
    const projectDir = join(envDir, "projects", "my-project");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("my-env");
    expect(result!.name).toBe("My Env");
    expect(result!.path).toBe(envDir);
  });

  it("walk-up: stops at workspace folder root (AC-53)", () => {
    // Environment is ABOVE the workspace root — should NOT be found
    const wsRoot = join(tmpDir, "workspace");
    mkdirSync(wsRoot, { recursive: true });
    makeEnv(tmpDir, "above-ws");
    const projectDir = join(wsRoot, "my-project");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [wsRoot]);
    expect(result).toBeNull();
  });

  it("walk-up: finds environment at the workspace root itself", () => {
    const wsRoot = join(tmpDir, "workspace");
    makeEnv(wsRoot, "ws-env");
    const projectDir = join(wsRoot, "projects", "child");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [wsRoot]);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("ws-env");
  });

  // ── Strategy 2: explicit path ──────────────────────────────────────────

  it("explicit path: resolves via [environment].path in project TOML", () => {
    const envDir = join(tmpDir, "shared-env");
    makeEnv(envDir, "shared-env", "Shared Env");
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "shared-env", path: envDir });

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("shared-env");
    expect(result!.path).toBe(envDir);
  });

  it("explicit path: returns null + no error when path has no manifest (AC-52)", () => {
    const emptyDir = join(tmpDir, "empty-env");
    mkdirSync(emptyDir, { recursive: true });
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "missing", path: emptyDir });

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).toBeNull();
  });

  // ── Strategy 3: workspace scan ─────────────────────────────────────────

  it("workspace scan: finds environment in a sibling workspace folder", () => {
    const envDir = join(tmpDir, "env-folder");
    makeEnv(envDir, "scan-env", "Scanned Env");
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "scan-env" });

    const result = resolveEnvironment(projectDir, [projectDir, envDir]);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("scan-env");
    expect(result!.path).toBe(envDir);
  });

  // ── Strategy 4: registry ───────────────────────────────────────────────

  it("registry: finds environment from ~/.amico/environments.toml", () => {
    const envDir = join(tmpDir, "registered-env");
    makeEnv(envDir, "reg-env", "Registered Env");
    const registryPath = join(tmpDir, "environments.toml");
    writeFileSync(registryPath, `[[environments]]\nslug = "reg-env"\npath = "${envDir}"\n`);

    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "reg-env" });

    const result = resolveEnvironment(projectDir, [projectDir], { registryPath });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("reg-env");
    expect(result!.path).toBe(envDir);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  it("project without [environment] section returns null (AC-4)", () => {
    const projectDir = join(tmpDir, "plain-project");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [projectDir]);
    expect(result).toBeNull();
  });

  it("malformed TOML in manifest returns null (AC-51)", () => {
    const envDir = join(tmpDir, "bad-env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "research-environment.toml"), "this is not valid toml {{{{");
    const projectDir = join(envDir, "projects", "test");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).toBeNull();
  });

  it("schema_version exceeding known version returns null (AC-54)", () => {
    const envDir = join(tmpDir, "future-env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(envDir, "research-environment.toml"),
      `schema_version = 999\nname = "future"\nslug = "future"\ncreated = "2026-09-07"\n`,
    );
    const projectDir = join(envDir, "projects", "test");
    makeProject(projectDir);

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).toBeNull();
  });

  it("walk-up vs explicit slug conflict: prefers walk-up", () => {
    // Walk-up environment
    const walkupEnv = tmpDir;
    makeEnv(walkupEnv, "walkup-env");

    // Explicit path environment (different slug)
    const explicitEnv = join(tmpDir, "other-env");
    makeEnv(explicitEnv, "explicit-env");

    // Project has [environment].slug pointing to explicit, but walk-up finds walkup-env
    const projectDir = join(tmpDir, "projects", "child");
    makeProject(projectDir, { slug: "explicit-env", path: explicitEnv });

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("walkup-env");
  });

  it("caches result per project path", () => {
    const envDir = tmpDir;
    makeEnv(envDir, "cached-env");
    const projectDir = join(envDir, "projects", "test");
    makeProject(projectDir);

    const first = resolveEnvironment(projectDir, [tmpDir]);
    expect(first).not.toBeNull();

    // Remove the manifest — cached result should still return
    rmSync(join(envDir, "research-environment.toml"));
    const second = resolveEnvironment(projectDir, [tmpDir]);
    expect(second).not.toBeNull();
    expect(second!.slug).toBe("cached-env");

    // Invalidate cache — now should return null
    invalidateEnvironmentCache();
    const third = resolveEnvironment(projectDir, [tmpDir]);
    expect(third).toBeNull();
  });
});
