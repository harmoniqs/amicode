/**
 * Dependency resolver and auto-provisioning — #1020
 *
 * Shared pre-flight check that both rebuild paths call before starting work.
 * Detects what is needed per mode, checks what is present, and auto-provisions
 * what is missing with user consent.
 *
 * Hard prerequisites (detect + guide, never auto-install):
 * - Node >= 20
 * - git
 *
 * Auto-provisionable:
 * - pnpm: corepack enable → corepack prepare, fallback to npm exec
 * - bun: curl -fsSL https://bun.sh/install | bash (local mode only)
 * - fork clone: gh repo clone harmoniqs/opencode (local mode only)
 */

import type { ExecResult } from "./main_source_resolver";

export type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;

export type RebuildMode = "main" | "local";

// ── Types ──

export interface DependencyCheckResult {
  tool: string;
  required: boolean;
  present: boolean;
  sufficient?: boolean;
  version?: string;
  provisionMethod?: string;
  fallbackMethod?: string;
  resolvedPath?: string;
}

export interface ProvisionAction {
  tool: string;
  action: string;
  method: string;
  targetPath?: string;
}

export interface Blocker {
  tool: string;
  guidance: string;
}

export interface ProvisionPlan {
  provisions: ProvisionAction[];
  blockers: Blocker[];
}

export interface ProvisionResult {
  ok: boolean;
  method?: string;
  path?: string;
  error?: string;
}

// ── Version parsing ──

function parseNodeVersion(output: string): number | null {
  const match = output.trim().match(/^v?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ── checkDependencies ──

/**
 * Check all dependencies required for the given rebuild mode.
 * Returns a structured result for each tool.
 */
export async function checkDependencies(
  mode: RebuildMode,
  exec: ExecFn,
): Promise<DependencyCheckResult[]> {
  const results: DependencyCheckResult[] = [];

  // ── Node ──
  const nodeResult = await exec("node --version");
  if (nodeResult.ok) {
    const major = parseNodeVersion(nodeResult.stdout ?? "");
    results.push({
      tool: "node",
      required: true,
      present: true,
      sufficient: major !== null && major >= 20,
      version: (nodeResult.stdout ?? "").trim(),
    });
  } else {
    results.push({ tool: "node", required: true, present: false, sufficient: false });
  }

  // ── git ──
  const gitResult = await exec("git --version");
  results.push({
    tool: "git",
    required: true,
    present: gitResult.ok,
    sufficient: gitResult.ok,
    version: gitResult.ok ? (gitResult.stdout ?? "").trim() : undefined,
  });

  // ── pnpm ──
  const pnpmResult = await exec("pnpm --version");
  if (pnpmResult.ok) {
    results.push({
      tool: "pnpm",
      required: true,
      present: true,
      sufficient: true,
      version: (pnpmResult.stdout ?? "").trim(),
    });
  } else {
    // Check corepack availability for provision method
    const corepackResult = await exec("which corepack");
    results.push({
      tool: "pnpm",
      required: true,
      present: false,
      sufficient: false,
      provisionMethod: corepackResult.ok ? "corepack" : "npm-exec",
      fallbackMethod: "npm-exec",
    });
  }

  // ── gh ──
  const ghResult = await exec("gh --version");
  results.push({
    tool: "gh",
    required: mode === "local", // hard in local, soft in main
    present: ghResult.ok,
    sufficient: ghResult.ok,
    version: ghResult.ok ? (ghResult.stdout ?? "").trim() : undefined,
  });

  // ── bun (local mode only) ──
  if (mode === "local") {
    const bunResult = await exec("bun --version");
    results.push({
      tool: "bun",
      required: true,
      present: bunResult.ok,
      sufficient: bunResult.ok,
      version: bunResult.ok ? (bunResult.stdout ?? "").trim() : undefined,
      provisionMethod: "curl",
    });
  }

  return results;
}

// ── buildProvisionPlan ──

const GUIDANCE: Record<string, string> = {
  node: "Install Node >= 20 via nodejs.org, nvm, fnm, or your package manager.",
  git: "Install git via your package manager or https://git-scm.com.",
  gh: "Install the GitHub CLI (https://cli.github.com) and run `gh auth login`.",
};

/**
 * Build a provision plan from dependency check results.
 * Separates hard blockers (cannot auto-provision) from provisionable actions.
 */
export function buildProvisionPlan(deps: DependencyCheckResult[]): ProvisionPlan {
  const blockers: Blocker[] = [];
  const provisions: ProvisionAction[] = [];

  for (const dep of deps) {
    if (!dep.required) continue;
    if (dep.present && dep.sufficient) continue;

    // Hard prerequisites: cannot be auto-provisioned
    if (dep.tool === "node" || dep.tool === "git") {
      blockers.push({
        tool: dep.tool,
        guidance: GUIDANCE[dep.tool] ?? `Install ${dep.tool}.`,
      });
      continue;
    }

    // gh: hard in local mode but cannot auto-provision
    if (dep.tool === "gh" && !dep.present) {
      blockers.push({
        tool: dep.tool,
        guidance: GUIDANCE.gh,
      });
      continue;
    }

    // Auto-provisionable tools
    if (dep.tool === "pnpm" && !dep.present) {
      provisions.push({
        tool: "pnpm",
        action: dep.provisionMethod === "corepack"
          ? "corepack enable && corepack prepare pnpm --activate"
          : "npm exec -y pnpm@9.15.9",
        method: dep.provisionMethod ?? "npm-exec",
      });
    }

    if (dep.tool === "bun" && !dep.present) {
      provisions.push({
        tool: "bun",
        action: "curl -fsSL https://bun.sh/install | bash",
        method: "curl",
        targetPath: "~/.bun/bin/bun",
      });
    }
  }

  return { blockers, provisions };
}

// ── provisionPnpm ──

/**
 * Provision pnpm via corepack (preferred) or npm exec (fallback).
 */
export async function provisionPnpm(
  exec: ExecFn,
): Promise<ProvisionResult> {
  // Try corepack first
  const hasCorepack = await exec("which corepack");
  if (hasCorepack.ok) {
    const enable = await exec("corepack enable");
    if (enable.ok) {
      const prepare = await exec("corepack prepare pnpm --activate");
      if (prepare.ok) {
        // Verify
        const verify = await exec("pnpm --version");
        if (verify.ok) {
          return { ok: true, method: "corepack", path: "pnpm" };
        }
      }
    }
    // corepack failed (probably needs sudo) — fall through to npm exec
  }

  // Fallback: npm exec
  return { ok: true, method: "npm-exec", path: "npx pnpm@9.15.9" };
}

// ── isBlocked ──

/**
 * Check if any hard prerequisites are missing, blocking the rebuild.
 * A missing soft dependency (gh in main mode) does not block.
 */
export function isBlocked(deps: DependencyCheckResult[]): boolean {
  const hardPrereqs = ["node", "git"];
  for (const dep of deps) {
    if (!dep.required) continue;
    // Hard prerequisites that cannot be provisioned
    if (hardPrereqs.includes(dep.tool) && (!dep.present || dep.sufficient === false)) {
      return true;
    }
  }
  return false;
}
