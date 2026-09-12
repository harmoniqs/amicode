import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ──

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rebuild-main-test-"));
}

function writeLock(root: string, lock: unknown): void {
  writeFileSync(join(root, "opencode.lock.json"), JSON.stringify(lock));
}

const VALID_LOCK = {
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
};

// ── Tests ──

describe("main_source_resolver", () => {
  let cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  // Import the module dynamically so mocks can be set up first
  async function importModule() {
    return import("../src/rebuild/main_source_resolver");
  }

  // ════════════════════════════════════════════════════════════════════════
  // readLockFile
  // ════════════════════════════════════════════════════════════════════════
  describe("readLockFile", () => {
    it("reads a valid lock file and returns its contents", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const lock = readLockFile(root);
      expect(lock.tag).toBe("v1.18.29-amicode.30");
      expect(lock.ref).toBe("ab".repeat(20));
      expect(lock.repo).toBe("harmoniqs/opencode");
      expect(lock.platforms["darwin-arm64"].sha256).toBe("aa".repeat(32));
    });

    it("throws a structured error when lock file is missing", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);

      expect(() => readLockFile(root)).toThrow(/opencode\.lock\.json/);
    });

    it("throws a structured error when lock file has no tag", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, { ...VALID_LOCK, tag: undefined });

      expect(() => readLockFile(root)).toThrow(/tag/);
    });

    it("throws a structured error when lock file has no ref", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, { ...VALID_LOCK, ref: undefined });

      expect(() => readLockFile(root)).toThrow(/ref/);
    });

    it("throws a structured error when lock file has no platform entry for current host", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, { ...VALID_LOCK, platforms: {} });

      expect(() => readLockFile(root)).toThrow(/platform/i);
    });

    it("throws a structured error for malformed JSON", async () => {
      const { readLockFile } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeFileSync(join(root, "opencode.lock.json"), "not json{");

      expect(() => readLockFile(root)).toThrow();
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // resolveMainPlatform
  // ════════════════════════════════════════════════════════════════════════
  describe("resolveMainPlatform", () => {
    it("returns the current platform key when it exists in the lock", async () => {
      const { resolveMainPlatform } = await importModule();
      const key = `${process.platform}-${process.arch}`;
      const lock = { ...VALID_LOCK, platforms: { [key]: { asset: "a.tar.gz", sha256: "dd".repeat(32) } } };
      expect(resolveMainPlatform(lock)).toBe(key);
    });

    it("throws unsupported error for darwin-x64", async () => {
      const { resolveMainPlatform, UnsupportedPlatformError } = await importModule();
      expect(() => resolveMainPlatform(VALID_LOCK, "darwin", "x64")).toThrow(UnsupportedPlatformError);
    });

    it("throws unsupported error for win32", async () => {
      const { resolveMainPlatform, UnsupportedPlatformError } = await importModule();
      expect(() => resolveMainPlatform(VALID_LOCK, "win32", "x64")).toThrow(UnsupportedPlatformError);
    });

    it("WSL resolves to linux-x64 (no special handling)", async () => {
      const { resolveMainPlatform } = await importModule();
      // WSL reports process.platform === "linux", process.arch === "x64"
      expect(resolveMainPlatform(VALID_LOCK, "linux", "x64")).toBe("linux-x64");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // checkDirtyTree
  // ════════════════════════════════════════════════════════════════════════
  describe("checkDirtyTree", () => {
    it("returns clean for a clean tree", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({ ok: true, stdout: "" }));
      expect(result.dirty).toBe(false);
    });

    it("returns dirty with guidance when tree has uncommitted changes", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({
        ok: true,
        stdout: " M packages/extension/src/chat_bridge.ts\n?? newfile.ts",
      }));
      expect(result.dirty).toBe(true);
      expect(result.message).toMatch(/commit or stash/i);
    });

    it("returns dirty on git failure", async () => {
      const { checkDirtyTree } = await importModule();
      const result = await checkDirtyTree("/tmp/fake", async () => ({
        ok: false,
        error: "not a git repo",
      }));
      expect(result.dirty).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // pullMainBranch
  // ════════════════════════════════════════════════════════════════════════
  describe("pullMainBranch", () => {
    it("runs git fetch + checkout main + pull --ff-only and succeeds", async () => {
      const { pullMainBranch } = await importModule();
      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(true);
      expect(commands).toContain("git fetch origin");
      expect(commands).toContain("git checkout main");
      expect(commands).toContain("git pull --ff-only origin main");
    });

    it("uses --ff-only, not --rebase", async () => {
      const { pullMainBranch } = await importModule();
      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };
      await pullMainBranch("/tmp/repo", exec);
      const pullCmd = commands.find((c) => c.includes("git pull"));
      expect(pullCmd).toContain("--ff-only");
      expect(pullCmd).not.toContain("--rebase");
    });

    it("reports failure on non-fast-forward merge", async () => {
      const { pullMainBranch } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("git pull")) {
          return { ok: false, error: "fatal: Not possible to fast-forward, aborting." };
        }
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/fast-forward/i);
    });

    it("reports failure on fetch error", async () => {
      const { pullMainBranch } = await importModule();
      const exec = async (cmd: string) => {
        if (cmd.includes("git fetch")) {
          return { ok: false, error: "fatal: Could not read from remote repository." };
        }
        return { ok: true, stdout: "" };
      };
      const result = await pullMainBranch("/tmp/repo", exec);
      expect(result.ok).toBe(false);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // checkPendingPromotion
  // ════════════════════════════════════════════════════════════════════════
  describe("checkPendingPromotion", () => {
    it("returns pending=true when local/amicode is ahead of lock ref", async () => {
      const { checkPendingPromotion } = await importModule();
      const exec = async (_cmd: string) => {
        return { ok: true, stdout: "ff".repeat(20) + "\trefs/heads/local/amicode\n" };
      };
      const result = await checkPendingPromotion("harmoniqs/opencode", "ab".repeat(20), exec);
      expect(result.pending).toBe(true);
      expect(result.remoteHead).toBe("ff".repeat(20));
    });

    it("returns pending=false when lock ref matches remote HEAD", async () => {
      const { checkPendingPromotion } = await importModule();
      const lockRef = "ab".repeat(20);
      const exec = async (_cmd: string) => {
        return { ok: true, stdout: lockRef + "\trefs/heads/local/amicode\n" };
      };
      const result = await checkPendingPromotion("harmoniqs/opencode", lockRef, exec);
      expect(result.pending).toBe(false);
    });

    it("returns unreachable (non-blocking) on network failure", async () => {
      const { checkPendingPromotion } = await importModule();
      const exec = async () => ({ ok: false, error: "Could not resolve host" });
      const result = await checkPendingPromotion("harmoniqs/opencode", "ab".repeat(20), exec);
      expect(result.pending).toBe(false);
      expect(result.unreachable).toBe(true);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // deletedRelease detection
  // ════════════════════════════════════════════════════════════════════════
  describe("downloadForkBinary error cases", () => {
    it("reports a deleted release tag with an actionable message", async () => {
      const { downloadForkBinary } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      // Use a lock with a bogus repo that won't resolve via gh CLI
      const lockWithBadRepo = {
        ...VALID_LOCK,
        repo: "nonexistent-org-12345/nonexistent-repo-67890",
        tag: "v0.0.0-deleted",
      };
      const extDir = join(root, "packages", "extension");
      mkdirSync(extDir, { recursive: true });
      writeLock(extDir, lockWithBadRepo);
      writeLock(root, lockWithBadRepo);

      const download = async () => {
        throw new Error("HTTP 404: Not Found");
      };

      await expect(
        downloadForkBinary({
          amicodePath: root,
          platform: "linux-x64",
          download,
        }),
      ).rejects.toThrow(/no longer available/i);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // rebuildFromMain orchestration
  // ════════════════════════════════════════════════════════════════════════
  describe("rebuildFromMain", () => {
    it("refuses when tree is dirty", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const exec = async (cmd: string) => {
        if (cmd.includes("git status")) return { ok: true, stdout: " M dirty-file.ts" };
        return { ok: true, stdout: "" };
      };
      const result = await rebuildFromMain({
        amicodePath: root,
        exec,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/commit or stash/i);
    });

    it("refuses on unsupported platform", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const result = await rebuildFromMain({
        amicodePath: root,
        platformOverride: "win32",
        archOverride: "x64",
        exec: async () => ({ ok: true, stdout: "" }),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/WSL|not supported|no.*build/i);
    });

    it("does not checkout, rebase, or mutate any fork clone", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };

      // This will fail somewhere downstream but we check the commands list
      try {
        await rebuildFromMain({ amicodePath: root, exec });
      } catch {
        // expected — we're just checking what commands were attempted
      }

      const forkCommands = commands.filter(
        (c) => c.includes("local/amicode") || c.includes("bun install") || c.includes("bun run"),
      );
      expect(forkCommands).toHaveLength(0);
    });

    it("calls git pull --ff-only (not --rebase) on the amicode repo", async () => {
      const { rebuildFromMain } = await importModule();
      const root = tmpRoot();
      cleanup.push(root);
      writeLock(root, VALID_LOCK);

      const commands: string[] = [];
      const exec = async (cmd: string) => {
        commands.push(cmd);
        return { ok: true, stdout: "" };
      };

      try {
        await rebuildFromMain({ amicodePath: root, exec });
      } catch {
        // expected
      }

      const pullCmds = commands.filter((c) => c.includes("git pull"));
      for (const cmd of pullCmds) {
        expect(cmd).toContain("--ff-only");
        expect(cmd).not.toContain("--rebase");
      }
    });
  });
});
