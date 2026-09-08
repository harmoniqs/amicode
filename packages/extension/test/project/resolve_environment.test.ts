// resolve_environment.test.ts — fixture-based tests for the three-strategy
// environment resolution + edge cases. Part of #882.
//
// Multi-repo only: walk-up was removed — projects and environments are always
// separate repos linked by [environment].slug (or .path).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEnvironment,
  invalidateEnvironmentCache,
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

  // ── Strategy 1: explicit path ──────────────────────────────────────────

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

  // ── Strategy 2: workspace scan ─────────────────────────────────────────

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

  // ── Strategy 3: registry ───────────────────────────────────────────────

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

  // ── Priority: explicit path wins over workspace scan ───────────────────

  it("explicit path wins over workspace scan when both match", () => {
    // Environment A: reachable via explicit path
    const envA = join(tmpDir, "env-explicit");
    makeEnv(envA, "env-a", "Env A");

    // Environment B: reachable via workspace scan (same slug as project's [environment].slug)
    const envB = join(tmpDir, "env-workspace");
    makeEnv(envB, "env-a", "Env B"); // same slug, different dir

    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "env-a", path: envA });

    // Both strategies could match — explicit path should win
    const result = resolveEnvironment(projectDir, [projectDir, envB]);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(envA);
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
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "bad", path: envDir });

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
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "future", path: envDir });

    const result = resolveEnvironment(projectDir, [tmpDir]);
    expect(result).toBeNull();
  });

  it("caches result per project path", () => {
    const envDir = join(tmpDir, "cached-env");
    makeEnv(envDir, "cached-env");
    const projectDir = join(tmpDir, "my-project");
    makeProject(projectDir, { slug: "cached-env", path: envDir });

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
