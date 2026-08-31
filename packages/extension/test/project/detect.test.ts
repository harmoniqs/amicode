// Project type detection tests — #666.
// detectProjectType(dir) returns "research" if project.toml exists, "dev" otherwise.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectType } from "../../src/project/detect";
import { listProjectDirs } from "../../src/amicode_service/project";

describe("detectProjectType", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-detect-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'research' when project.toml exists at the root", () => {
    writeFileSync(join(tmpDir, "project.toml"), 'schema_version = 1\nname = "test"\n');
    expect(detectProjectType(tmpDir)).toBe("research");
  });

  it("returns 'dev' when project.toml does not exist", () => {
    expect(detectProjectType(tmpDir)).toBe("dev");
  });

  it("returns 'dev' for a nonexistent directory", () => {
    expect(detectProjectType(join(tmpDir, "nope"))).toBe("dev");
  });

  it("detects type change: directory gains project.toml after first resolution", () => {
    expect(detectProjectType(tmpDir)).toBe("dev");
    writeFileSync(join(tmpDir, "project.toml"), 'schema_version = 1\n');
    expect(detectProjectType(tmpDir)).toBe("research");
  });
});

// ── integration: listProjectDirs carries type ──────────────────────────────

describe("listProjectDirs with type detection", () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = mkdtempSync(join(tmpdir(), "amicode-list-"));
    // Create two project directories
    mkdirSync(join(parentDir, "research-proj"));
    writeFileSync(join(parentDir, "research-proj", "project.toml"), 'schema_version = 1\n');
    mkdirSync(join(parentDir, "dev-proj"));
  });

  afterEach(() => {
    rmSync(parentDir, { recursive: true, force: true });
  });

  it("returns type 'research' for project with project.toml", () => {
    const projects = listProjectDirs(parentDir);
    const research = projects.find((p) => p.slug === "research-proj");
    expect(research).toBeDefined();
    expect(research!.type).toBe("research");
  });

  it("returns type 'dev' for project without project.toml", () => {
    const projects = listProjectDirs(parentDir);
    const dev = projects.find((p) => p.slug === "dev-proj");
    expect(dev).toBeDefined();
    expect(dev!.type).toBe("dev");
  });

  it("all entries carry the type field", () => {
    const projects = listProjectDirs(parentDir);
    expect(projects).toHaveLength(2);
    for (const p of projects) {
      expect(p.type).toBeDefined();
      expect(["research", "dev"]).toContain(p.type);
    }
  });
});
