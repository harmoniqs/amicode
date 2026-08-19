// Demo workflow showcase — Stage 4: Julia gate + __demo__ workspace (#437)
//
// Readiness gate (Julia on PATH + Manifest.toml exists), demo workspace
// creation/archival, and the score-stage logic for running the transmon X-gate
// demo as a workflow showcase.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

// ─── Readiness gate ──────────────────────────────────────────────────────────

export interface ReadinessResult {
  ready: boolean;
  juliaOnPath: boolean;
  manifestExists: boolean;
  reason?: string;
}

/** Check if the Julia environment is ready for the demo.
 *  Both conditions must pass: julia binary on PATH AND ~/.amico/julia/Manifest.toml exists. */
export function checkJuliaReadiness(
  manifestPath: string = path.join(os.homedir(), ".amico", "julia", "Manifest.toml"),
): ReadinessResult {
  const juliaOnPath = isJuliaOnPath();
  const manifestExists = fs.existsSync(manifestPath);

  if (juliaOnPath && manifestExists) {
    return { ready: true, juliaOnPath, manifestExists };
  }

  const reasons: string[] = [];
  if (!juliaOnPath) reasons.push("Julia binary not found on PATH");
  if (!manifestExists) reasons.push("Julia environment not precompiled (~/.amico/julia/Manifest.toml missing)");

  return {
    ready: false,
    juliaOnPath,
    manifestExists,
    reason: reasons.join("; "),
  };
}

/** Check if `julia` is available on PATH. */
function isJuliaOnPath(): boolean {
  try {
    execFileSync("which", ["julia"], { encoding: "utf8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Testable version that accepts a checker function. */
export function checkJuliaReadinessWithChecker(
  juliaOnPath: boolean,
  manifestPath: string = path.join(os.homedir(), ".amico", "julia", "Manifest.toml"),
): ReadinessResult {
  const manifestExists = fs.existsSync(manifestPath);

  if (juliaOnPath && manifestExists) {
    return { ready: true, juliaOnPath, manifestExists };
  }

  const reasons: string[] = [];
  if (!juliaOnPath) reasons.push("Julia binary not found on PATH");
  if (!manifestExists) reasons.push("Julia environment not precompiled (~/.amico/julia/Manifest.toml missing)");

  return { ready: false, juliaOnPath, manifestExists, reason: reasons.join("; ") };
}

// ─── Demo workspace management ───────────────────────────────────────────────

export const DEMO_WORKSPACE_NAME = "__demo__";

/** Resolve the demo workspace path. */
export function demoWorkspacePath(
  problemsRoot: string = path.join(os.homedir(), ".amico", "problems"),
): string {
  return path.join(problemsRoot, DEMO_WORKSPACE_NAME);
}

/** Check if a demo has already been completed (archive marker exists). */
export function isDemoCompleted(
  problemsRoot: string = path.join(os.homedir(), ".amico", "problems"),
): boolean {
  const archivePath = path.join(problemsRoot, `${DEMO_WORKSPACE_NAME}.archived`);
  const workspacePath = demoWorkspacePath(problemsRoot);
  // Archived marker OR a FINISHED file in the workspace
  if (fs.existsSync(archivePath)) return true;
  if (fs.existsSync(path.join(workspacePath, "FINISHED"))) return true;
  return false;
}

/** Create the __demo__ workspace with the vetted solve.jl for transmon X gate. */
export function createDemoWorkspace(
  problemsRoot: string = path.join(os.homedir(), ".amico", "problems"),
  templateContent: string = DEFAULT_DEMO_SOLVE,
): string {
  const wsPath = demoWorkspacePath(problemsRoot);
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "solve.jl"), templateContent);
  return wsPath;
}

/** Archive the demo workspace after completion.
 *  Creates a `.archived` marker and optionally removes the workspace. */
export function archiveDemoWorkspace(
  problemsRoot: string = path.join(os.homedir(), ".amico", "problems"),
): void {
  const wsPath = demoWorkspacePath(problemsRoot);
  const archivePath = path.join(problemsRoot, `${DEMO_WORKSPACE_NAME}.archived`);

  // Write archive marker with timestamp
  fs.writeFileSync(archivePath, JSON.stringify({
    archived_at: new Date().toISOString(),
    reason: "demo_completed",
  }) + "\n");

  // Remove the workspace directory (it's ephemeral)
  try {
    fs.rmSync(wsPath, { recursive: true, force: true });
  } catch {
    // Non-critical — marker is what matters
  }
}

/** Check if a given problem name is the demo workspace (for exclusion from listings). */
export function isDemoWorkspace(name: string): boolean {
  return name === DEMO_WORKSPACE_NAME || name === `${DEMO_WORKSPACE_NAME}.archived`;
}

// ─── Demo solve parameters (stock, vetted) ───────────────────────────────────

export const DEMO_PARAMS = {
  platform: "transmon",
  gate: "X",
  T: 10, // ns
  N: 50, // timesteps
  max_iter: 60,
  levels: 3,
  drive_max: 0.2, // GHz
} as const;

/** The solve.jl content for the demo. In production this would be filled from
 *  the vetted template; here we define the stock parameters that go into it. */
export const DEFAULT_DEMO_SOLVE = `# Amicode Demo — Transmon X Gate (vetted template, stock params)
# This file is auto-generated for the onboarding demo workflow showcase.
# Parameters: T=${DEMO_PARAMS.T}ns, N=${DEMO_PARAMS.N}, max_iter=${DEMO_PARAMS.max_iter}
#
# The actual solve.jl is authored from the vetted template at launch time
# via amico-run resolve + the fill-in-the-block flow.
`;

// ─── Demo solvespec ──────────────────────────────────────────────────────────

export interface DemoSolveSpec {
  schema_version: "2";
  script_path: string;
  lab_id: string;
  executor: "local";
  tier: "vetted";
  env: { kind: "provisioned"; project: string };
  source: { template: string };
}

/** Build the solvespec for the demo run. */
export function buildDemoSolveSpec(
  scriptPath: string,
  juliaProject: string = path.join(os.homedir(), ".amico", "julia"),
  templatePath: string = "",
): DemoSolveSpec {
  return {
    schema_version: "2",
    script_path: scriptPath,
    lab_id: "default",
    executor: "local",
    tier: "vetted",
    env: { kind: "provisioned", project: juliaProject },
    source: { template: templatePath },
  };
}
