import { describe, it, expect, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRebuild, deployBuild, type RebuildCoordinatorOpts } from "../src/rebuild/coordinator";
import type { ExecResult } from "../src/rebuild/main_source_resolver";

// ── Helpers ──

type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "coord-test-"));
}

function writeLock(root: string): void {
  writeFileSync(
    join(root, "opencode.lock.json"),
    JSON.stringify({
      version: "1.18.29",
      source: "release",
      ref: "ab".repeat(20),
      repo: "harmoniqs/opencode",
      tag: "v1.18.29-amicode.30",
      platforms: {
        "darwin-arm64": { asset: "opencode-darwin-arm64.zip", sha256: "aa".repeat(32) },
        "linux-arm64": { asset: "opencode-linux-arm64.tar.gz", sha256: "bb".repeat(32) },
        "linux-x64": { asset: "opencode-linux-x64.tar.gz", sha256: "cc".repeat(32) },
      },
    }),
  );
}

/** An exec mock where everything succeeds */
function happyExec(): ExecFn {
  return async (cmd: string) => {
    if (cmd.includes("node --version")) return { ok: true, stdout: "v22.0.0" };
    if (cmd.includes("git --version")) return { ok: true, stdout: "git version 2.43.0" };
    if (cmd.includes("pnpm --version")) return { ok: true, stdout: "9.15.9" };
    if (cmd.includes("gh --version")) return { ok: true, stdout: "gh version 2.40.0" };
    if (cmd.includes("bun --version")) return { ok: true, stdout: "1.1.0" };
    if (cmd.includes("git status --porcelain")) return { ok: true, stdout: "" };
    if (cmd.includes("git fetch")) return { ok: true, stdout: "" };
    if (cmd.includes("git checkout")) return { ok: true, stdout: "" };
    if (cmd.includes("git pull")) return { ok: true, stdout: "" };
    if (cmd.includes("git ls-remote")) return { ok: true, stdout: "ab".repeat(20) + "\trefs/heads/local/amicode\n" };
    if (cmd.includes("cat /proc/version")) return { ok: false, error: "no such file" }; // not WSL
    if (cmd.includes("xattr")) return { ok: true, stdout: "" };
    return { ok: true, stdout: "" };
  };
}

function makeExtDir(root: string): string {
  const extDir = join(root, "harmoniqs.amicode-0.2.0");
  const distDir = join(extDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// old");
  writeFileSync(join(extDir, "package.json"), '{"name":"amicode"}');
  return extDir;
}

function makeBuildDir(root: string): string {
  const buildDir = join(root, "packages", "extension");
  const distDir = join(buildDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "extension.js"), "// new");
  writeFileSync(join(buildDir, "package.json"), '{"name":"amicode","version":"0.2.0"}');
  return buildDir;
}

// ── Tests ──

describe("rebuild coordinator (#1016 integration)", () => {
  let cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  // ════════════════════════════════════════════════════════════════════════
  // Step 1: Host gate (#1023)
  // ════════════════════════════════════════════════════════════════════════
  describe("host gate", () => {
    it("rejects win32 before any other work", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec: happyExec(),
        platform: "win32",
        arch: "x64",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/Windows|WSL/i);
    });

    it("rejects darwin-x64 (Intel Mac)", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec: happyExec(),
        platform: "darwin",
        arch: "x64",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/Apple Silicon|arm64/i);
    });

    it("rejects WSL 1", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const exec: ExecFn = async (cmd) => {
        if (cmd.includes("cat /proc/version")) {
          return { ok: true, stdout: "Linux version 4.4.0-19041-Microsoft" };
        }
        return (happyExec())(cmd);
      };
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec,
        platform: "linux",
        arch: "x64",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/WSL 1/i);
    });

    it("allows WSL 2", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const exec: ExecFn = async (cmd) => {
        if (cmd.includes("cat /proc/version")) {
          return { ok: true, stdout: "Linux version 5.15.90.1-microsoft-standard-WSL2" };
        }
        return (happyExec())(cmd);
      };
      // Will fail downstream (no real git/download) but should pass the host gate
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec,
        platform: "linux",
        arch: "x64",
      });
      // The host gate passed if the error is NOT about the platform
      if (!result.ok) {
        expect(result.error?.message).not.toMatch(/WSL|not supported|Apple/i);
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Step 2: Dependency pre-flight (#1020)
  // ════════════════════════════════════════════════════════════════════════
  describe("dependency pre-flight", () => {
    it("blocks when node is missing", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const exec: ExecFn = async (cmd) => {
        if (cmd.includes("node --version")) return { ok: false, error: "not found" };
        if (cmd.includes("cat /proc/version")) return { ok: false, error: "" };
        return (happyExec())(cmd);
      };
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec,
        platform: "linux",
        arch: "x64",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("DEPS_BLOCKED");
      expect(result.error?.fix?.some((f) => f.includes("Node"))).toBe(true);
    });

    it("blocks when git is missing", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const exec: ExecFn = async (cmd) => {
        if (cmd.includes("git --version")) return { ok: false, error: "not found" };
        if (cmd.includes("cat /proc/version")) return { ok: false, error: "" };
        return (happyExec())(cmd);
      };
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec,
        platform: "linux",
        arch: "x64",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("DEPS_BLOCKED");
    });

    it("does not block when only gh is missing in main mode", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root);
      const exec: ExecFn = async (cmd) => {
        if (cmd.includes("gh --version")) return { ok: false, error: "not found" };
        if (cmd.includes("cat /proc/version")) return { ok: false, error: "" };
        return (happyExec())(cmd);
      };
      const result = await runRebuild({
        mode: "main",
        amicodePath: root,
        extensionPath: join(root, "ext"),
        exec,
        platform: "linux",
        arch: "x64",
      });
      // Should pass the dep check (gh is soft in main mode);
      // will fail downstream on git pull etc. but not on deps
      if (!result.ok) {
        expect(result.error?.code).not.toBe("DEPS_BLOCKED");
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Deployment: atomic swap (#1021)
  // ════════════════════════════════════════════════════════════════════════
  describe("deployBuild", () => {
    it("backs up, stages, swaps, and commits (no settings writes)", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      const buildDir = makeBuildDir(root);

      const result = await deployBuild({
        extensionPath: extDir,
        buildDir,
        exec: happyExec(),
      });
      expect(result.ok).toBe(true);

      // New content should be in the extension dir
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// new");

      // Backup should exist as a sibling
      const parent = join(root);
      const backups = require("fs").readdirSync(parent).filter((f: string) => f.startsWith(".amicode-backup-"));
      expect(backups.length).toBeGreaterThanOrEqual(1);

      // Pending marker should be DELETED (committed)
      const markerPath = join(process.env.HOME ?? "~", ".amico", "rebuild-backups", "pending.json");
      expect(existsSync(markerPath)).toBe(false);
    });

    it("rolls back on bad staging dir", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      // buildDir with no dist → staging will have no dist → swap will fail and roll back
      const emptyBuild = join(root, "empty-build");
      mkdirSync(emptyBuild, { recursive: true });

      const result = await deployBuild({
        extensionPath: extDir,
        buildDir: emptyBuild,
        exec: happyExec(),
      });

      // Should have rolled back — original content preserved
      expect(readFileSync(join(extDir, "dist", "extension.js"), "utf8")).toBe("// old");
    });

    it("never writes to VS Code settings.json", async () => {
      const root = tmpRoot();
      cleanup.push(root);
      const extDir = makeExtDir(root);
      const buildDir = makeBuildDir(root);

      // Track all exec calls — none should touch settings.json
      const cmds: string[] = [];
      const exec: ExecFn = async (cmd) => {
        cmds.push(cmd);
        return { ok: true, stdout: "" };
      };

      await deployBuild({ extensionPath: extDir, buildDir, exec });

      const settingsCmds = cmds.filter((c) =>
        c.includes("settings.json") || c.includes("update") || c.includes("devAssetRoot") || c.includes("opencodeBinary"),
      );
      expect(settingsCmds).toHaveLength(0);
    });
  });
});
