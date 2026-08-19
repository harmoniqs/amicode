// Demo workflow showcase tests (#437)
//
// Tests the Julia readiness gate, demo workspace creation/archival,
// and the demo-exclusion predicate.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  checkJuliaReadinessWithChecker,
  demoWorkspacePath,
  isDemoCompleted,
  createDemoWorkspace,
  archiveDemoWorkspace,
  isDemoWorkspace,
  buildDemoSolveSpec,
  DEMO_WORKSPACE_NAME,
  DEMO_PARAMS,
} from "../src/demo_showcase";

// ─── AC1: Readiness gate ─────────────────────────────────────────────────────

describe("checkJuliaReadiness — readiness gate (AC1, AC3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-gate-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns ready:true when both julia on path and manifest exist", () => {
    const manifestPath = path.join(tmpDir, "Manifest.toml");
    fs.writeFileSync(manifestPath, "# manifest");
    const result = checkJuliaReadinessWithChecker(true, manifestPath);
    expect(result.ready).toBe(true);
    expect(result.juliaOnPath).toBe(true);
    expect(result.manifestExists).toBe(true);
  });

  it("returns ready:false with reason when julia not on path", () => {
    const manifestPath = path.join(tmpDir, "Manifest.toml");
    fs.writeFileSync(manifestPath, "# manifest");
    const result = checkJuliaReadinessWithChecker(false, manifestPath);
    expect(result.ready).toBe(false);
    expect(result.juliaOnPath).toBe(false);
    expect(result.manifestExists).toBe(true);
    expect(result.reason).toContain("Julia binary not found");
  });

  it("returns ready:false with reason when manifest missing", () => {
    const manifestPath = path.join(tmpDir, "nonexistent", "Manifest.toml");
    const result = checkJuliaReadinessWithChecker(true, manifestPath);
    expect(result.ready).toBe(false);
    expect(result.juliaOnPath).toBe(true);
    expect(result.manifestExists).toBe(false);
    expect(result.reason).toContain("Manifest.toml missing");
  });

  it("returns ready:false with both reasons when neither condition passes", () => {
    const manifestPath = path.join(tmpDir, "nonexistent", "Manifest.toml");
    const result = checkJuliaReadinessWithChecker(false, manifestPath);
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("Julia binary");
    expect(result.reason).toContain("Manifest.toml");
  });
});

// ─── AC4, AC7: Workspace creation and archival ───────────────────────────────

describe("demo workspace lifecycle (AC4, AC7, AC10)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-ws-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("AC4: creates __demo__ workspace at the expected path", () => {
    const wsPath = createDemoWorkspace(tmpDir);
    expect(wsPath).toBe(path.join(tmpDir, DEMO_WORKSPACE_NAME));
    expect(fs.existsSync(wsPath)).toBe(true);
    expect(fs.existsSync(path.join(wsPath, "solve.jl"))).toBe(true);
  });

  it("AC4: workspace name is __demo__", () => {
    expect(demoWorkspacePath(tmpDir)).toBe(path.join(tmpDir, "__demo__"));
  });

  it("AC7: archival creates .archived marker and removes workspace", () => {
    createDemoWorkspace(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, DEMO_WORKSPACE_NAME))).toBe(true);

    archiveDemoWorkspace(tmpDir);

    // Marker exists
    const markerPath = path.join(tmpDir, `${DEMO_WORKSPACE_NAME}.archived`);
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(marker.reason).toBe("demo_completed");
    expect(marker.archived_at).toBeTruthy();

    // Workspace removed
    expect(fs.existsSync(path.join(tmpDir, DEMO_WORKSPACE_NAME))).toBe(false);
  });

  it("AC10: isDemoCompleted detects archived demos", () => {
    expect(isDemoCompleted(tmpDir)).toBe(false);

    createDemoWorkspace(tmpDir);
    archiveDemoWorkspace(tmpDir);

    expect(isDemoCompleted(tmpDir)).toBe(true);
  });

  it("AC10: isDemoCompleted detects FINISHED in workspace", () => {
    createDemoWorkspace(tmpDir);
    fs.writeFileSync(path.join(tmpDir, DEMO_WORKSPACE_NAME, "FINISHED"), "");
    expect(isDemoCompleted(tmpDir)).toBe(true);
  });

  it("isDemoWorkspace identifies demo names for exclusion", () => {
    expect(isDemoWorkspace("__demo__")).toBe(true);
    expect(isDemoWorkspace("__demo__.archived")).toBe(true);
    expect(isDemoWorkspace("my-real-problem")).toBe(false);
    expect(isDemoWorkspace("demo")).toBe(false);
  });
});

// ─── AC5: Demo parameters ────────────────────────────────────────────────────

describe("demo parameters (AC5)", () => {
  it("uses stock transmon X-gate parameters", () => {
    expect(DEMO_PARAMS.platform).toBe("transmon");
    expect(DEMO_PARAMS.gate).toBe("X");
    expect(DEMO_PARAMS.T).toBe(10);
    expect(DEMO_PARAMS.N).toBe(50);
    expect(DEMO_PARAMS.max_iter).toBe(60);
  });

  it("buildDemoSolveSpec produces a valid vetted-tier spec", () => {
    const spec = buildDemoSolveSpec("/path/to/solve.jl", "/project", "/template.jl");
    expect(spec.schema_version).toBe("2");
    expect(spec.tier).toBe("vetted");
    expect(spec.executor).toBe("local");
    expect(spec.env.kind).toBe("provisioned");
    expect(spec.script_path).toBe("/path/to/solve.jl");
    expect(spec.source.template).toBe("/template.jl");
  });
});

// ─── AC9: No vault artifacts ─────────────────────────────────────────────────

describe("demo constraints (AC9)", () => {
  it("demo workspace uses reserved name excluded from normal listings", () => {
    // Any code that lists problems should call isDemoWorkspace to exclude
    expect(isDemoWorkspace(DEMO_WORKSPACE_NAME)).toBe(true);
  });

  it("solve.jl contains demo marker comment", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-content-"));
    createDemoWorkspace(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, DEMO_WORKSPACE_NAME, "solve.jl"), "utf8");
    expect(content).toContain("Demo");
    expect(content).toContain("auto-generated");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
