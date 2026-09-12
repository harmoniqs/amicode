import { describe, it, expect, afterEach, vi } from "vitest";
import type {
  DependencyCheckResult,
  ExecFn,
  ProvisionPlan,
  ProvisionOutcome,
} from "../src/rebuild/dependency_resolver";

// ── Helpers ──

function mkExec(responses: Record<string, { ok: boolean; stdout?: string; error?: string }>): ExecFn {
  return async (cmd: string, _cwd?: string) => {
    for (const [pattern, result] of Object.entries(responses)) {
      if (cmd.includes(pattern)) return { ok: result.ok, stdout: result.stdout ?? "", error: result.error };
    }
    return { ok: false, error: `unhandled command: ${cmd}` };
  };
}

// ── Tests ──

describe("dependency_resolver (#1020)", () => {
  async function importModule() {
    return import("../src/rebuild/dependency_resolver");
  }

  // ════════════════════════════════════════════════════════════════════════
  // checkDependencies
  // ════════════════════════════════════════════════════════════════════════
  describe("checkDependencies", () => {
    it("detects all tools present in main mode", async () => {
      const { checkDependencies } = await importModule();
      const exec = mkExec({
        "node --version": { ok: true, stdout: "v20.11.0" },
        "git --version": { ok: true, stdout: "git version 2.43.0" },
        "pnpm --version": { ok: true, stdout: "9.15.9" },
        "gh --version": { ok: true, stdout: "gh version 2.40.0" },
      });
      const result = await checkDependencies("main", exec);
      expect(result).toBeInstanceOf(Array);
      const node = result.find((d) => d.tool === "node");
      expect(node?.present).toBe(true);
      expect(node?.sufficient).toBe(true);
      const git = result.find((d) => d.tool === "git");
      expect(git?.present).toBe(true);
      const pnpm = result.find((d) => d.tool === "pnpm");
      expect(pnpm?.present).toBe(true);
      const gh = result.find((d) => d.tool === "gh");
      expect(gh?.present).toBe(true);
      expect(gh?.required).toBe(false); // soft in main mode
    });

    it("detects missing node and reports it as blocking", async () => {
      const { checkDependencies } = await importModule();
      const exec = mkExec({
        "node --version": { ok: false, error: "command not found" },
        "git --version": { ok: true, stdout: "git version 2.43.0" },
        "pnpm --version": { ok: true, stdout: "9.15.9" },
        "gh --version": { ok: false, error: "not found" },
      });
      const result = await checkDependencies("main", exec);
      const node = result.find((d) => d.tool === "node");
      expect(node?.present).toBe(false);
      expect(node?.required).toBe(true);
    });

    it("detects node < 20 as insufficient", async () => {
      const { checkDependencies } = await importModule();
      const exec = mkExec({
        "node --version": { ok: true, stdout: "v18.19.0" },
        "git --version": { ok: true, stdout: "git version 2.43.0" },
        "pnpm --version": { ok: true, stdout: "9.15.9" },
        "gh --version": { ok: true, stdout: "gh version 2.40.0" },
      });
      const result = await checkDependencies("main", exec);
      const node = result.find((d) => d.tool === "node");
      expect(node?.present).toBe(true);
      expect(node?.sufficient).toBe(false);
    });

    it("in local mode, gh and bun are required (hard)", async () => {
      const { checkDependencies } = await importModule();
      const exec = mkExec({
        "node --version": { ok: true, stdout: "v22.0.0" },
        "git --version": { ok: true, stdout: "git version 2.43.0" },
        "pnpm --version": { ok: true, stdout: "9.15.9" },
        "gh --version": { ok: true, stdout: "gh version 2.40.0" },
        "bun --version": { ok: true, stdout: "1.1.0" },
      });
      const result = await checkDependencies("local", exec);
      const gh = result.find((d) => d.tool === "gh");
      expect(gh?.required).toBe(true); // hard in local mode
      const bun = result.find((d) => d.tool === "bun");
      expect(bun?.required).toBe(true);
      expect(bun?.present).toBe(true);
    });

    it("missing git is blocking in both modes", async () => {
      const { checkDependencies } = await importModule();
      const exec = mkExec({
        "node --version": { ok: true, stdout: "v20.11.0" },
        "git --version": { ok: false, error: "command not found" },
        "pnpm --version": { ok: true, stdout: "9.15.9" },
        "gh --version": { ok: true, stdout: "gh version 2.40.0" },
      });
      const result = await checkDependencies("main", exec);
      const git = result.find((d) => d.tool === "git");
      expect(git?.present).toBe(false);
      expect(git?.required).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // buildProvisionPlan
  // ════════════════════════════════════════════════════════════════════════
  describe("buildProvisionPlan", () => {
    it("returns empty plan when all tools are present", async () => {
      const { buildProvisionPlan } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: true, sufficient: true, version: "v20.11.0" },
        { tool: "git", required: true, present: true, sufficient: true, version: "2.43.0" },
        { tool: "pnpm", required: true, present: true, sufficient: true, version: "9.15.9" },
      ];
      const plan = buildProvisionPlan(deps);
      expect(plan.provisions).toHaveLength(0);
      expect(plan.blockers).toHaveLength(0);
    });

    it("returns blockers for missing hard prerequisites (node, git)", async () => {
      const { buildProvisionPlan } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: false, sufficient: false },
        { tool: "git", required: true, present: false, sufficient: false },
      ];
      const plan = buildProvisionPlan(deps);
      expect(plan.blockers).toHaveLength(2);
      expect(plan.blockers[0].tool).toBe("node");
      expect(plan.blockers[0].guidance).toMatch(/Node/i);
    });

    it("includes pnpm in provisions when missing", async () => {
      const { buildProvisionPlan } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: true, sufficient: true, version: "v20.11.0" },
        { tool: "git", required: true, present: true, sufficient: true, version: "2.43.0" },
        { tool: "pnpm", required: true, present: false, sufficient: false, provisionMethod: "corepack" },
      ];
      const plan = buildProvisionPlan(deps);
      expect(plan.provisions).toHaveLength(1);
      expect(plan.provisions[0].tool).toBe("pnpm");
    });

    it("includes bun in provisions when missing in local mode", async () => {
      const { buildProvisionPlan } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: true, sufficient: true },
        { tool: "git", required: true, present: true, sufficient: true },
        { tool: "pnpm", required: true, present: true, sufficient: true },
        { tool: "bun", required: true, present: false, sufficient: false, provisionMethod: "curl" },
      ];
      const plan = buildProvisionPlan(deps);
      expect(plan.provisions.find((p) => p.tool === "bun")).toBeDefined();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // provisionTool (pnpm via corepack)
  // ════════════════════════════════════════════════════════════════════════
  describe("provisionPnpm", () => {
    it("provisions via corepack when available and unprivileged", async () => {
      const { provisionPnpm } = await importModule();
      const commands: string[] = [];
      const exec: ExecFn = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes("which corepack")) return { ok: true, stdout: "/usr/local/bin/corepack" };
        if (cmd.includes("corepack enable")) return { ok: true, stdout: "" };
        if (cmd.includes("corepack prepare")) return { ok: true, stdout: "" };
        if (cmd.includes("pnpm --version")) return { ok: true, stdout: "9.15.9" };
        return { ok: true, stdout: "" };
      };
      const result = await provisionPnpm(exec);
      expect(result.ok).toBe(true);
      expect(result.method).toBe("corepack");
      expect(commands.some((c) => c.includes("corepack enable"))).toBe(true);
    });

    it("falls back to npm exec when corepack is absent", async () => {
      const { provisionPnpm } = await importModule();
      const commands: string[] = [];
      const exec: ExecFn = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes("which corepack")) return { ok: false, error: "not found" };
        if (cmd.includes("pnpm --version")) return { ok: true, stdout: "9.15.9" };
        return { ok: true, stdout: "" };
      };
      const result = await provisionPnpm(exec);
      expect(result.ok).toBe(true);
      expect(result.method).toBe("npm-exec");
    });

    it("falls back to npm exec when corepack enable requires sudo", async () => {
      const { provisionPnpm } = await importModule();
      const commands: string[] = [];
      const exec: ExecFn = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes("which corepack")) return { ok: true, stdout: "/usr/local/bin/corepack" };
        if (cmd.includes("corepack enable")) return { ok: false, error: "EACCES: permission denied" };
        if (cmd.includes("pnpm --version")) return { ok: true, stdout: "9.15.9" };
        return { ok: true, stdout: "" };
      };
      const result = await provisionPnpm(exec);
      expect(result.ok).toBe(true);
      expect(result.method).toBe("npm-exec");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // isBlocked
  // ════════════════════════════════════════════════════════════════════════
  describe("isBlocked", () => {
    it("returns true when hard prerequisites are missing", async () => {
      const { isBlocked } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: false, sufficient: false },
      ];
      expect(isBlocked(deps)).toBe(true);
    });

    it("returns false when all required tools are present and sufficient", async () => {
      const { isBlocked } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: true, sufficient: true },
        { tool: "git", required: true, present: true, sufficient: true },
      ];
      expect(isBlocked(deps)).toBe(false);
    });

    it("returns false when only soft dependencies are missing", async () => {
      const { isBlocked } = await importModule();
      const deps: DependencyCheckResult[] = [
        { tool: "node", required: true, present: true, sufficient: true },
        { tool: "git", required: true, present: true, sufficient: true },
        { tool: "gh", required: false, present: false, sufficient: false },
      ];
      expect(isBlocked(deps)).toBe(false);
    });
  });
});
