// `amico env promote` — promote files from a project to an environment.
// Part of #889 (sub-issue of #880 Research Environments).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { envPromote } from "../src/env_verb.js";
import { renderEnvironmentToml, type EnvironmentToml } from "../src/environment.js";

describe("envPromote", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amico-env-promote-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a minimal git-initialized environment. */
  function makeEnv(slug: string): string {
    const dir = join(tmpDir, slug);
    mkdirSync(join(dir, "insights"), { recursive: true });
    mkdirSync(join(dir, "methods"), { recursive: true });
    const manifest: EnvironmentToml = {
      schema_version: 1,
      name: slug.replace(/-/g, " "),
      slug,
      created: "2026-09-07",
    };
    writeFileSync(join(dir, "research-environment.toml"), renderEnvironmentToml(manifest));
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    return dir;
  }

  /** Helper: create a source file with frontmatter. */
  function writeNote(dir: string, relPath: string, frontmatter: Record<string, string>, body: string): string {
    const full = join(dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: "${v}"`).join("\n");
    writeFileSync(full, `---\n${fm}\n---\n${body}`);
    return full;
  }

  it("promotes a file to the correct directory based on type frontmatter (AC-47)", () => {
    const envDir = makeEnv("my-env");
    const projectDir = join(tmpDir, "my-project");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "notes/smoothness.md", {
      type: "insight",
      visibility: "environment",
    }, "# Smoothness tradeoff\n");

    const result = envPromote(
      [join(projectDir, "notes/smoothness.md"), "--env", envDir],
    );

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.promoted).toBe(true);

    // File copied to env's insights/
    expect(existsSync(join(envDir, "insights", "smoothness.md"))).toBe(true);

    // Copy has provenance stamps (AC-37)
    const copy = readFileSync(join(envDir, "insights", "smoothness.md"), "utf8");
    expect(copy).toContain("promoted_from_project");
    expect(copy).toContain("promoted_date");

    // Source stamped to prevent re-promotion (AC-38)
    const source = readFileSync(join(projectDir, "notes/smoothness.md"), "utf8");
    expect(source).toContain("promoted:");
    expect(source).toContain("promoted_to:");
    expect(source).toContain("my-env:");
  });

  it("routes type: method to methods/", () => {
    const envDir = makeEnv("test-env");
    const projectDir = join(tmpDir, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "method.md", {
      type: "method",
      visibility: "environment",
    }, "# A method\n");

    const result = envPromote(
      [join(projectDir, "method.md"), "--env", envDir],
    );

    expect(result.code).toBe(0);
    expect(existsSync(join(envDir, "methods", "method.md"))).toBe(true);
  });

  it("--dry-run lists without writing (AC-40)", () => {
    const envDir = makeEnv("dry-env");
    const projectDir = join(tmpDir, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "note.md", {
      type: "insight",
      visibility: "environment",
    }, "# Note\n");

    const result = envPromote(
      [join(projectDir, "note.md"), "--env", envDir, "--dry-run"],
    );

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);

    // File should NOT be copied
    expect(existsSync(join(envDir, "insights", "note.md"))).toBe(false);
  });

  it("already-promoted file is skipped (AC-38)", () => {
    const envDir = makeEnv("skip-env");
    const projectDir = join(tmpDir, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "dup.md", {
      type: "insight",
      visibility: "environment",
      promoted: "2026-09-06T00:00:00Z",
      promoted_to: "skip-env:insights/dup.md",
    }, "# Already promoted\n");

    const result = envPromote(
      [join(projectDir, "dup.md"), "--env", envDir],
    );

    expect(result.code).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.skipped).toBe(true);
  });

  it("returns error when no file specified", () => {
    const result = envPromote(["--env", join(tmpDir, "some-env")]);
    expect(result.code).toBe(64);
  });

  it("returns error when env path has no manifest", () => {
    const emptyDir = join(tmpDir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const projectDir = join(tmpDir, "proj2");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "note.md", { type: "insight" }, "# Note\n");

    const result = envPromote(
      [join(projectDir, "note.md"), "--env", emptyDir],
    );
    expect(result.code).toBe(64);
  });

  it("defaults type to unrouted when type frontmatter is absent", () => {
    const envDir = makeEnv("unrouted-env");
    const projectDir = join(tmpDir, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeNote(projectDir, "random.md", {
      visibility: "environment",
    }, "# No type\n");

    const result = envPromote(
      [join(projectDir, "random.md"), "--env", envDir, "--target-dir", "context"],
    );

    expect(result.code).toBe(0);
    expect(existsSync(join(envDir, "context", "random.md"))).toBe(true);
  });
});
